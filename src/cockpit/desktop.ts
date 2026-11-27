import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * How `strand cockpit` opens the Strand desktop app (ADR 0022). The app finds the server itself, through
 * the key file, so nothing here carries the key: the command is the app's executable with no arguments
 * (packaged), or the dev Electron binary with this repo as its app.
 */
export type DesktopApp = { cmd: string; args: string[] };

/** The only spawn options used for the app: no shell, its own process, nothing hidden, no inherited stdio. */
export type DesktopSpawnOptions = { shell: false; detached: true; stdio: 'ignore'; windowsHide: false; env: NodeJS.ProcessEnv };
export type SpawnDesktop = (
  cmd: string,
  args: string[],
  opts: DesktopSpawnOptions,
) => { unref(): void; on(event: 'error', fn: (e: Error) => void): unknown };

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * The executable of a packaged app whose code sits at `appRoot`, or undefined for a source checkout.
 * electron-builder puts the code at `<resources>/app` (asar off): `resources` beside the executable on
 * Windows and Linux, `Contents/Resources` beside `Contents/MacOS` on macOS.
 */
export function packagedExecutable(appRoot: string, platform: NodeJS.Platform): string | undefined {
  const p = pathFor(platform);
  const resources = p.dirname(appRoot);
  if (p.basename(appRoot) !== 'app') return undefined;
  if (platform === 'darwin') return p.basename(resources) === 'Resources' ? p.join(p.dirname(resources), 'MacOS', 'Strand') : undefined;
  if (p.basename(resources) !== 'resources') return undefined;
  return p.join(p.dirname(resources), platform === 'win32' ? 'Strand.exe' : 'strand');
}

/** The dev Electron binary from this repo's devDependency, or undefined when it is not installed. */
export function electronBinary(): string | undefined {
  try {
    const bin: unknown = createRequire(import.meta.url)('electron');
    return typeof bin === 'string' ? bin : undefined;
  } catch {
    return undefined;
  }
}

/** The packaged app first, then the dev Electron with `appRoot` as its app; undefined when neither exists. */
export function findDesktopApp(o: {
  appRoot: string;
  platform: NodeJS.Platform;
  exists: (file: string) => boolean;
  electronBinary?: () => string | undefined;
}): DesktopApp | undefined {
  const packaged = packagedExecutable(o.appRoot, o.platform);
  if (packaged && o.exists(packaged)) return { cmd: packaged, args: [] };
  const bin = (o.electronBinary ?? electronBinary)();
  if (bin && o.exists(bin) && o.exists(pathFor(o.platform).join(o.appRoot, 'package.json'))) return { cmd: bin, args: [o.appRoot] };
  return undefined;
}

/** The app's env: the CLI's, minus the `ELECTRON_*` variables (`ELECTRON_RUN_AS_NODE` would start it as Node). */
export function desktopEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('ELECTRON_')));
}

/** Throw unless the command is absolute and the args are exactly `[]` or `[appRoot]`. */
function assertLaunch(app: DesktopApp, appRoot: string): void {
  const ok =
    (path.isAbsolute(app.cmd) || path.win32.isAbsolute(app.cmd)) &&
    (app.args.length === 0 || (app.args.length === 1 && app.args[0] === appRoot));
  if (!ok) throw new Error('launchDesktop: not the desktop app (an absolute command with no arguments, or the app folder)');
}

const defaultSpawn: SpawnDesktop = (cmd, args, opts) => nodeSpawn(cmd, args, opts);

/** Start the app detached. The args are checked before the spawn; a later spawn error goes to `onError`. */
export function launchDesktop(
  app: DesktopApp,
  o: { appRoot: string; env: NodeJS.ProcessEnv; spawn?: SpawnDesktop; onError?: (e: Error) => void },
): void {
  assertLaunch(app, o.appRoot);
  const child = (o.spawn ?? defaultSpawn)(app.cmd, [...app.args], {
    shell: false,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: desktopEnv(o.env),
  });
  child.on('error', (e) => o.onError?.(e));
  child.unref();
}

/**
 * Throw unless `url` is exactly `http://127.0.0.1:<port>/`, optionally with one `?key=<hex>`: the only
 * links opened in a tab. The message never repeats the URL, which may carry the key.
 */
export function assertCockpitUrl(url: string): void {
  const refuse = () => {
    throw new Error('not a cockpit URL (http://127.0.0.1:<port>/ only)');
  };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return refuse();
  }
  if (u.href !== url) refuse();
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username !== '' || u.password !== '') refuse();
  if (!/^\d+$/.test(u.port) || Number(u.port) === 0) refuse();
  if (u.pathname !== '/' || u.hash !== '') refuse();
  if (url.includes('?')) {
    const keys = [...u.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'key' || !/^[0-9a-f]+$/.test(u.searchParams.get('key') ?? '')) refuse();
  }
}
