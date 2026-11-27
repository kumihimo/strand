import type { ReactNode } from 'react';
import type { BeadCard } from '../../../src/cockpit/model.ts';
import { extraPills, statusPill } from '../lib/format.ts';

export function Pill({ className, title, children }: { className?: string; title?: string; children: ReactNode }) {
  return (
    <span className={`pill${className ? ` ${className}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function PriorityPill({ priority }: { priority: number }) {
  return <Pill className={`p${priority}`}>P{priority}</Pill>;
}

export function StatusPill({ card }: { card: BeadCard }) {
  const s = statusPill(card);
  return <Pill className={`st-${s.replace(' ', '-')}`}>{s}</Pill>;
}

/** Pills beyond the status one, such as "CI unknown". */
export function ExtraPills({ card }: { card: BeadCard }) {
  return (
    <>
      {extraPills(card).map((p) => (
        <Pill key={p.label} className={p.className} title={p.title}>
          {p.label}
        </Pill>
      ))}
    </>
  );
}
