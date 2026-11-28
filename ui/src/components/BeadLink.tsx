import type { ReactNode } from 'react';
import { cn } from 'cn';
import { boardHref } from '../lib/route.ts';
import { Badge } from './ui/badge.tsx';

/** A bead id as a small outlined link to its detail on the Board. `parent` gives it the epic colour. */
export function BeadLink({ id, title, parent, children }: { id: string; title?: string; parent?: boolean; children?: ReactNode }) {
  return (
    <Badge asChild variant={parent ? 'orange' : 'outline'} className={cn('h-auto rounded-md font-mono text-[11.5px] hover:border-ring', !parent && 'bg-background')}>
      <a href={boardHref(id)} title={title}>
        {children ?? id}
      </a>
    </Badge>
  );
}
