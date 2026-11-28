// The window's preload (ADR 0030). Sandboxed, with context isolation: it gives the page one receive-only hook for
// menu commands and nothing else. The page cannot send to the main process. ALLOWED repeats PAGE_COMMANDS in
// electron/menu.ts (a sandboxed preload cannot import it); test/electron-menu.test.ts checks the two agree.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = ['new-bead', 'settings', 'go:brief', 'go:board', 'go:epics', 'go:review', 'go:setup', 'sessions'];

contextBridge.exposeInMainWorld('strandMenu', {
  /** Calls `cb` with each menu command; returns a function that stops listening. */
  onCommand(cb) {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, command) => {
      if (typeof command === 'string' && ALLOWED.includes(command)) cb(command);
    };
    ipcRenderer.on('strand:menu', listener);
    return () => ipcRenderer.removeListener('strand:menu', listener);
  },
});
