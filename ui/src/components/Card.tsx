import type { DragEvent } from 'react';
import type { BeadCard } from '../../../src/cockpit/model.ts';
import { isDocType } from '../lib/detail.ts';
import { sessionLight } from '../lib/format.ts';
import { ExtraPills, Pill, PriorityPill, StatusPill } from './Pill.tsx';

type Drag = { onDragStart: (e: DragEvent<HTMLAnchorElement>) => void; onDragEnd: () => void };

/**
 * `terminal`: the cockpit has a live terminal for this bead. `card.live` is a different fact: the tracker records a session as live.
 * Both, and `card.needsYou`, show as one light (`sessionLight`); the tooltip says which.
 * `drag`: the board makes the card draggable. It stays a link, so keyboard and click work as before.
 */
export function Card({ card, selected, terminal = false, drag, dragging = false }: { card: BeadCard; selected: boolean; terminal?: boolean; drag?: Drag; dragging?: boolean }) {
  const cls = ['card', isDocType(card.type) ? 'docs' : '', selected ? 'sel' : '', dragging ? 'dragging' : ''].filter(Boolean).join(' ');
  const light = sessionLight(card, terminal);
  return (
    <a
      className={cls}
      href={`#/board/${encodeURIComponent(card.id)}`}
      data-bead-id={card.id}
      aria-current={selected ? 'true' : undefined}
      draggable={drag ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
    >
      <div className="top">
        {card.id}
        {light && <span className={`light ${light.state}`} role="img" title={light.label} aria-label={light.label} />}
        <span className="spacer" />
        <PriorityPill priority={card.priority} />
      </div>
      <div className="t">{card.title}</div>
      <div className="meta">
        <Pill>{card.type}</Pill>
        <StatusPill card={card} />
        <ExtraPills card={card} />
        {card.parent && <Pill className="ep">⤴ {card.parent}</Pill>}
      </div>
    </a>
  );
}
