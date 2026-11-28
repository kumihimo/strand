import { useRef, useState, type Ref } from 'react';
import { cn } from 'cn';
import type { TerminalList } from '../api.ts';
import { sessionRows, type SessionRow } from '../lib/terminal.ts';
import { Button } from './ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.tsx';

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
 * The header's Sessions menu: live cockpit terminals across beads, and a jump to one. Radix gives it the menu
 * keys (arrows, Home, End, type-ahead), Escape and outside click, and puts focus back on the button on close.
 */
export function SessionsMenu({ list, failed, cards, onOpen, buttonRef }: P) {
  const [open, setOpen] = useState(false);
  // A chosen row sends focus to its terminal: the menu must not pull it back to the button as it closes.
  const chosen = useRef(false);

  const { live, ended } = sessionRows(list?.terminals ?? [], cards, Date.now());
  const note =
    list === undefined ? (failed ? 'Terminals are not available.' : 'Loading sessions.')
    : !list.available ? list.reason || 'Terminals are not available.'
    : live.length === 0 ? 'No sessions are open.'
    : undefined;

  const row = (r: SessionRow) => (
    <DropdownMenuItem
      key={r.terminalId}
      className="flex-col items-start gap-0"
      onSelect={() => {
        chosen.current = true;
        onOpen(r.beadId);
      }}
    >
      <span className="font-semibold">{r.beadId}</span>
      {r.title && <span className="max-w-full truncate">{r.title}</span>}
      <span className="text-xs text-muted-foreground">
        {r.mode} · {r.exitCode === undefined ? r.since : `Ended (code ${r.exitCode}) · ${startedAgo(r.since)}`}
      </span>
    </DropdownMenuItem>
  );

  const showRows = (live.length > 0 || ended.length > 0) && list?.available;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        if (o) chosen.current = false;
        setOpen(o);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={buttonRef}
          variant="outline"
          className={cn('sessbtn', live.length > 0 && 'has')}
          aria-label={live.length > 0 ? `Sessions (${live.length})` : 'Sessions'}
        >
          <span className="sesslabel">Sessions</span>
          {live.length > 0 && <span className="sesscount">{` (${live.length})`}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label="Sessions"
        className="max-h-[60vh] w-[360px] max-w-[calc(100vw-28px)]"
        onCloseAutoFocus={(e) => chosen.current && e.preventDefault()}
      >
        {note && <p className="px-2 py-1.5 text-xs text-muted-foreground">{note}</p>}
        {showRows && (
          <>
            {live.map(row)}
            {ended.length > 0 && live.length > 0 && <DropdownMenuSeparator />}
            {ended.map(row)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
