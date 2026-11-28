import { useMemo, type ReactNode } from 'react';
import { cn } from 'cn';
import { getBoard, getBrief } from '../api.ts';
import { BeadLink } from '../components/BeadLink.tsx';
import { PriorityPill } from '../components/Pill.tsx';
import { SessionLight } from '../components/SessionLight.tsx';
import { Alert, AlertTitle } from '../components/ui/alert.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx';
import { useOnChanged } from '../changes.ts';
import { boardHref } from '../lib/route.ts';
import { greeting, waitingOnYou, wipBanners, wipBars, type WaitingItem } from '../lib/views.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';

const POLL_MS = 15_000;

const loadBrief = () => Promise.all([getBrief(), getBoard()]).then(([brief, board]) => ({ brief, board }));

const row = 'flex flex-wrap items-center gap-2 border-b py-1.5 text-[13px] text-inherit no-underline last:border-b-0';
const idCol = 'min-w-[70px] font-mono text-[11.5px] text-muted-foreground';
const titleCol = 'min-w-[120px] flex-1 text-inherit no-underline hover:text-primary hover:underline';
const none = 'text-xs text-muted-foreground';
const foot = 'mt-1.5 text-[11.5px] text-muted-foreground';

function Item({ item }: { item: WaitingItem }) {
  return (
    <a className={cn(row, 'group')} href={boardHref(item.id)}>
      <span className={idCol}>{item.id}</span>
      <span className="min-w-[120px] flex-1 group-hover:underline">{item.title}</span>
      {item.priority !== undefined && <PriorityPill priority={item.priority} />}
    </a>
  );
}

function Group({ label, items }: { label: string; items: WaitingItem[] }) {
  return (
    <>
      <div className="mt-2 mb-1 text-[11.5px] text-muted-foreground first:mt-0">{label}</div>
      {items.length ? items.map((i) => <Item key={i.id} item={i} />) : <div className={none}>None.</div>}
    </>
  );
}

/** One brief card: an upper-case title with a count on the right. */
function BriefCard({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <Card className="min-w-0 gap-2 py-3">
      <CardHeader className="px-3.5">
        <CardTitle className="flex justify-between text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{title}</span>
          {count !== undefined && <span>{count}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3.5">{children}</CardContent>
    </Card>
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
        <h2 className="mb-1 text-lg font-semibold">Brief</h2>
        <p className="mb-3.5 text-muted-foreground">Loading…</p>
      </section>
    );
  }
  const { brief } = data;
  const waiting = waitingOnYou(brief, data.board.cards);
  const { mode } = data.board.wip;
  const banners = wipBanners(brief.wip, mode);

  return (
    <section aria-label="Brief">
      <h2 className="mb-1 text-lg font-semibold">{greeting(new Date())}</h2>
      <p className="mb-3.5 text-muted-foreground">Stand-up for one: what waits on you, what is ready, what is stuck.</p>
      {banners.map((b) => (
        <Alert key={b} role="status" className="mb-3 border-amber-300 bg-amber-50 text-amber-900">
          <AlertTitle>{b}.</AlertTitle>
        </Alert>
      ))}
      <div className="briefgrid">
        <BriefCard title="Waiting on you" count={waiting.total}>
          <Group label="Approve spec" items={waiting.approve} />
          <Group label="Review" items={waiting.review} />
        </BriefCard>

        <BriefCard title="Ready" count={brief.ready.length}>
          {brief.ready.length ? brief.ready.map((r) => <Item key={r.id} item={r} />) : <span className={none}>Nothing ready.</span>}
          <div className={foot}>from <span className="font-mono">bd ready</span></div>
        </BriefCard>

        <BriefCard title="Blocked" count={brief.blocked.length}>
          {brief.blocked.length === 0 && <span className={none}>Nothing blocked.</span>}
          {brief.blocked.map((b) => (
            <div key={b.id} className={row}>
              <a className={cn(idCol, 'no-underline')} href={boardHref(b.id)}>{b.id}</a>
              <a className={titleCol} href={boardHref(b.id)}>{b.title}</a>
              <span className="inline-flex flex-wrap items-center gap-1">
                {b.blockers.length ? (
                  <>
                    <span className={none}>by</span>
                    {b.blockers.map((x) => (
                      <BeadLink key={x} id={x} title={byId.get(x)?.title} />
                    ))}
                  </>
                ) : (
                  <span className={none}>marked blocked</span>
                )}
              </span>
            </div>
          ))}
        </BriefCard>

        <BriefCard title="Work in progress">
          {wipBars(brief.wip).map((w) => (
            <div key={w.key}>
              <div className="flex justify-between text-[12.5px]">
                <span>{w.label}</span>
                <span className={cn('font-mono', w.full && 'text-amber-700')}>{w.count}/{w.limit}</span>
              </div>
              <div
                className="mt-1 mb-2.5 h-2 overflow-hidden rounded bg-muted"
                role="meter"
                aria-label={`${w.label} WIP`}
                aria-valuemin={0}
                aria-valuemax={w.limit}
                aria-valuenow={w.count}
                aria-valuetext={`${w.count} of ${w.limit}${w.full ? ', at the limit' : ''}`}
              >
                <i className={cn('block h-full', w.full ? 'bg-amber-500' : 'bg-green-500')} style={{ width: `${w.pct}%` }} />
              </div>
            </div>
          ))}
          <div className={foot}>
            {mode === 'refuse' ? 'While Review is at its limit, no new Build work starts.' : 'At a limit you get a warning; nothing is refused (wip.mode is warn).'}
          </div>
        </BriefCard>

        <BriefCard title="Live sessions" count={brief.sessions.length}>
          {brief.sessions.length === 0 && <span className={none}>No live Claude Code sessions.</span>}
          {brief.sessions.map((s) => (
            <a key={s.sessionId} className={cn(row, 'group')} href={boardHref(s.beadId)}>
              <SessionLight state="working" label="session live" />
              <span className={idCol}>{s.beadId}</span>
              <span className="min-w-[120px] flex-1 group-hover:underline">{byId.get(s.beadId)?.title ?? ''}</span>
              <span className="text-xs text-muted-foreground" title={s.startedAt}>since {formatSince(s.startedAt)}</span>
            </a>
          ))}
        </BriefCard>
      </div>
    </section>
  );
}

function formatSince(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
