import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { TerminalInfo } from '../../../src/cockpit/pty.ts';
import { move } from '../../../src/core/queue.ts';
import { ApiError, addToQueue, getBoard, getQueue, releaseBead, removeFromQueue, setQueueOrder, startSession, type TerminalList } from '../api.ts';
import { Card } from '../components/Card.tsx';
import { COLUMNS } from '../lib/detail.ts';
import { SESSION_LEGEND, wipState, type ColumnKey } from '../lib/format.ts';
import { moveBy } from '../lib/queue.ts';
import { boardColumns, optionsFrom, pruneView } from '../lib/filter.ts';
import type { Drawer, Drawers } from '../lib/drawer.ts';
import { boardHref } from '../lib/route.ts';
import { BEAD_DRAG_TYPE, dropVerdict, hasBeadDrag } from '../lib/views.ts';
import { ViewControls } from '../components/ViewControls.tsx';
import { useStoredView } from '../useStoredView.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';
import { notifyChanged, useOnChanged } from '../changes.ts';
import { liveBeadIds } from '../lib/terminal.ts';
import { BeadDetail } from './BeadDetail.tsx';

/** Matches the server's 15 s cache TTL. */
const POLL_MS = 15_000;
/** How long the reason stays on a column after a refused drop. */
const REFUSED_MS = 4_000;
/** How long a server refusal stays on a column. */
const ALERT_MS = 8_000;

type P = {
  selected?: string;
  onError: (e: unknown) => void;
  /** The terminal list. App fetches it with its own poll, so the unload guard works on every view. */
  terminals: TerminalList | undefined;
  onTerminalsChanged: () => void;
  onTerminalStarted: (t: TerminalInfo) => void;
  drawers: Drawers;
  onToggleDrawer: (which: Drawer) => void;
  /** A session started: open the panel so the terminal can be seen. */
  onExpandForSession: () => void;
  /** The edit form holds unsaved changes (or no longer does). */
  onEditDirty: (dirty: boolean) => void;
};

/** A message on a column: `status` is a reason (polite), `alert` is a server refusal. */
type Note = { stage: ColumnKey; kind: 'status' | 'alert'; text: string };

const messageOf = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * Put focus in the bead's terminal once the detail has mounted it (the pane loads lazily, so it is not there yet).
 * Gives up after 3 s, and at once if the user focuses a field or a button meanwhile (a late match must not
 * take focus from something they started to use). Returns the way to stop looking.
 */
export function focusTerminalOf(beadId: string, onGiveUp?: () => void): () => void {
  const selector = `.session [aria-label="Terminal for ${CSS.escape(beadId)}"] textarea`;
  let tries = 0;
  const stop = () => {
    clearInterval(timer);
    document.removeEventListener('focusin', onFocusIn);
  };
  const onFocusIn = (e: FocusEvent) => {
    const t = e.target;
    if (t instanceof Element && t.matches('input, textarea, select, button') && !t.closest('.termhost')) stop();
  };
  const timer = setInterval(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      el.focus();
      return stop();
    }
    if (++tries >= 30) {
      stop();
      onGiveUp?.();
    }
  }, 100);
  document.addEventListener('focusin', onFocusIn);
  return stop;
}

