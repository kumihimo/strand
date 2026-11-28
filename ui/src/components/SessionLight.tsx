import { cn } from 'cn';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';

/** working = a session is live, waiting = it waits for the engineer, terminal = a cockpit terminal is open, dirty = unsaved edits. */
export type LightState = 'working' | 'waiting' | 'terminal' | 'dirty';

const COLOUR: Record<LightState, string> = {
  working: 'bg-green-500 shadow-green-500',
  waiting: 'bg-amber-500 shadow-amber-500',
  terminal: 'bg-blue-500 shadow-blue-500',
  dirty: 'bg-amber-500 shadow-amber-500',
};

/** The dot alone, for legends. */
export function Dot({ state }: { state: LightState }) {
  return <span className={cn('inline-block size-2 flex-none rounded-full shadow-[0_0_6px]', COLOUR[state])} aria-hidden="true" />;
}

/** A status light with its meaning as the accessible name and a tooltip. */
export function SessionLight({ state, label }: { state: LightState; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} data-light={state} className={cn('inline-block size-2 flex-none rounded-full shadow-[0_0_6px]', COLOUR[state])} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
