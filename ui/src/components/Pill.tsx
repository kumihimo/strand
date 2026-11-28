import type { ComponentProps, ReactNode } from 'react';
import type { BeadCard } from '../../../src/cockpit/model.ts';
import { extraPills, statusPill, type StatusPillText } from '../lib/format.ts';
import { Badge } from './ui/badge.tsx';

type Variant = NonNullable<ComponentProps<typeof Badge>['variant']>;

/** A small label. The default is a muted outline; `variant` picks a palette colour. */
export function Pill({ variant = 'muted', className, title, children }: { variant?: Variant; className?: string; title?: string; children: ReactNode }) {
  return (
    <Badge variant={variant} className={className} title={title}>
      {children}
    </Badge>
  );
}

const PRIORITY: Record<number, Variant> = { 0: 'red-solid', 1: 'red', 2: 'amber' };

export function PriorityPill({ priority }: { priority: number }) {
  return <Pill variant={PRIORITY[priority] ?? 'muted'}>P{priority}</Pill>;
}

const STATUS: Record<StatusPillText, Variant> = {
  closed: 'muted',
  'on hold': 'amber',
  blocked: 'red',
  'awaiting approval': 'amber',
  ready: 'green',
  'in progress': 'blue',
};

export function StatusPill({ card }: { card: BeadCard }) {
  const s = statusPill(card);
  return <Pill variant={STATUS[s]}>{s}</Pill>;
}

/** Extra pills name their colour by the old class; this maps it to a Badge variant. */
const EXTRA: Record<string, Variant> = { 'st-ci-unknown': 'amber' };

/** Pills beyond the status one, such as "CI unknown". */
export function ExtraPills({ card }: { card: BeadCard }) {
  return (
    <>
      {extraPills(card).map((p) => (
        <Pill key={p.label} variant={EXTRA[p.className] ?? 'muted'} title={p.title}>
          {p.label}
        </Pill>
      ))}
    </>
  );
}
