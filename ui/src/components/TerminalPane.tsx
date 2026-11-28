import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { terminalSocketUrl } from '../api.ts';
import { Button } from './ui/button.tsx';
import {
  chunkInput,
  clampSize,
  encodeInput,
  encodeResize,
  isLeaveChord,
  openTerminalLink,
  parseServerText,
  pushInput,
  terminalFont,
  terminalTheme,
} from '../lib/terminal.ts';

type Status = { kind: 'connecting' } | { kind: 'live' } | { kind: 'ended'; code?: number } | { kind: 'lost' } | { kind: 'gone' };

const RECONNECT_MS = 500;
const RESIZE_DEBOUNCE_MS = 100;
/** A connection that stayed open this long counts as healthy: the next drop gets a fresh retry. */
const STABLE_MS = 5000;

type Hooks = { status: (s: Status) => void; ended: () => void; leave: () => void; focus: boolean };

/**
 * Build the xterm instance and its socket inside `el`. Returns one function that undoes all of it
 * (terminal, fit addon, observer, timers, socket), so React can call it on unmount or on a new terminal.
 *
 * Reconnect: an unexpected close (not 1000, not 1008) retries once after 500 ms; 1013 (the server dropped a
 * slow socket) retries at once. A second failure in a row ends in "lost". Each connection replays the scrollback,
 * so the screen is reset when a socket opens. Keys typed while connecting are held (64 KB) and sent in order on open.
 */
function attach(el: HTMLElement, tid: string, hooks: Hooks): () => void {
  // The --term-* tokens are set on the host (.termhost), so read them there.
  const css = getComputedStyle(el);
  const token = (name: string) => css.getPropertyValue(name).trim();
  // Links: plain-text URLs (the web-links addon) and OSC 8 hyperlinks (linkHandler) share one http(s)-only rule.
  const openLink = (_e: MouseEvent, uri: string) => {
    openTerminalLink(uri, (url, target, features) => window.open(url, target, features));
  };
  const term = new Terminal({
    fontFamily: terminalFont(token),
    fontSize: 13,
    theme: terminalTheme(token),
    cursorBlink: true,
    scrollback: 5000,
    linkHandler: { activate: openLink, allowNonHttpProtocols: false },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon(openLink));
  term.open(el);
  // Tab and Escape belong to the program, so one chord leaves the terminal. It is not sent to it.
  term.attachCustomKeyEventHandler((e) => {
    if (!isLeaveChord(e)) return true;
    e.preventDefault();
    hooks.leave();
    return false;
  });
  const refit = () => {
    // A collapsed drawer can give the host no size. The fit addon would then propose its minimum (2 x 1) and the
    // terminal would reflow to it and tell the server. Do nothing: the observer fits again when a size comes back.
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      // The pane has no size yet (hidden or detached): the observer fits again when it gets one.
    }
  };
  refit();

  let disposed = false;
  let exited = false;
  let over = false; // the connection is finished for good (ended, gone or lost): nothing is held any more
  let focused = false;
  let failures = 0;
  let socket: WebSocket | undefined;
  let held: string[] = [];
  let retry: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let sent = { cols: 0, rows: 0 };

  const sendSize = (force: boolean) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const size = clampSize(term.cols, term.rows);
    if (!force && size.cols === sent.cols && size.rows === sent.rows) return;
    sent = size;
    socket.send(encodeResize(size.cols, size.rows));
  };

  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return; // hidden: no fit, no frame
      refit();
      sendSize(false);
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(el);

  const input = term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
      for (const part of chunkInput(data)) socket.send(encodeInput(part));
    } else if (!over) {
      held = pushInput(held, data);
    }
  });

  const finish = (s: Status) => {
    over = true;
    held = [];
    hooks.status(s);
  };

  const open = () => {
    const ws = new WebSocket(terminalSocketUrl(tid));
    ws.binaryType = 'arraybuffer';
    socket = ws;
    let openedAt = 0;
    ws.onopen = () => {
      openedAt = Date.now();
      term.reset();
      sent = { cols: 0, rows: 0 };
      hooks.status({ kind: 'live' });
      sendSize(true);
      const queue = held;
      held = [];
      for (const part of queue) ws.send(encodeInput(part));
      // Focus once, when the pane first opens. A reconnect must not pull focus from a field the user is typing in.
      if (hooks.focus && !focused) term.focus();
      focused = true;
    };
    ws.onmessage = (ev) => {
      if (disposed || ws !== socket) return;
      if (typeof ev.data === 'string') {
        const m = parseServerText(ev.data);
        if (m) {
          exited = true;
          finish({ kind: 'ended', code: m.code });
          hooks.ended();
        }
        return;
      }
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
    };
    ws.onclose = (ev) => {
      if (disposed || ws !== socket) return;
      socket = undefined;
      if (exited) return;
      if (ev.code === 1000) return finish({ kind: 'ended' });
      if (ev.code === 1008) return finish({ kind: 'gone' });
      if (openedAt && Date.now() - openedAt >= STABLE_MS) failures = 0;
      failures += 1;
      if (failures >= 2) return finish({ kind: 'lost' });
      hooks.status({ kind: 'connecting' });
      if (ev.code === 1013) open();
      else retry = setTimeout(open, RECONNECT_MS);
    };
  };

  hooks.status({ kind: 'connecting' });
  open();

  return () => {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(resizeTimer);
    observer.disconnect();
    input.dispose();
    const s = socket;
    socket = undefined;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.close();
    }
    fit.dispose();
    term.dispose();
  };
}

type P = { terminalId: string; label: string; focus: boolean; onEnded: () => void; onLeave: () => void };

/** One terminal. Mount it with `key={terminalId}`: a new id gives a new instance and the old one is disposed. */
export function TerminalPane({ terminalId, label, focus, onEnded, onLeave }: P) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const endedRef = useRef(onEnded);
  const leaveRef = useRef(onLeave);
  useEffect(() => {
    endedRef.current = onEnded;
    leaveRef.current = onLeave;
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let undo: (() => void) | undefined;
    // Deferred one tick. main.tsx does not use StrictMode today, so this is harmless; with StrictMode React 19
    // runs an effect, cleans it up and runs it again at once, and this keeps the first run from making a terminal
    // and a socket that are thrown away straight after.
    const timer = setTimeout(() => {
      undo = attach(el, terminalId, { status: setStatus, ended: () => endedRef.current(), leave: () => leaveRef.current(), focus });
    }, 0);
    return () => {
      clearTimeout(timer);
      undo?.();
    };
    // `focus` only matters for the first attach of this terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, attempt]);

  return (
    <div className="mt-1 mb-2.5">
      <div ref={host} className="termhost" role="group" aria-label={label} />
      <div className="mt-1 flex min-h-[22px] items-center gap-2 text-xs" role="status">
        {status.kind === 'connecting' && <span className="text-muted-foreground">Connecting… keys you type now are held and sent when it connects.</span>}
        {status.kind === 'ended' && <span className="text-muted-foreground">{status.code === undefined ? 'Session ended' : `Session ended (code ${status.code})`}</span>}
        {status.kind === 'gone' && <span className="text-amber-700">This terminal is gone.</span>}
        {status.kind === 'lost' && (
          <>
            <span className="text-destructive">Connection lost</span>
            <Button type="button" variant="outline" size="xs" onClick={() => setAttempt((a) => a + 1)}>Reconnect</Button>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Ctrl+Shift+F6 leaves the terminal.</p>
    </div>
  );
}
