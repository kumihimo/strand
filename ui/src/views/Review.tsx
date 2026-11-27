import { getReview } from '../api.ts';
import { ExtraPills, PriorityPill } from '../components/Pill.tsx';
import { PrButton } from '../components/PrButton.tsx';
import { useOnChanged } from '../changes.ts';
import { boardHref } from '../lib/route.ts';
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
      <h2>Review queue</h2>
      <p className="lead">
        Beads with an open PR, most urgent first. Review and merge on the forge; the bead closes when the merge lands.
      </p>
      {!data && <p className="none">Loading…</p>}
      {data && rows.length === 0 && <p className="none">Nothing waiting for review.</p>}
      {rows.length > 0 && (
        <table className="qtable">
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
                <td className="nowrap">
                  <a className="rlink" href={boardHref(c.id)}>{c.id}</a> <PriorityPill priority={c.priority} />
                </td>
                <td>
                  <b>{c.title}</b>
                  <br />
                  <span className="mu small">
                    {c.type}
                    {c.repo ? ` · ${c.repo}` : ''}
                    {c.branch ? ` · ${c.branch}` : ''}
                  </span>
                </td>
                <td className="nowrap">
                  {c.pr ? <PrButton pr={c.pr} onError={onError} /> : <span className="none">no PR</span>} <ExtraPills card={c} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
