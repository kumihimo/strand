import type { DragEvent } from 'react';
import { cn } from 'cn';
import type { BeadCard } from '../../../src/cockpit/model.ts';
import { isDocType } from '../lib/detail.ts';
import { sessionLight } from '../lib/format.ts';
import { ExtraPills, Pill, PriorityPill, StatusPill } from './Pill.tsx';
import { SessionLight } from './SessionLight.tsx';
import { Card as UiCard } from './ui/card.tsx';

type Drag = { onDragStart: (e: DragEvent<HTMLAnchorElement>) => void; onDragEnd: () => void };

/**
 * `terminal`: the cockpit has a live terminal for this bead. `card.live` is a different fact: the tracker records a session as live.
 * Both, and `card.needsYou`, show as one light (`sessionLight`); the tooltip says which.
 * `drag`: the board makes the card draggable. It stays a link, so keyboard and click work as before.
 */
export function Card({ card, selected, terminal = false, drag, dragging = false }: { card: BeadCard; selected: boolean; terminal?: boolean; drag?: Drag; dragging?: boolean }) {
  const light = sessionLight(card, terminal);
  return (
    <a
      className={cn('mb-2 block rounded-lg text-inherit no-underline focus-visible:outline-2 focus-visible:outline-ring', dragging && 'dragging')}
      href={`#/board/${encodeURIComponent(card.id)}`}
      data-bead-id={card.id}
      aria-current={selected ? 'true' : undefined}
      draggable={drag ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
    >
      <UiCard
        size="sm"
        className={cn(
          'gap-1 px-2.5 py-2 transition-shadow hover:ring-foreground/25',
          isDocType(card.type) && 'border-l-4 border-l-purple-500',
          selected && 'ring-2 ring-primary hover:ring-primary',
        )}
      >
        <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
          {card.id}
          {light && <SessionLight state={light.state} label={light.label} />}
          <span className="spacer" />
          <PriorityPill priority={card.priority} />
        </div>
        <div className="text-[13px] font-medium leading-snug">{card.title}</div>
        <div className="flex flex-wrap items-center gap-1">
          <Pill>{card.type}</Pill>
          <StatusPill card={card} />
          <ExtraPills card={card} />
          {card.parent && <Pill variant="orange">⤴ {card.parent}</Pill>}
        </div>
      </UiCard>
    </a>
  );
}
