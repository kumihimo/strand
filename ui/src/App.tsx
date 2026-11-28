import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalInfo } from '../../src/cockpit/pty.ts';
import { ApiError, getBoard, getTerminals, type TerminalList } from './api.ts';
import { notifyChanged, useOnChanged } from './changes.ts';
import { NewBead } from './components/NewBead.tsx';
import { Alert, AlertAction, AlertDescription } from './components/ui/alert.tsx';
import { Button } from './components/ui/button.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { boardHref } from './lib/route.ts';
import { acceptResult } from './lib/detail.ts';
import { layoutClasses } from './lib/drawer.ts';
import { liveBeadIds, withTerminal } from './lib/terminal.ts';
import { useDrawers } from './useDrawers.ts';
import { headerCounts } from './lib/views.ts';
import { useUnloadGuard } from './useUnloadGuard.ts';
import { useRoute } from './useRoute.ts';
import { usePoll } from './usePoll.ts';
import { SessionsMenu } from './components/SessionsMenu.tsx';
import { Board, focusTerminalOf } from './views/Board.tsx';
import { BriefView } from './views/Brief.tsx';
import { EpicsView } from './views/Epics.tsx';
import { ReviewView } from './views/Review.tsx';
import { SettingsView } from './views/Settings.tsx';

const TABS = [
  ['brief', 'Brief'],
  ['board', 'Board'],
  ['epics', 'Epics'],
  ['review', 'Review queue'],
  ['settings', 'Settings'],
] as const;

/** Matches the views' poll and the server's 15 s cache TTL. */
const POLL_MS = 15_000;

export function App() {
  // The edit form holds unsaved changes: a route change asks first, and so does closing the window.
  const [editDirty, setEditDirty] = useState(false);
  const route = useRoute(editDirty);
  const [error, setError] = useState<string>();
  const [counts, setCounts] = useState<{ review: number; approve: number }>();
  const [creating, setCreating] = useState(false);
  const newBtn = useRef<HTMLButtonElement>(null);
  const onError = useCallback((e: unknown) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)), []);

  // The banner is dismissible and also clears on navigation.
  useEffect(() => setError(undefined), [route.view, route.beadId, route.epicId]);

  // Header counts (review, awaiting approval): refetched on navigation, on every poll and after any write (create, approve).
  // The terminal list rides the same poll (one timer). It lives here so the close-window warning works on every view.
  const [terminals, setTerminals] = useState<TerminalList>();
  const [terminalsFailed, setTerminalsFailed] = useState(false);
  const sessionsBtn = useRef<HTMLButtonElement>(null);
  // Each list request gets a number. A response is applied only if nothing later was: a later request, or a
  // terminal merged in locally (a request issued before the start would show the bead without its terminal).
  const issued = useRef(0);
  const applied = useRef(0);
  const refreshTerminals = useCallback(() => {
    const seq = ++issued.current;
    getTerminals().then(
      (t) => {
        if (!acceptResult(seq, applied.current)) return;
        applied.current = seq;
        setTerminals(t);
        setTerminalsFailed(false);
      },
      (e) => {
        setTerminalsFailed(true);
        onError(e);
      },
    );
  }, [onError]);
  const terminalStarted = useCallback((t: TerminalInfo) => {
    applied.current = issued.current;
    setTerminals((prev) => withTerminal(prev ?? { available: true, terminals: [] }, t));
  }, []);
  const anyLive = useMemo(() => liveBeadIds(terminals?.terminals ?? []).size > 0, [terminals]);
  useUnloadGuard(anyLive || editDirty);
  const [drawers, toggleDrawer, expandForSession] = useDrawers();
  // Bead titles for the Sessions menu, from the same board fetch as the counts.
  const [cards, setCards] = useState<{ id: string; title: string }[]>([]);
  const stopFocus = useRef<() => void>(undefined);
  useEffect(() => () => stopFocus.current?.(), []);
  // The panel is expanded before focus is sent: a collapsed panel is inert.
  const openSession = useCallback(
    (beadId: string) => {
      expandForSession();
      location.hash = boardHref(beadId);
      stopFocus.current?.();
      stopFocus.current = focusTerminalOf(beadId, () => sessionsBtn.current?.focus());
    },
    [expandForSession],
  );

  const refreshCount = useCallback(() => {
    getBoard().then((b) => {
      setCounts(headerCounts(b.cards));
      setCards(b.cards.map((c) => ({ id: c.id, title: c.title })));
    }, onError);
    refreshTerminals();
  }, [onError, refreshTerminals]);
  useEffect(refreshCount, [route.view, route.beadId, refreshCount]);
  usePoll(refreshCount, POLL_MS);
  useOnChanged(refreshCount);

  // True while the dialog is open; a create that resolves after the dialog closed must not navigate.
  const dialogOpen = useRef(false);
  const open = () => {
    dialogOpen.current = true;
    setCreating(true);
  };
  const close = useCallback(() => {
    dialogOpen.current = false;
    setCreating(false);
    // After the dialog unmounts, so focus lands on a rendered button.
    requestAnimationFrame(() => newBtn.current?.focus());
  }, []);
  const created = useCallback(
    (id: string) => {
      if (!dialogOpen.current) {
        notifyChanged();
        return;
      }
      close();
      location.hash = boardHref(id);
      notifyChanged();
    },
    [close],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <header className="appbar">
        <h1 className="text-[15px] font-semibold whitespace-nowrap">Strand</h1>
        <nav aria-label="Views">
          {TABS.map(([view, label]) => (
            <Button key={view} asChild variant={route.view === view ? 'secondary' : 'ghost'} size="sm" className={route.view === view ? 'font-semibold' : 'text-muted-foreground'}>
              <a href={`#/${view}`} aria-current={route.view === view ? 'page' : undefined}>
                {label}
                {view === 'review' && counts ? ` (${counts.review})` : ''}
                {view === 'board' && counts && counts.approve > 0 ? ` (${counts.approve} to approve)` : ''}
              </a>
            </Button>
          ))}
        </nav>
        <span className="spacer" />
        <SessionsMenu list={terminals} failed={terminalsFailed} cards={cards} onOpen={openSession} buttonRef={sessionsBtn} />
        <Button ref={newBtn} type="button" onClick={open} aria-haspopup="dialog">+ New bead</Button>
      </header>
      {error && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0 px-3.5">
          <AlertDescription className="text-destructive">{error}</AlertDescription>
          <AlertAction className="top-1">
            <Button variant="outline" size="sm" type="button" onClick={() => setError(undefined)}>Dismiss</Button>
          </AlertAction>
        </Alert>
      )}
      <main className={route.view === 'board' ? ['boardview', ...(route.beadId ? layoutClasses(drawers, true) : ['nosel'])].join(' ') : undefined}>
        {route.view === 'brief' && <BriefView onError={onError} />}
        {route.view === 'board' && (
          <Board
            selected={route.beadId}
            onError={onError}
            terminals={terminals}
            onTerminalsChanged={refreshTerminals}
            onTerminalStarted={terminalStarted}
            drawers={drawers}
            onToggleDrawer={toggleDrawer}
            onExpandForSession={expandForSession}
            onEditDirty={setEditDirty}
          />
        )}
        {route.view === 'epics' && <EpicsView selected={route.epicId} onError={onError} />}
        {route.view === 'review' && <ReviewView onError={onError} />}
        {route.view === 'settings' && <SettingsView onError={onError} />}
      </main>
      {creating && <NewBead onClose={close} onCreated={created} />}
    </TooltipProvider>
  );
}
