import { getReview } from '../api.ts';
import { ExtraPills, PriorityPill } from '../components/Pill.tsx';
import { BeadLink } from '../components/BeadLink.tsx';
import { PrButton } from '../components/PrButton.tsx';
import { Card } from '../components/ui/card.tsx';
import { useOnChanged } from '../changes.ts';
import { reviewRows } from '../lib/views.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';

const POLL_MS = 15_000;

export function ReviewView({ onError }: { onError: (e: unknown) => void }) {
  const { data, reload } = useApi(getReview, 'review', onError);
  usePoll(reload, POLL_MS);
  useOnChanged(reload);
  const rows = data ? reviewRows(data) : [];

  return (
    <section aria-label="Review queue" aria-busy={!data}>
      <h2 className="mb-1 text-lg font-semibold">Review queue</h2>
      <p className="mb-3.5 text-muted-foreground">
        Beads with an open PR, most urgent first. Review and merge on the forge; the bead closes when the merge lands.
      </p>
      {!data && <p className="text-xs text-muted-foreground">Loading…</p>}
      {data && rows.length === 0 && <p className="text-xs text-muted-foreground">Nothing waiting for review.</p>}
      {rows.length > 0 && (
        <Card className="gap-0 py-0">
        <table className="w-full border-collapse text-[12.5px] [&_td]:border-b [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_th]:border-b [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground [&_tbody_tr:hover_td]:bg-muted [&_tbody_tr:last-child_td]:border-b-0">
          <caption className="sr-only">Beads in review, most urgent first</caption>
          <thead>
            <tr>
              <th scope="col">Bead</th>
              <th scope="col">Change</th>
              <th scope="col">Pull request</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="whitespace-nowrap">
                  <BeadLink id={c.id} /> <PriorityPill priority={c.priority} />
                </td>
                <td>
                  <b>{c.title}</b>
                  <br />
                  <span className="text-muted-foreground text-xs">
                    {c.type}
                    {c.repo ? ` · ${c.repo}` : ''}
                    {c.branch ? ` · ${c.branch}` : ''}
                  </span>
                </td>
                <td className="whitespace-nowrap">
                  {c.pr ? <PrButton pr={c.pr} onError={onError} /> : <span className="text-xs text-muted-foreground">no PR</span>} <ExtraPills card={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </Card>
      )}
    </section>
  );
}
