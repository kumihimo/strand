import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Epic } from '../../../src/cockpit/model.ts';
import { addToQueue, getEpics, getQueue } from '../api.ts';
import { Pill, PriorityPill, StatusPill } from '../components/Pill.tsx';
import { notifyChanged, useOnChanged } from '../changes.ts';
import { canSelectChild, selectionNumber, toggleSelection } from '../lib/queue.ts';
import { stageLabel } from '../lib/format.ts';
import { boardHref, epicHref } from '../lib/route.ts';
import { epicSegments, selectedEpic } from '../lib/views.ts';
import { ViewControls } from '../components/ViewControls.tsx';
import { applyEpics, isFiltering, optionsFrom, pruneView } from '../lib/filter.ts';
import { useStoredView } from '../useStoredView.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';

const POLL_MS = 15_000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Progress({ epic }: { epic: Epic }) {
  const segs = epicSegments(epic);
  const text = segs.length ? segs.map((s) => `${s.n} ${s.label}`).join(', ') : 'no children';
  return (
    <div className="bar2" role="img" aria-label={`Progress: ${text}`} title={text}>
      {segs.map((s) => (
        <i key={s.key} className={`seg-${s.key}`} style={{ width: `${s.pct}%` }} />
      ))}
    </div>
  );
}

function Summary({ epic }: { epic: Epic }) {
  const c = epic.counts;
  const other = epicSegments(epic).find((s) => s.key === 'other')?.n ?? 0;
  return (
    <div className="mu small">
      {c.closed}/{epic.children.length} closed · {c.inProgress} in progress · <span className="ok">{c.ready} ready</span> ·{' '}
      <span className="ko">{c.blocked} blocked</span>
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
      <h2>Epics</h2>
      <p className="lead">
        Each epic is a bead of type <span className="mono">epic</span>; its children carry the work. Order comes from{' '}
        <span className="mono">blocks</span> edges, so <span className="mono">bd ready</span> always shows the next safe step.
      </p>
      {!data && <p className="none">Loading…</p>}
      {data && data.length === 0 && <p className="none">No open epics. Create one with + New bead, type epic.</p>}
      {data && data.length > 0 && (
        <ViewControls view={view} options={options} onChange={setView} onClear={clearView} showHideEmpty />
      )}
      {shown && data && data.length > 0 && shown.length === 0 && <p className="none">No epics have children that match the filters.</p>}
      {shown && epic && (
        <div className="epics">
          <nav className="elist" aria-label="Epic list">
            {filtering && <p className="none small">Counts are for the whole epic.</p>}
            {shown.map((e) => (
              <a key={e.id} className={`ecard${e.id === epic.id ? ' on' : ''}`} href={epicHref(e.id)} aria-current={e.id === epic.id ? 'true' : undefined}>
                <div className="mono mu small">
                  {e.id} · <PriorityPill priority={e.priority} />
                </div>
                <b>{e.title}</b>
                <Progress epic={whole.get(e.id) ?? e} />
                <Summary epic={whole.get(e.id) ?? e} />
              </a>
            ))}
          </nav>
          <div className="edetail">
            <div className="meta">
              <Pill className="mono ep">{epic.id}</Pill>
              <PriorityPill priority={epic.priority} />
            </div>
            <h3>{epic.title}</h3>
            <Progress epic={whole.get(epic.id) ?? epic} />
            <div className="legend">
              <span><i className="seg-closed" />closed</span>
              <span><i className="seg-inProgress" />in progress</span>
              <span><i className="seg-ready" />ready</span>
              <span><i className="seg-blocked" />blocked</span>
              <span><i className="seg-other" />other</span>
            </div>
            {filtering && (
              <p className="none small">
                Counts and progress are for the whole epic.
                {totalOf(epic) > epic.children.length && <> Showing {epic.children.length} of {totalOf(epic)} children.</>}
              </p>
            )}
            {epic.children.length === 0 && totalOf(epic) > 0 ? (
              <p className="none">{filtering ? 'No children match the filters.' : 'All children are closed.'}</p>
            ) : epic.children.length === 0 ? (
              <p className="none">No children yet. Create one with + New bead and pick this epic as the parent.</p>
            ) : (
              <>
              <div className="qactions">
                <button type="button" className="btn" disabled={busy || sel.length === 0 || queueState?.available === false} onClick={queueSelected}>
                  Queue selected ({sel.length})
                </button>
                {queueState?.available === false ? (
                  <span className="mu small">{queueState.reason}</span>
                ) : (
                  <span className="mu small">Tick Backlog children in the order they should start.</span>
                )}
              </div>
              {msg && (
                <p className={`small ${msg.kind === 'alert' ? 'ko' : 'ok'}`} role={msg.kind === 'alert' ? 'alert' : 'status'}>
                  {msg.text}
                </p>
              )}
              <table>
                <thead>
                  <tr><th>Queue</th><th>Child</th><th>Prio</th><th>Title</th><th>Type</th><th>Status</th><th>Stage</th><th>Blocked by</th></tr>
                </thead>
                <tbody>
                  {epic.children.map((c) => (
                    <tr key={c.id}>
                      <td className="nowrap">
                        {pickable.has(c.id) ? (
                          <label className="qpick">
                            <input
                              type="checkbox"
                              aria-label={`Queue ${c.id}`}
                              checked={sel.includes(c.id)}
                              disabled={busy}
                              onChange={() => setPicked((p) => toggleSelection(p.filter((id) => pickable.has(id)), c.id))}
                            />
                            {selectionNumber(sel, c.id) ?? ''}
                          </label>
                        ) : queued.has(c.id) && c.stage === 'backlog' ? (
                          <span className="qpick" title="Place in the queue">queued #{queue.indexOf(c.id) + 1}</span>
                        ) : null}
                      </td>
                      <td><a className="rlink" href={boardHref(c.id)}>{c.id}</a></td>
                      <td><PriorityPill priority={c.priority} /></td>
                      <td>{c.title}</td>
                      <td><Pill>{c.type}</Pill></td>
                      <td><StatusPill card={c} /></td>
                      <td className="nowrap">{stageLabel(c.stage)}</td>
                      <td>
                        <span className="relgroup">
                          {c.blockedBy.length ? c.blockedBy.map((x) => <a key={x} className="rlink" href={boardHref(x)}>{x}</a>) : <span className="none">—</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
