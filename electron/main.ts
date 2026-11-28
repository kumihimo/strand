// The Strand desktop app's main process (ADR 0022). It starts the strand CLI as a child (`cockpit --ipc`),
// which finds the running server through the key file or starts one, and sends back {kind, port, key}
// over the IPC channel. The key is set here as the session cookie, on an in-memory partition, and the window
// loads the server's root with no key in the URL. Electron runs this file with Node's type stripping.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, Notification, app, dialog, ipcMain, net, session, shell, type MenuItemConstructorOptions } from 'electron';
import {
  READY_TIMEOUT_MS,
  STOP_GRACE_MS,
  STOP_MESSAGE,
  StderrTail,
  cockpitOrigin,
  cookieDetails,
  errorPage,
  navigationAllowed,
  parseReady,
  permissionAllowed,
  serverCommand,
  serverEnv,
  userDataDir,
  windowOpenDecision,
  type Ready,
} from './handoff.ts';
import { electronNoticeDir, licencesNavigation, licencesPage, licencesRequestAllowed, readNotices } from './licences.ts';
import { isPageCommand, linkFor, mainCommandAllowed, menuTemplate, unloadPrompt, type Command, type Item, type PageMessage } from './menu.ts';
import { readyMessage, sha256File, startUpdates, type UpdaterLike, type Updates } from './update.ts';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICON = path.join(APP_ROOT, 'electron', 'icon.png');
const PLATFORM: 'darwin' | 'win32' | 'linux' = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
/**
 * No OS title bar (ADR 0030): the page's header is the title bar. Windows and Linux draw their window buttons over
 * its right end, in the header's colours (the cockpit has one, light, theme); macOS insets its traffic lights.
 * The height matches the header's in ui/src/layout.css.
 */