export function Board({ selected, onError, terminals, onTerminalsChanged, onTerminalStarted, drawers, onToggleDrawer, onExpandForSession, onEditDirty }: P) {
  const { data, reload: reloadBoard } = useApi(getBoard, 'board', onError);
  const { data: queueState, reload: reloadQueue } = useApi(getQueue, 'queue', onError);
  const reload = useCallback(() => {
    reloadBoard();
    reloadQueue();
  }, [reloadBoard, reloadQueue]);
  usePoll(reload, POLL_MS);
  useOnChanged(reload);
  const queue = useMemo(() => queueState?.ids ?? [], [queueState]);
  const queued = useMemo(() => new Set(queue), [queue]);
  const live = useMemo(() => liveBeadIds(terminals?.terminals ?? []), [terminals]);
  const [stored, setView, clearView] = useStoredView('cockpit.board.view');
  const options = useMemo(() => optionsFrom(data?.cards ?? []), [data]);
  // A stored value that no longer exists is ignored here and gone from storage on the next change.
  const view = useMemo(() => (data ? pruneView(stored, options) : stored), [data, stored, options]);
  const cols = useMemo(() => new Map(boardColumns(data?.cards ?? [], view, queue).map((c) => [c.stage, c])), [data, view, queue]);
  /** The column a card shows in: Queued for a queued Backlog card, else its stage. */
  const columnOf = useCallback((c: { id: string; stage: ColumnKey }): ColumnKey => (c.stage === 'backlog' && queued.has(c.id) ? 'queued' : c.stage), [queued]);
  const cards = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.id, c])), [data]);

  // Drag state. The refs hold the same values for the handlers that run in the middle of an event.
  const [drag, setDrag] = useState<{ id: string; stage: ColumnKey }>();
  const [over, setOver] = useState<ColumnKey>();
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState(false);
  const dragRef = useRef(drag);
  const overRef = useRef(over);
  const busyRef = useRef(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopFocus = useRef<() => void>(undefined);

  const clearDrag = useCallback(() => {
    dragRef.current = undefined;
    overRef.current = undefined;
    setDrag(undefined);
    setOver(undefined);
  }, []);
  const flash = useCallback((n: Note, ms: number) => {
    clearTimeout(noteTimer.current);
    setNote(n);
    noteTimer.current = setTimeout(() => setNote(undefined), ms);
  }, []);
  useEffect(
    () => () => {
      clearTimeout(noteTimer.current);
      stopFocus.current?.();
    },
    [],
  );
  // A refresh can move the card being dragged to another column: the element is gone and its dragend never comes.
  useEffect(() => {
    const c = drag && cards.get(drag.id);
    if (drag && (!c || columnOf(c) !== drag.stage)) clearDrag();
  }, [cards, drag, clearDrag, columnOf]);

  const dragStart = (id: string, stage: ColumnKey) => (e: DragEvent) => {
    if (busyRef.current) return e.preventDefault();
    e.dataTransfer.setData(BEAD_DRAG_TYPE, id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    clearTimeout(noteTimer.current);
    setNote(undefined);
    dragRef.current = { id, stage };
    // Not in this event: some browsers cancel a drag when the dragged element changes while dragstart runs.
    setTimeout(() => dragRef.current?.id === id && setDrag(dragRef.current), 0);
  };
  /** The drag ended. Over a refused column with no drop (the browser never sends one), say why. */
  const dragEnd = () => {
    const d = dragRef.current;
    const to = overRef.current;
    if (d && to) {
      const card = cards.get(d.id);
      const v = card && dropVerdict(card, to, live.has(d.id), queued.has(d.id));
      if (v && !v.ok && v.reason) flash({ stage: to, kind: 'status', text: v.reason }, REFUSED_MS);
    }
    clearDrag();
  };

  const verdictFor = (stage: ColumnKey) => {
    const d = dragRef.current;
    const card = d && cards.get(d.id);
    return card ? dropVerdict(card, stage, live.has(card.id), queued.has(card.id)) : undefined;
  };
  /** A queued card dragged within Queued: dropping it on another queued card moves it to that place. */
  const reordering = (stage: ColumnKey) => stage === 'queued' && !!dragRef.current && queued.has(dragRef.current.id);

  /** Run one queue edit; the board and the queue are read again whatever the answer. */
  const editQueue = (edit: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    edit()
      .catch((err) => flash({ stage: 'queued', kind: 'alert', text: messageOf(err) }, ALERT_MS))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        notifyChanged();
        reload();
      });
  };
  /** dragenter and dragover: allow the drop only where the verdict is ok, so the browser shows "not allowed" elsewhere. */
  const dragOver = (stage: ColumnKey) => (e: DragEvent) => {
    if (!hasBeadDrag(Array.from(e.dataTransfer.types)) || !dragRef.current) return;
    overRef.current = stage;
    setOver(stage);
    const v = verdictFor(stage);
    if (v?.ok || reordering(stage)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  const dragLeave = (stage: ColumnKey) => (e: DragEvent) => {
    // Moving onto a child of the column is not leaving it.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    if (overRef.current === stage) {
      overRef.current = undefined;
      setOver(undefined);
    }
  };
  const drop = (stage: ColumnKey) => (e: DragEvent) => {
    if (!hasBeadDrag(Array.from(e.dataTransfer.types))) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(BEAD_DRAG_TYPE);
    const wasReorder = reordering(stage);
    clearDrag();
    const card = cards.get(id);
    if (!card || busyRef.current) return;
    if (wasReorder) {
      const onto = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-bead-id]')?.dataset.beadId : undefined;
      const to = onto === undefined ? queue.length - 1 : queue.indexOf(onto);
      if (onto !== id && to >= 0) editQueue(() => setQueueOrder(move(queue, id, to)));
      return;
    }
    const v = dropVerdict(card, stage, live.has(id), queued.has(id));
    if (!v.ok) return;
    if (v.action === 'enqueue') return editQueue(() => addToQueue([id]));
    if (v.action === 'dequeue') return editQueue(() => removeFromQueue(id));
    busyRef.current = true;
    setBusy(true);
    const done = () => {
      busyRef.current = false;
      setBusy(false);
    };
    if (v.action === 'specify') {
      // The claim is made by `strand work` inside the terminal. The board never claims the bead itself.
      startSession(id, { mode: 'specify' })
        .then(
          ({ terminal }) => {
            onTerminalStarted(terminal);
            onExpandForSession();
            onTerminalsChanged();
            location.hash = boardHref(id);
            notifyChanged();
            stopFocus.current?.();
            stopFocus.current = focusTerminalOf(id);
          },
          (err) => flash({ stage: 'specify', kind: 'alert', text: messageOf(err) }, ALERT_MS),
        )
        .finally(done);
    } else {
      releaseBead(id)
        .then(
          // Released, but some session bindings were not cleared: say so rather than fail silently.
          (r) => r.warning && flash({ stage: 'backlog', kind: 'status', text: r.warning }, ALERT_MS),
          (err) => flash({ stage: 'backlog', kind: 'alert', text: messageOf(err) }, ALERT_MS),
        )
        // A stale board (409) needs the refresh as much as a success does.
        .finally(() => {
          notifyChanged();
          reload();
          done();
        });
    }
  };

  const legend = (
    <span className="legend" aria-label="Card light legend">
      {SESSION_LEGEND.map((l) => (
        <span key={l.state}>
          <span className={`light ${l.state}`} aria-hidden="true" />
          {l.text}
        </span>
      ))}
    </span>
  );

  return (
    <>
      <div className="boardpane">
        <ViewControls view={view} options={options} onChange={setView} onClear={clearView} showEpic compact={!!selected} trailing={legend} />
        <section className="board" aria-label="Board" aria-busy={!data}>
          {COLUMNS.map((col) => {
            const { shown: items, total } = cols.get(col.key)!;
            const hidden = items.length !== total;
            const n = col.wip && data ? data.wip[col.wip] : undefined;
            const limit = col.wip && data ? data.wip.limits[col.wip] : undefined;
            const full = n !== undefined && limit !== undefined && wipState(n, limit) === 'full';
            const v = over === col.key ? verdictFor(col.key) : undefined;
            const target = v ? (v.ok ? ' drop-ok' : v.reason ? ' drop-no' : '') : '';
            const reason = (v && !v.ok ? v.reason : '') || (note?.kind === 'status' && note.stage === col.key ? note.text : '');
            const alert = note?.kind === 'alert' && note.stage === col.key ? note.text : '';
            return (
              <div
                key={col.key}
                className={`col${full ? ' atlimit' : ''}${target}`}
                onDragEnter={dragOver(col.key)}
                onDragOver={dragOver(col.key)}
                onDragLeave={dragLeave(col.key)}
                onDrop={drop(col.key)}
              >
                <h3>
                  {col.label}
                  <span className="hc">
                    {hidden && <span title={`${items.length} shown, ${total - items.length} hidden by the filters`}>{items.length} of {total}</span>}
                    {n !== undefined && limit !== undefined ? (
                      <span className={`wip${full ? ' full' : ''}`} title={`WIP ${n} of ${limit}${full ? ', at the limit' : ''}`}>
                        {n}/{limit}
                      </span>
                    ) : (
                      !hidden && <span>{total}</span>
                    )}
                  </span>
                </h3>
                <div className={`sub${col.gate ? ' gate' : ''}`}>
                  {col.key === 'queued' && queueState && !queueState.available ? queueState.reason ?? 'the queue is not available' : col.sub}
                </div>
                <div className="dropmsg wa" role="status">{reason}</div>
                {alert && <div className="dropmsg ko" role="alert">{alert}</div>}
                {items.map((c) => {
                  const card = (
                    <Card
                      key={c.id}
                      card={c}
                      selected={c.id === selected}
                      terminal={live.has(c.id)}
                      dragging={drag?.id === c.id}
                      drag={busy ? undefined : { onDragStart: dragStart(c.id, col.key), onDragEnd: dragEnd }}
                    />
                  );
                  if (col.key !== 'queued') return card;
                  const at = queue.indexOf(c.id);
                  return (
                    <div key={c.id} className="qitem">
                      {card}
                      <div className="qbar" aria-label={`Queue controls for ${c.id}`}>
                        <span className="n" title="Place in the queue">#{at + 1}</span>
                        <button type="button" aria-label={`Move ${c.id} up`} disabled={busy || at <= 0} onClick={() => editQueue(() => setQueueOrder(moveBy(queue, c.id, -1)))}>↑</button>
                        <button type="button" aria-label={`Move ${c.id} down`} disabled={busy || at >= queue.length - 1} onClick={() => editQueue(() => setQueueOrder(moveBy(queue, c.id, 1)))}>↓</button>
                        <button type="button" aria-label={`Remove ${c.id} from the queue`} disabled={busy} onClick={() => editQueue(() => removeFromQueue(c.id))}>Remove</button>
                      </div>
                    </div>
                  );
                })}
                {data && items.length === 0 && <div className="none">{total > 0 ? 'No matches' : 'Empty'}</div>}
              </div>
            );
          })}
        </section>
      </div>
      {selected ? (
        <BeadDetail id={selected} cards={cards} terminals={terminals} onTerminalsChanged={onTerminalsChanged} onTerminalStarted={onTerminalStarted} drawers={drawers} onToggleDrawer={onToggleDrawer} onExpandForSession={onExpandForSession} onEditDirty={onEditDirty} onChanged={notifyChanged} onError={onError} />
      ) : (
        <section className="detail empty">
          <p className="none">{data ? `${data.cards.length} beads — select a card to see its spec, relations and artefacts.` : 'Loading…'}</p>
        </section>
      )}
    </>
  );
}
