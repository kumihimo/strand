// The window's preload (ADR 0030). Sandboxed, with context isolation. It gives the page two things only:
// onCommand, which receives fixed names from main (ALLOWED), and run, which asks main for one of a fixed set of
// window actions (RUN). Main checks every run name again. The lists repeat PAGE_MESSAGES and MAIN_COMMANDS in
// electron/menu.ts (a sandboxed preload cannot import it); test/electron-menu.test.ts checks they agree.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = ['new-bead', 'settings', 'go:brief', 'go:board', 'go:epics', 'go:review', 'sessions', 'update-ready', 'dev-build'];
const RUN = ['zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'devtools', 'about', 'close', 'quit', 'restart-to-update', 'licences'];
/** States, not commands: kept, and replayed to a listener that subscribes after main sent them. */
const STICKY = ['update-ready', 'dev-build'];

const seen = new Set();
const listeners = new Set();
ipcRenderer.on('strand:menu', (_event, name) => {
  if (typeof name !== 'string' || !ALLOWED.includes(name)) return;
  if (STICKY.includes(name)) seen.add(name);
  for (const cb of listeners) cb(name);
});

contextBridge.exposeInMainWorld('strandMenu', {
  /** Calls `cb` with each message from main, after any state already received; returns a function that stops it. */
  onCommand(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    for (const name of seen) cb(name);
    return () => listeners.delete(cb);
  },
  /** Asks main to run one window action from RUN. Anything else is dropped here and again in main. */
  run(name) {
    if (typeof name === 'string' && RUN.includes(name)) ipcRenderer.send('strand:run', name);
  },
});
