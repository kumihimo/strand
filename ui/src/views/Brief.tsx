import { useMemo } from 'react';
import { getBoard, getBrief } from '../api.ts';
import { PriorityPill } from '../components/Pill.tsx';
import { useOnChanged } from '../changes.ts';
import { boardHref } from '../lib/route.ts';
import { greeting, waitingOnYou, wipBanners, wipBars, type WaitingItem } from '../lib/views.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';

const POLL_MS = 15_000;

const loadBrief = () => Promise.all([getBrief(), getBoard()]).then(([brief, board]) => ({ brief, board }));

function Item({ item }: { item: WaitingItem }) {
  return (
    <a className="bitem" href={boardHref(item.id)}>
      <span className="mono mu bid">{item.id}</span>
      <span className="bt">{item.title}</span>
      {item.priority !== undefined && <PriorityPill priority={item.priority} />}
    </a>
  );
}

function Group({ label, items }: { label: string; items: WaitingItem[] }) {
  return (
    <>
      <div className="bgroup">{label}</div>
      {items.length ? items.map((i) => <Item key={i.id} item={i} />) : <div className="none">None.</div>}
    </>
  );
}

export function BriefView({ onError }: { onError: (e: unknown) => void }) {
  const { data, reload } = useApi(loadBrief, 'brief', onError);
  usePoll(reload, POLL_MS);
  useOnChanged(reload);
  const cards = data?.board.cards;
  const byId = useMemo(() => new Map((cards ?? []).map((c) => [c.id, c])), [cards]);

  if (!data) {
    return (
      <section aria-busy="true">
        <h2>Brief</h2>
        <p className="lead">Loading…</p>
      </section>
    );
  }
  const { brief } = data;
  const waiting = waitingOnYou(brief, data.board.cards);
  const { mode } = data.board.wip;
  const banners = wipBanners(brief.wip, mode);

  return (
    <section aria-label="Brief">
      <h2>{greeting(new Date())}</h2>
      <p className="lead">Stand-up for one: what waits on you, what is ready, what is stuck.</p>
      {banners.map((b) => (
        <div key={b} className="bcard warnbanner" role="status">
          <b className="wa">{b}.</b>
        </div>
      ))}
      <div className="cards">
        <div className="bcard">
          <h3>Waiting on you <span>{waiting.total}</span></h3>
          <Group label="Approve spec" items={waiting.approve} />
          <Group label="Review" items={waiting.review} />
        </div>

        <div className="bcard">
          <h3>Ready <span>{brief.ready.length}</span></h3>
          {brief.ready.length ? brief.ready.map((r) => <Item key={r.id} item={r} />) : <span className="none">Nothing ready.</span>}
          <div className="bfoot">from <span className="mono">bd ready</span></div>
        </div>

        <div className="bcard">
          <h3>Blocked <span>{brief.blocked.length}</span></h3>
          {brief.blocked.length === 0 && <span className="none">Nothing blocked.</span>}
          {brief.blocked.map((b) => (
            <div key={b.id} className="bitem">
              <a className="mono mu bid" href={boardHref(b.id)}>{b.id}</a>
              <a className="bt" href={boardHref(b.id)}>{b.title}</a>
              <span className="relgroup">
                {b.blockers.length ? (
                  <>
                    <span className="none">by</span>
                    {b.blockers.map((x) => (
                      <a key={x} className="rlink" href={boardHref(x)} title={byId.get(x)?.title}>{x}</a>
                    ))}
                  </>
                ) : (
                  <span className="none">marked blocked</span>
                )}
              </span>
            </div>
          ))}
        </div>

        <div className="bcard">
          <h3>Work in progress</h3>
          {wipBars(brief.wip).map((w) => (
            <div key={w.key}>
              <div className="wiprow">
                <span>{w.label}</span>
                <span className={`mono${w.full ? ' wa' : ''}`}>{w.count}/{w.limit}</span>
              </div>
              <div
                className="wipbar"
                role="meter"
                aria-label={`${w.label} WIP`}
                aria-valuemin={0}
                aria-valuemax={w.limit}
                aria-valuenow={w.count}
                aria-valuetext={`${w.count} of ${w.limit}${w.full ? ', at the limit' : ''}`}
              >
                <i className={w.full ? 'full' : ''} style={{ width: `${w.pct}%` }} />
              </div>
            </div>
          ))}
          <div className="bfoot">
            {mode === 'refuse' ? 'While Review is at its limit, no new Build work starts.' : 'At a limit you get a warning; nothing is refused (wip.mode is warn).'}
          </div>
        </div>

        <div className="bcard">
          <h3>Live sessions <span>{brief.sessions.length}</span></h3>
          {brief.sessions.length === 0 && <span className="none">No live Claude Code sessions.</span>}
          {brief.sessions.map((s) => (
            <a key={s.sessionId} className="bitem" href={boardHref(s.beadId)}>
              <span className="live" aria-label="session live" />
              <span className="mono mu bid">{s.beadId}</span>
              <span className="bt">{byId.get(s.beadId)?.title ?? ''}</span>
              <span className="mu small" title={s.startedAt}>since {formatSince(s.startedAt)}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function formatSince(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
