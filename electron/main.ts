// The Strand desktop app's main process (ADR 0022). It starts the strand CLI as a child (`cockpit --ipc`),
// which finds the running server through the key file or starts one, and sends back {kind, port, key}
// over the IPC channel. The key is set here as the session cookie, on an in-memory partition, and the window
// loads the server's root with no key in the URL. Electron runs this file with Node's type stripping.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, session } from 'electron';
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
  quitDecision,
  serverCommand,
  serverEnv,
  userDataDir,
  type Ready,
} from './handoff.ts';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Electron's default profile folder would be the strand config folder itself.
app.setPath('userData', userDataDir(app.getPath('appData')));

let win: BrowserWindow | undefined;
let server: ChildProcess | undefined;
/** The server this app started and stops on quit; undefined when it attached to a server it does not own. */
let owned: ChildProcess | undefined;
let ready: Ready | undefined;
let stopping = false;
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
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  const wc = w.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (e: { preventDefault(): void }, url: string) => {
    if (!ready || !navigationAllowed(url, ready.port)) e.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // The page's unload guard fires while a terminal is live. Only an owning app stops sessions by closing.
  wc.on('will-prevent-unload', (e) => {
    const decision = quitDecision({ owned: owned !== undefined, unloadBlocked: true });
    if (decision === 'quit') return e.preventDefault();
    const choice = dialog.showMessageBoxSync(w, {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Strand',
      message: 'A Claude Code session is still running.',
      detail: 'Quitting Strand stops the cockpit server and ends the session. It can be resumed later.',
    });
    if (choice === 0) e.preventDefault();
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
    createWindow();
    startServer();
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

  app.on('will-quit', () => {
    // A child that never became ready, or an attaching one still running, is ended with the app.
    if (server && server !== owned) server.kill();
  });
}