const TITLE_BAR =
  PLATFORM === 'darwin'
    ? ({ titleBarStyle: 'hiddenInset' } as const)
    : ({ titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#0a0a0a', height: 44 } } as const);

// Electron's default profile folder would be the strand config folder itself.
app.setPath('userData', userDataDir(app.getPath('appData')));

let win: BrowserWindow | undefined;
let server: ChildProcess | undefined;
/** The server this app started and stops on quit; undefined when it attached to a server it does not own. */
let owned: ChildProcess | undefined;
let ready: Ready | undefined;
let stopping = false;
let updates: Updates | undefined;
const tail = new StderrTail(20);

function showError(reason: string): void {
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(errorPage(reason, tail.lines()))}`;
  (win ?? createWindow()).loadURL(page).catch(() => {});
}

function createWindow(): BrowserWindow {
  const ses = session.fromPartition('strand');
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Strand',
    show: true,
    ...TITLE_BAR,
    // macOS takes the icon from the app bundle.
    ...(PLATFORM === 'darwin' ? {} : { icon: ICON }),
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      // Menu messages to the page, and a fixed set of window actions from it (ADR 0030).
      preload: path.join(APP_ROOT, 'electron', 'preload.cjs'),
    },
  });
  const wc = w.webContents;
  // Each load starts a fresh preload: tell it the states its menu bar shows.
  wc.on('dom-ready', () => {
    if (!app.isPackaged) sendToPage('dev-build');
    if (updateReady) sendToPage('update-ready');
  });
  // A terminal link: an http(s) URL opens in the default browser; the window itself never opens another.
  wc.setWindowOpenHandler(({ url }) => {
    const { action, external } = windowOpenDecision(url);
    if (external !== undefined) shell.openExternal(external).catch((e: unknown) => console.error(`strand: could not open a link: ${String(e)}`));
    return { action };
  });
  const guard = (e: { preventDefault(): void }, url: string) => {
    if (!ready || !navigationAllowed(url, ready.port)) e.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // The page's unload guard fires while a terminal is live or an edit is unsaved. 'close' comes before the page's
  // beforeunload, so an unload with no close is a reload, which keeps the server and asks in its own words.
  let closing = false;
  w.on('close', () => {
    closing = true;
  });
  wc.on('will-prevent-unload', (e) => {
    const prompt = unloadPrompt({ closing, owned: owned !== undefined });
    const wasClosing = closing;
    closing = false;
    if (!prompt) return e.preventDefault();
    const choice = dialog.showMessageBoxSync(w, { type: 'warning', buttons: prompt.buttons, defaultId: 1, cancelId: 1, title: 'Strand', message: prompt.message, detail: prompt.detail });
    if (choice === 0) e.preventDefault();
    else if (wasClosing) updates?.cancelRestart();
  });
  w.on('closed', () => {
    if (win === w) win = undefined;
  });
  win = w;
  return w;
}

async function openCockpit(r: Ready): Promise<void> {
  const ses = session.fromPartition('strand');
  await ses.cookies.set(cookieDetails(r.port, r.key));
  const w = win ?? createWindow();
  await w.loadURL(`${cockpitOrigin(r.port)}/`);
}

function startServer(): void {
  const { cmd, args } = serverCommand(APP_ROOT, process.env);
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, { shell: false, env: serverEnv(process.env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  } catch (e) {
    return showError(`Strand could not start Node: ${e instanceof Error ? e.message : String(e)}. Strand needs Node 24 on PATH, or STRAND_NODE set to it.`);
  }
  server = child;
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(d);
    tail.push(d.toString('utf8'));
  });
  const timer = setTimeout(() => {
    if (ready) return;
    child.kill();
    showError(`The cockpit server did not answer within ${READY_TIMEOUT_MS / 1000} s.`);
  }, READY_TIMEOUT_MS);
  child.on('error', (e: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    showError(
      e.code === 'ENOENT'
        ? 'Strand needs Node 24 on PATH. Install Node 24, or set STRAND_NODE to its path.'
        : `Strand could not start Node: ${e.message}`,
    );
  });
  child.once('message', (m) => {
    clearTimeout(timer);
    const r = parseReady(m);
    if (!r) {
      child.kill();
      return showError('The cockpit server sent an unexpected message.');
    }
    ready = r;
    if (r.kind === 'started') owned = child;
    openCockpit(r).catch((e: unknown) => showError(`The window could not open the cockpit: ${e instanceof Error ? e.message : String(e)}`));
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    server = undefined;
    if (!ready) return showError(`The cockpit server stopped before it was ready (${signal ?? `exit code ${code}`}).`);
    if (owned !== child) return; // An attaching child exits once it has sent its message.
    owned = undefined;
    // The server stopped on its own: a clean quit (POST /api/quit, or our stop) ends the app; a crash shows why.
    if (stopping || code === 0) app.quit();
    else showError(`The cockpit server stopped (${signal ?? `exit code ${code}`}).`);
  });
}

// Auto-update (ADR 0025): checks GitHub Releases, verifies the download against the GPG-signed SHA256SUMS, and
// installs only on a quit the user starts. Never in a dev run, and never while STRAND_NO_UPDATE is set.
async function setUpUpdates(): Promise<void> {
  if (!app.isPackaged || process.env.STRAND_NO_UPDATE !== undefined) return;
  try {
    const { default: electronUpdater } = await import('electron-updater');
    const updater = electronUpdater.autoUpdater;
    updates = startUpdates({
      isPackaged: app.isPackaged,
      env: process.env,
      deps: {
        updater: updater as unknown as UpdaterLike,
        publicKey: readFileSync(path.join(APP_ROOT, 'RELEASE-KEY.asc'), 'utf8'),
        fetchBytes: async (url) => {
          const r = await net.fetch(url, { redirect: 'follow' });
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
          return new Uint8Array(await r.arrayBuffer());
        },
        hashFile: sha256File,
        removeFile: (f) => rm(f, { force: true }),
        log: (l) => process.stderr.write(`strand update: ${l}\n`),
        onVerified: offerUpdate,
        clock: {
          setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
          setInterval: (fn, ms) => setInterval(fn, ms).unref(),
        },
      },
    });
  } catch (e) {
    process.stderr.write(`strand update: not started: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

let updateReady = false;

/** A verified update: say so once, and offer Restart to Update in the menu, which quits through the usual guard. */
function offerUpdate(version: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Strand', body: readyMessage(version) }).show();
  if (updateReady) return;
  updateReady = true;
  setMenu();
  sendToPage('update-ready');
}

function sendToPage(m: PageMessage): void {
  win?.webContents.send('strand:menu', m);
}

/** A window action the page's menu bar asked for: only from the cockpit page in our window, only a listed name. */
function onRun(e: Electron.IpcMainEvent, name: unknown): void {
  if (!win || e.sender !== win.webContents || !ready) return;
  if (!navigationAllowed(e.senderFrame?.url ?? '', ready.port)) return;
  if (!mainCommandAllowed(name, { packaged: app.isPackaged })) return;
  runCommand(name);
}

/** What each menu command does. Page commands go to the page through the preload; the rest happen here. */
function runCommand(c: Command): void {
  const wc = win?.webContents;
  if (isPageCommand(c)) return wc?.send('strand:menu', c);
  const link = linkFor(c);
  if (link !== undefined) return void shell.openExternal(link).catch((e: unknown) => console.error(`strand: could not open a link: ${String(e)}`));
  switch (c) {
    case 'back':
      if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      return;
    case 'forward':
      if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      return;
    case 'reload':
      return wc?.reload();
    case 'zoom-in':
      return wc?.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
    case 'zoom-out':
      return wc?.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
    case 'zoom-reset':
      return wc?.setZoomLevel(0);
    case 'fullscreen':
      return win?.setFullScreen(!win.isFullScreen());
    case 'devtools':
      if (!app.isPackaged) wc?.toggleDevTools();
      return;
    case 'about':
      return app.showAboutPanel();
    case 'close':
      return win?.close();
    case 'quit':
      return app.quit();
    case 'restart-to-update':
      if (updates?.restartToUpdate()) app.quit();
      return;
    case 'licences':
      return openLicences();
  }
}

let licencesWin: BrowserWindow | undefined;

const readText = (p: string): string | undefined => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Help > Licences (ADR 0031): a local page built from the notice files the app carries, in a window of its own
 * with JavaScript off, on a session that fetches nothing but that page and Chromium's notices.
 */
function openLicences(): void {
  if (licencesWin) return licencesWin.focus();
  const electronDir = electronNoticeDir({ packaged: app.isPackaged, execPath: process.execPath, appRoot: APP_ROOT });
  const chromiumUrl = pathToFileURL(path.join(electronDir, 'LICENSES.chromium.html')).href;
  const notices = readNotices({
    appRoot: APP_ROOT,
    electronDir,
    manifest: readText(path.join(APP_ROOT, 'vendor', 'manifest.json')) ?? '{}',
    platform: process.platform,
    versions: { strand: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome },
    read: readText,
  });
  const file = path.join(app.getPath('userData'), 'licences.html');
  try {
    writeFileSync(file, licencesPage(notices, { chromiumUrl }));
  } catch (e) {
    return void dialog.showErrorBox('Strand', `The licences page could not be written: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pages = [pathToFileURL(file).href, chromiumUrl];
  const ses = session.fromPartition('strand-licences');
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !licencesRequestAllowed(d.url, pages) }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  const w = new BrowserWindow({
    width: 900,
    height: 800,
    title: 'Strand licences',
    ...(PLATFORM === 'darwin' ? {} : { icon: ICON }),
    webPreferences: { session: ses, javascript: false, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  const wc = w.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    const { external } = licencesNavigation(url, '');
    if (external !== undefined) shell.openExternal(external).catch((e: unknown) => console.error(`strand: could not open a link: ${String(e)}`));
    return { action: 'deny' };
  });
  const guard = (e: { preventDefault(): void }, url: string) => {
    const { allow, external } = licencesNavigation(url, chromiumUrl);
    if (allow) return;
    e.preventDefault();
    if (external !== undefined) shell.openExternal(external).catch((err: unknown) => console.error(`strand: could not open a link: ${String(err)}`));
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  w.on('closed', () => {
    if (licencesWin === w) licencesWin = undefined;
  });
  licencesWin = w;
  w.loadFile(file).catch((e: unknown) => console.error(`strand: could not open the licences page: ${String(e)}`));
}

function toElectron(items: Item[]): MenuItemConstructorOptions[] {
  return items.map(({ command, submenu, ...rest }) => ({
    ...(rest as MenuItemConstructorOptions),
    ...(command !== undefined ? { click: () => runCommand(command) } : {}),
    ...(submenu ? { submenu: toElectron(submenu) } : {}),
  }));
}

/** The OS menu bar on macOS. Windows and Linux have none: the page draws it (ADR 0030). */
function setMenu(): void {
  if (PLATFORM !== 'darwin') return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate(toElectron(menuTemplate({ packaged: app.isPackaged, updateReady }))));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) {
      if (ready) void openCockpit(ready);
      else createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    const ses = session.fromPartition('strand');
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permissionAllowed(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
    app.setAboutPanelOptions({
      applicationName: 'Strand',
      applicationVersion: app.getVersion(),
      copyright: '© The Strand Authors',
      ...(PLATFORM === 'darwin' ? {} : { iconPath: ICON }),
    });
    setMenu();
    ipcMain.on('strand:run', onRun);
    createWindow();
    startServer();
    void setUpUpdates();
  });

  app.on('activate', () => {
    if (!win && ready) void openCockpit(ready);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // An owned server is stopped first, as on SIGTERM, and killed if it has not exited after the grace period.
  app.on('before-quit', (e) => {
    const child = owned;
    if (!child || child.exitCode !== null) return;
    e.preventDefault();
    if (stopping) return;
    stopping = true;
    try {
      child.send(STOP_MESSAGE);
    } catch {
      child.kill();
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, STOP_GRACE_MS).unref();
  });

  // The last event of a quit that went ahead: the user's quit, never one of ours. A verified update installs here.
  app.on('quit', (_e, exitCode) => updates?.onQuit(exitCode));

  app.on('will-quit', () => {
    // A child that never became ready, or an attaching one still running, is ended with the app.
    if (server && server !== owned) server.kill();
  });
}
