import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { TerminalList } from '../api.ts';
import { sessionRows, type SessionRow } from '../lib/terminal.ts';

type P = {
  /** Undefined until the first load, and after a failed fetch with nothing loaded. */
  list: TerminalList | undefined;
  /** The last fetch failed. */
  failed: boolean;
  cards: { id: string; title: string }[];
  /** Open the Board with this bead selected, expand the panel and focus its terminal. */
  onOpen: (beadId: string) => void;
  /** So the caller can return focus to the button. */
  buttonRef?: Ref<HTMLButtonElement>;
};

/** "started 5 min ago" or "started just now": an ended row's age is since the start, not since the exit. */
const startedAgo = (since: string) => (since === 'just now' ? 'started just now' : `started ${since} ago`);

/**
 * The header's Sessions menu: live cockpit terminals across beads, and a jump to one.
 * It has its own outside-click and Escape handling: ViewControls' is tied to its filter groups.
 */
export function SessionsMenu({ list, failed, cards, onOpen, buttonRef }: P) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const { live, ended } = sessionRows(list?.terminals ?? [], cards, Date.now());
  const note =
    list === undefined ? (failed ? 'Terminals are not available.' : 'Loading sessions.')
    : !list.available ? list.reason || 'Terminals are not available.'
    : live.length === 0 ? 'No sessions are open.'
    : undefined;

  const setBtn = (el: HTMLButtonElement | null) => {
    btn.current = el;
    if (typeof buttonRef === 'function') buttonRef(el);
    else if (buttonRef) (buttonRef as { current: HTMLButtonElement | null }).current = el;
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Opening puts focus on the first row, when there is one.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const rows = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onKeyDown = (e: KeyboardEvent) => {
    // With the menu closed, Escape is not ours: the terminal and forms need it.
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      // Focus the button first: the row is about to unmount, and Tab then moves on from the button.
      btn.current?.focus();
      return void setOpen(false);
    }
    const items = rows();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === 'ArrowDown' ? items[(at + 1) % items.length]
      : e.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length]
      : e.key === 'Home' ? items[0]
      : e.key === 'End' ? items[items.length - 1]
      : undefined;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  };

  const choose = (beadId: string) => {
    setOpen(false);
    onOpen(beadId);
  };

  const rowButton = (r: SessionRow) => (
    <button key={r.terminalId} type="button" role="menuitem" className="smrow" tabIndex={-1} onClick={() => choose(r.beadId)}>
      <span className="smid">{r.beadId}</span>
      {r.title && <span className="smtitle">{r.title}</span>}
      <span className="mu small">
        {r.mode} · {r.exitCode === undefined ? r.since : `Ended (code ${r.exitCode}) · ${startedAgo(r.since)}`}
      </span>
    </button>
  );

  const hasRows = live.length > 0 || ended.length > 0;
  const showRows = hasRows && list?.available;

  return (
    <div ref={root} className="sessmenu" onKeyDown={onKeyDown}>
      <button
        ref={setBtn}
        type="button"
        className={`btn ghost sessbtn${live.length > 0 ? ' has' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        aria-label={live.length > 0 ? `Sessions (${live.length})` : 'Sessions'}
        onClick={() => setOpen(!open)}
      >
        <span className="sesslabel">Sessions</span>
        {live.length > 0 && <span className="sesscount">{` (${live.length})`}</span>}
      </button>
      {open && (
        <div className="smpanel" id={`${id}-panel`}>
          {note && <p className="mu small smnote">{note}</p>}
          {showRows && (
            <div ref={menu} role="menu" aria-label="Sessions" className="smmenu">
              {live.map(rowButton)}
              {ended.length > 0 && (
                <>
                  {live.length > 0 && <hr className="smsep" />}
                  {ended.map(rowButton)}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
