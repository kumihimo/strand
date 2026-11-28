import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Epic } from '../../../src/cockpit/model.ts';
import { addToQueue, getEpics, getQueue } from '../api.ts';
import { cn } from 'cn';
import { BeadLink } from '../components/BeadLink.tsx';
import { Pill, PriorityPill, StatusPill } from '../components/Pill.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card } from '../components/ui/card.tsx';
import { notifyChanged, useOnChanged } from '../changes.ts';
import { canSelectChild, selectionNumber, toggleSelection } from '../lib/queue.ts';
import { stageLabel } from '../lib/format.ts';
import { epicHref } from '../lib/route.ts';
import { epicSegments, selectedEpic } from '../lib/views.ts';
import { ViewControls } from '../components/ViewControls.tsx';
import { applyEpics, isFiltering, optionsFrom, pruneView } from '../lib/filter.ts';
import { useStoredView } from '../useStoredView.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';

const POLL_MS = 15_000;

const qpick = 'inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground';

/** Progress segment colours, from the stock palette. */
const SEG: Record<string, string> = {
  closed: 'bg-neutral-400',
  inProgress: 'bg-blue-500',
  ready: 'bg-green-500',
  blocked: 'bg-red-500',
  other: 'bg-neutral-300',
};
const LEGEND: [string, string][] = [
  ['closed', 'closed'],
  ['inProgress', 'in progress'],
  ['ready', 'ready'],
  ['blocked', 'blocked'],
  ['other', 'other'],
];

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Progress({ epic }: { epic: Epic }) {
  const segs = epicSegments(epic);
  const text = segs.length ? segs.map((s) => `${s.n} ${s.label}`).join(', ') : 'no children';
  return (
    <div className="mt-1.5 mb-1 flex h-1.5 overflow-hidden rounded bg-muted" role="img" aria-label={`Progress: ${text}`} title={text}>
      {segs.map((s) => (
        <i key={s.key} className={cn('block h-full', SEG[s.key])} style={{ width: `${s.pct}%` }} />
      ))}
    </div>
  );
}

function Summary({ epic }: { epic: Epic }) {
  const c = epic.counts;
  const other = epicSegments(epic).find((s) => s.key === 'other')?.n ?? 0;
  return (
    <div className="text-muted-foreground text-xs">
      {c.closed}/{epic.children.length} closed · {c.inProgress} in progress · <span className="text-green-700">{c.ready} ready</span> ·{' '}
      <span className="text-destructive">{c.blocked} blocked</span>
      {other > 0 && <> · {other} other</>}
    </div>
  );
}

