import { useState } from 'react';
import type { BeadCard, Relations } from '../../../src/cockpit/model.ts';
import { relationGroups } from '../lib/detail.ts';
import { StatusPill } from './Pill.tsx';

/** A bead id that navigates to its detail; board cards (when known) add the title and status. */
function Chip({ id, card, parent }: { id: string; card?: BeadCard; parent?: boolean }) {
  return (
    <a className={`rlink${parent ? ' parent' : ''}`} href={`#/board/${encodeURIComponent(id)}`} title={card?.title}>
      {parent ? `⤴ ${id}` : id}
      {card && !parent && (
        <span className="s">
          <StatusPill card={card} />
        </span>
      )}
      {card && parent && <span className="mu"> · {card.title}</span>}
    </a>
  );
}

/** One wrapping row of labelled chip groups. Only relations that have something show; none at all renders nothing. */
export function RelationChips({ relations, cards }: { relations: Relations; cards: Map<string, BeadCard> }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const groups = relationGroups(relations, expanded);
  if (groups.length === 0) return null;
  return (
    <div className="rel" role="group" aria-label="Relations">
      {groups.map((g) => (
        <span key={g.label} className="relgroup">
          <span className="rlabel">{g.label}</span>
          {g.ids.map((id) => (
            <Chip key={id} id={id} card={cards.get(id)} parent={g.label === 'Parent'} />
          ))}
          {g.hidden > 0 && (
            <button type="button" className="sbtn" aria-expanded={false} onClick={() => setExpanded((e) => [...e, g.label])}>
              +{g.hidden} more
            </button>
          )}
          {g.hidden === 0 && expanded.includes(g.label) && (
            <button type="button" className="sbtn" aria-expanded onClick={() => setExpanded((e) => e.filter((l) => l !== g.label))}>
              Show fewer
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
