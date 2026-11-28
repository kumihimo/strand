import { useId, useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { ChevronDownIcon } from 'lucide-react';
import {
  activeCount,
  DEFAULT_VIEW,
  epicLabel,
  NO_EPIC,
  SORT_KEYS,
  STAGE_ORDER,
  STATUS_ORDER,
  type SortKey,
  type ViewOptions,
  type ViewState,
} from '../lib/filter.ts';
import { stageLabel } from '../lib/format.ts';
import { Button } from './ui/button.tsx';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu.tsx';
import { Input } from './ui/input.tsx';
import { NativeSelect, NativeSelectOption } from './ui/native-select.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';

type P = {
  view: ViewState;
  options: ViewOptions;
  onChange: (next: ViewState) => void;
  onClear: () => void;
  /** Shown at the end of the row, before Clear (the board's legend). */
  trailing?: ReactNode;
  /** Board only. */
  showEpic?: boolean;
  /** Epics only. */
  showHideEmpty?: boolean;
  /** One line: sort, text, a Filters button for the rest. Used while the Board's strip is small. */
  compact?: boolean;
};

const SORT_LABELS: Record<SortKey, string> = {
  priority: 'Priority',
  status: 'Status',
  stage: 'Stage',
  type: 'Type',
  updated: 'Last updated',
  title: 'Title',
};

type ListKey = 'status' | 'stage' | 'type' | 'repo' | 'label';

const fieldLabel = 'text-[11px] uppercase tracking-wide text-muted-foreground';
const checkLabel = 'inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground';

type GroupProps = {
  label: string;
  values: string[];
  choices: { value: string; text: string }[];
  onToggle: (value: string) => void;
};

/** One filter list: a menu of checkboxes that stays open while ticking. */
function Group({ label, values, choices, onToggle }: GroupProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={values.length ? 'secondary' : 'outline'} size="xs" className={cn(values.length > 0 && 'font-semibold')}>
          {label}
          {values.length > 0 && <span className="fcount"> ({values.length})</span>}
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[50vh] w-auto min-w-40" aria-label={label}>
        <DropdownMenuLabel className="sr-only">{label}</DropdownMenuLabel>
        {choices.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Nothing to choose</p>}
        {choices.map((c) => (
          <DropdownMenuCheckboxItem key={c.value} checked={values.includes(c.value)} onCheckedChange={() => onToggle(c.value)} onSelect={(e) => e.preventDefault()}>
            {c.text}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The sort and filter toolbar shared by the Board and Epics views. */
export function ViewControls({ view, options, onChange, onClear, showEpic, showHideEmpty, compact, trailing }: P) {
  const id = useId();
  const [more, setMore] = useState(false);
  const n = activeCount(view);
  const set = (patch: Partial<ViewState>) => onChange({ ...view, ...patch });
  const toggle = (k: ListKey) => (value: string) =>
    set({ [k]: view[k].includes(value) ? view[k].filter((x) => x !== value) : [...view[k], value] } as Partial<ViewState>);
  const pristine = JSON.stringify(view) === JSON.stringify(DEFAULT_VIEW);

  const group = (label: string, k: ListKey, choices: { value: string; text: string }[]) => (
    <Group key={label} label={label} values={view[k]} choices={choices} onToggle={toggle(k)} />
  );
  const plain = (xs: string[]) => xs.map((t) => ({ value: t, text: t }));
  const check = (on: boolean, label: string, onToggle: (v: boolean) => void, active = false) => (
    <label className={cn(checkLabel, active && on && 'font-semibold text-foreground')}>
      <input type="checkbox" className="accent-primary" checked={on} onChange={(e) => onToggle(e.target.checked)} /> {label}
    </label>
  );

  const rest = (
    <>
      {group('Status', 'status', STATUS_ORDER.map((s) => ({ value: s, text: s.replace('_', ' ') })))}
      {group('Stage', 'stage', STAGE_ORDER.map((s) => ({ value: s, text: stageLabel(s) })))}
      {group('Type', 'type', plain(options.types))}
      {group('Repo', 'repo', plain(options.repos))}
      {group('Label', 'label', plain(options.labels))}
      {showEpic && (
        <>
          <label className={fieldLabel} htmlFor={`${id}-epic`}>
            Epic
          </label>
          <NativeSelect size="sm" id={`${id}-epic`} value={view.epic ?? ''} onChange={(e) => set(e.target.value ? { epic: e.target.value } : { epic: undefined })}>
            <NativeSelectOption value="">Any epic</NativeSelectOption>
            <NativeSelectOption value={NO_EPIC}>No epic</NativeSelectOption>
            {options.epics.map((e) => (
              <NativeSelectOption key={e} value={e} title={options.epicTitles[e] ? `${e} ${options.epicTitles[e]}` : e}>
                {epicLabel(e, options.epicTitles)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </>
      )}
      {check(view.ready, 'Ready only', (v) => set({ ready: v }), true)}
      {check(view.blocked, 'Blocked only', (v) => set({ blocked: v }), true)}
      {check(view.hideClosed, 'Hide closed', (v) => set({ hideClosed: v }))}
      {showHideEmpty && check(view.hideEmptyEpics, 'Hide epics with no matches', (v) => set({ hideEmptyEpics: v }))}
    </>
  );

  return (
    <div className={cn('vtools text-xs', compact && 'compact')} role="group" aria-label="Sort and filter">
      <div className="vrow">
        <label className={fieldLabel} htmlFor={`${id}-sort`}>
          Sort
        </label>
        <NativeSelect size="sm" id={`${id}-sort`} value={view.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
          {SORT_KEYS.map((k) => (
            <NativeSelectOption key={k} value={k}>{SORT_LABELS[k]}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => set({ dir: view.dir === 'asc' ? 'desc' : 'asc' })}
          aria-label={`Sort direction: ${view.dir === 'asc' ? 'ascending' : 'descending'}. Activate to reverse.`}
        >
          {view.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
        </Button>
        <Input
          type="search"
          className="h-7 w-[150px] text-xs md:text-xs"
          aria-label="Filter by id or title"
          placeholder="Filter id or title"
          value={view.text}
          onChange={(e) => set({ text: e.target.value })}
        />
        {compact ? (
          <Popover open={more} onOpenChange={setMore}>
            <PopoverTrigger asChild>
              <Button type="button" variant={n > 0 ? 'secondary' : 'outline'} size="xs" className={cn(n > 0 && 'font-semibold')}>
                {n === 0 ? 'Filters' : n === 1 ? '1 filter' : `${n} filters`}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto max-w-[calc(100vw-28px)] flex-row flex-wrap items-center gap-x-2 gap-y-1.5 text-xs" aria-label="Filters">
              {rest}
            </PopoverContent>
          </Popover>
        ) : (
          rest
        )}
        <span className="spacer" />
        <span className={compact ? 'sr-only' : 'whitespace-nowrap text-muted-foreground'} aria-live="polite">
          {n === 0 ? 'No filters' : n === 1 ? '1 filter active' : `${n} filters active`}
        </span>
        {trailing}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="aria-disabled:opacity-45"
          aria-disabled={pristine ? 'true' : undefined}
          onClick={() => {
            if (!pristine) onClear(); // stays focusable when there is nothing to clear
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
