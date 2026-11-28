import type { BeadCard } from '../../../src/cockpit/model.ts';
import { openTarget } from '../api.ts';
import { prRef } from '../lib/detail.ts';
import { Button } from './ui/button.tsx';

type P = {
  pr: NonNullable<BeadCard['pr']>;
  /** Words before the ref, such as `Open PR`. */
  label?: string;
  onError: (e: unknown) => void;
};

/** The PR opens through /api/open when the server knows its url; otherwise the ref is plain text. */
export function PrButton({ pr, label, onError }: P) {
  const ref = prRef(pr);
  const url = ref.url;
  const text = label ? `${label} ${ref.text}` : ref.text;
  if (!url) return <span className="font-mono" title="Pull request">{label ? `PR ${ref.text}` : ref.text}</span>;
  return (
    <Button type="button" variant="outline" size="xs" className="font-mono" title="Open the pull request" onClick={() => openTarget({ url }).catch(onError)}>
      {text}
    </Button>
  );
}
