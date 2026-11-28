import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';
import { Label } from './ui/label.tsx';

/** The small upper-case label above a form field. */
export function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return <Label className={cn('mt-0.5 mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground', className)} {...props} />;
}

/** A field's error line, under the field. */
export function FieldError({ id, alert, children }: { id?: string; alert?: boolean; children: ReactNode }) {
  return (
    <div id={id} className="-mt-1 mb-2 text-xs text-destructive" role={alert ? 'alert' : undefined}>
      {children}
    </div>
  );
}

/** Spacing under each field of the New bead and Edit forms. */
export const fieldGap = 'mb-2.5';
