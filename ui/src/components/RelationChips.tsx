import { useState } from 'react';
import type { BeadCard, Relations } from '../../../src/cockpit/model.ts';
import { relationGroups } from '../lib/detail.ts';
import { BeadLink } from './BeadLink.tsx';
import { StatusPill } from './Pill.tsx';
import { Button } from './ui/button.tsx';

/** A bead id that navigates to its detail; board cards (when known) add the title and status. */
function Chip({ id, card, parent }: { id: string; card?: BeadCard; parent?: boolean }) {
  return (
    <BeadLink id={id} title={card?.title} parent={parent}>
      {parent ? `⤴ ${id}` : id}
      {card && !parent && <StatusPill card={card} />}
      {card && parent && <span className="font-sans text-muted-foreground"> · {card.title}</span>}
    </BeadLink>
  );
}

/** One wrapping row of labelled chip groups. Only relations that have something show; none at all renders nothing. */
export function RelationChips({ relations, cards }: { relations: Relations; cards: Map<string, BeadCard> }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const groups = relationGroups(relations, expanded);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pt-0.5 pb-1 text-xs" role="group" aria-label="Relations">
      {groups.map((g) => (
        <span key={g.label} className="inline-flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">{g.label}</span>
          {g.ids.map((id) => (
            <Chip key={id} id={id} card={cards.get(id)} parent={g.label === 'Parent'} />
          ))}
          {g.hidden > 0 && (
            <Button type="button" variant="outline" size="xs" aria-expanded={false} onClick={() => setExpanded((e) => [...e, g.label])}>
              +{g.hidden} more
            </Button>
          )}
          {g.hidden === 0 && expanded.includes(g.label) && (
            <Button type="button" variant="outline" size="xs" aria-expanded onClick={() => setExpanded((e) => e.filter((l) => l !== g.label))}>
              Show fewer
            </Button>
          )}
        </span>
      ))}
    </div>
  );
}