export function EpicsView({ selected, onError }: { selected?: string; onError: (e: unknown) => void }) {
  const { data, reload: reloadEpics } = useApi(getEpics, 'epics', onError);
  const { data: queueState, reload: reloadQueue } = useApi(getQueue, 'queue', onError);
  const reload = useCallback(() => {
    reloadEpics();
    reloadQueue();
  }, [reloadEpics, reloadQueue]);
  usePoll(reload, POLL_MS);
  useOnChanged(reload);
  const queue = useMemo(() => queueState?.ids ?? [], [queueState]);
  const queued = useMemo(() => new Set(queue), [queue]);
  // The children ticked to queue, in the order they were ticked: that is the order they are queued in.
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'status' | 'alert'; text: string }>();
  const [stored, setView, clearView] = useStoredView('cockpit.epics.view');
  const options = useMemo(() => optionsFrom((data ?? []).flatMap((e) => e.children)), [data]);
  // A stored value that no longer exists is ignored here and gone from storage on the next change.
  const view = useMemo(() => (data ? pruneView(stored, options) : stored), [data, stored, options]);
  const shown = useMemo(() => (data ? applyEpics(data, view) : undefined), [data, view]);
  const whole = useMemo(() => new Map((data ?? []).map((e) => [e.id, e])), [data]);
  const totalOf = (e: Epic) => whole.get(e.id)?.children.length ?? e.children.length;
  const filtering = isFiltering(view);
  const epic = shown && selectedEpic(shown, selected);
  // A tick belongs to one epic: another epic starts with none.
  useEffect(() => setPicked([]), [epic?.id]);
  // A child that can no longer be queued (claimed, queued from the Board) loses its tick.
  const pickable = useMemo(() => new Set((epic?.children ?? []).filter((c) => canSelectChild(c, queued)).map((c) => c.id)), [epic, queued]);
  const sel = picked.filter((id) => pickable.has(id));
  const queueSelected = () => {
    if (busy || sel.length === 0) return;
    setBusy(true);
    setMsg(undefined);
    addToQueue(sel)
      .then(
        () => {
          setPicked([]);
          setMsg({ kind: 'status', text: `Queued ${sel.length} bead${sel.length === 1 ? '' : 's'}. They start by themselves when there is room.` });
        },
        (err) => setMsg({ kind: 'alert', text: messageOf(err) }),
      )
      .finally(() => {
        setBusy(false);
        notifyChanged();
        reload();
      });
  };

  return (
    <section aria-label="Epics" aria-busy={!data}>
      <h2 className="mb-1 text-lg font-semibold">Epics</h2>
      <p className="mb-3.5 text-muted-foreground">
        Each epic is a bead of type <span className="font-mono">epic</span>; its children carry the work. Order comes from{' '}
        <span className="font-mono">blocks</span> edges, so <span className="font-mono">bd ready</span> always shows the next safe step.
      </p>
      {!data && <p className="text-xs text-muted-foreground">Loading…</p>}
      {data && data.length === 0 && <p className="text-xs text-muted-foreground">No open epics. Create one with + New bead, type epic.</p>}
      {data && data.length > 0 && (
        <ViewControls view={view} options={options} onChange={setView} onClear={clearView} showHideEmpty />
      )}
      {shown && data && data.length > 0 && shown.length === 0 && <p className="text-xs text-muted-foreground">No epics have children that match the filters.</p>}
      {shown && epic && (
        <div className="epics">
          <nav className="elist" aria-label="Epic list">
            {filtering && <p className="text-xs text-muted-foreground">Counts are for the whole epic.</p>}
            {shown.map((e) => (
              <a key={e.id} className="mb-2 block rounded-lg text-inherit no-underline focus-visible:outline-2 focus-visible:outline-ring" href={epicHref(e.id)} aria-current={e.id === epic.id ? 'true' : undefined}>
                <Card size="sm" className={cn('gap-0.5 border-l-4 border-l-orange-500 px-3 py-2.5 hover:ring-foreground/25', e.id === epic.id && 'ring-2 ring-orange-500 hover:ring-orange-500')}>
                  <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    {e.id} · <PriorityPill priority={e.priority} />
                  </div>
                  <b>{e.title}</b>
                  <Progress epic={whole.get(e.id) ?? e} />
                  <Summary epic={whole.get(e.id) ?? e} />
                </Card>
              </a>
            ))}
          </nav>
          <Card className="min-w-0 gap-0 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-1">
              <Pill variant="orange" className="font-mono">{epic.id}</Pill>
              <PriorityPill priority={epic.priority} />
            </div>
            <h3 className="mt-1.5 mb-0.5 text-base font-semibold">{epic.title}</h3>
            <Progress epic={whole.get(epic.id) ?? epic} />
            <div className="mb-2.5 flex flex-wrap gap-3.5 text-[11.5px] text-muted-foreground">
              {LEGEND.map(([k, label]) => (
                <span key={k} className="inline-flex items-center gap-1">
                  <i className={cn('inline-block size-2.5 rounded-sm', SEG[k])} />
                  {label}
                </span>
              ))}
            </div>
            {filtering && (
              <p className="text-xs text-muted-foreground">
                Counts and progress are for the whole epic.
                {totalOf(epic) > epic.children.length && <> Showing {epic.children.length} of {totalOf(epic)} children.</>}
              </p>
            )}
            {epic.children.length === 0 && totalOf(epic) > 0 ? (
              <p className="text-xs text-muted-foreground">{filtering ? 'No children match the filters.' : 'All children are closed.'}</p>
            ) : epic.children.length === 0 ? (
              <p className="text-xs text-muted-foreground">No children yet. Create one with + New bead and pick this epic as the parent.</p>
            ) : (
              <>
              <div className="my-2 flex items-center gap-2.5">
                <Button type="button" disabled={busy || sel.length === 0 || queueState?.available === false} onClick={queueSelected}>
                  Queue selected ({sel.length})
                </Button>
                {queueState?.available === false ? (
                  <span className="text-muted-foreground text-xs">{queueState.reason}</span>
                ) : (
                  <span className="text-muted-foreground text-xs">Tick Backlog children in the order they should start.</span>
                )}
              </div>
              {msg && (
                <p className={cn('text-xs', msg.kind === 'alert' ? 'text-destructive' : 'text-green-700')} role={msg.kind === 'alert' ? 'alert' : 'status'}>
                  {msg.text}
                </p>
              )}
              <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:px-1.5 [&_td]:py-1 [&_td]:text-left [&_td]:align-top [&_th]:border-b [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground">
                <thead>
                  <tr><th>Queue</th><th>Child</th><th>Prio</th><th>Title</th><th>Type</th><th>Status</th><th>Stage</th><th>Blocked by</th></tr>
                </thead>
                <tbody>
                  {epic.children.map((c) => (
                    <tr key={c.id}>
                      <td className="whitespace-nowrap">
                        {pickable.has(c.id) ? (
                          <label className={qpick}>
                            <input
                              className="accent-primary"
                              type="checkbox"
                              aria-label={`Queue ${c.id}`}
                              checked={sel.includes(c.id)}
                              disabled={busy}
                              onChange={() => setPicked((p) => toggleSelection(p.filter((id) => pickable.has(id)), c.id))}
                            />
                            {selectionNumber(sel, c.id) ?? ''}
                          </label>
                        ) : queued.has(c.id) && c.stage === 'backlog' ? (
                          <span className={qpick} title="Place in the queue">queued #{queue.indexOf(c.id) + 1}</span>
                        ) : null}
                      </td>
                      <td><BeadLink id={c.id} /></td>
                      <td><PriorityPill priority={c.priority} /></td>
                      <td>{c.title}</td>
                      <td><Pill>{c.type}</Pill></td>
                      <td><StatusPill card={c} /></td>
                      <td className="whitespace-nowrap">{stageLabel(c.stage)}</td>
                      <td>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          {c.blockedBy.length ? c.blockedBy.map((x) => <BeadLink key={x} id={x} />) : <span className="text-xs text-muted-foreground">—</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}
