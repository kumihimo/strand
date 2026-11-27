import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type FocusEvent, type ReactNode } from 'react';
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

type GroupProps = {
  label: string;
  values: string[];
  choices: { value: string; text: string }[];
  open: boolean;
  onToggleOpen: () => void;
  onToggle: (value: string) => void;
};

function Group({ label, values, choices, open, onToggleOpen, onToggle }: GroupProps) {
  const panel = useRef<HTMLFieldSetElement>(null);
  // A panel that would run past the right edge of the page area opens towards the left instead.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    el.classList.remove('right');
    const edge = el.closest('main')?.getBoundingClientRect().right ?? window.innerWidth;
    if (el.getBoundingClientRect().right > edge - 4) el.classList.add('right');
  }, [open]);
  return (
    <details className={`fgroup${values.length ? ' active' : ''}`} open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault(); // the open state is ours, so only one group is open at a time
          onToggleOpen();
        }}
      >
        {label}
        {values.length > 0 && <span className="fcount"> ({values.length})</span>}
      </summary>
      <fieldset className="fpanel" ref={panel}>
        <legend className="sr-only">{label}</legend>
        {choices.length === 0 && <span className="none">Nothing to choose</span>}
        {choices.map((c) => (
          <label key={c.value} className="fopt">
            <input type="checkbox" checked={values.includes(c.value)} onChange={() => onToggle(c.value)} /> {c.text}
          </label>
        ))}
      </fieldset>
    </details>
  );
}

/** The sort and filter toolbar shared by the Board and Epics views. */
export function ViewControls({ view, options, onChange, onClear, showEpic, showHideEmpty, compact, trailing }: P) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const n = activeCount(view);
  const set = (patch: Partial<ViewState>) => onChange({ ...view, ...patch });
  const toggle = (k: ListKey) => (value: string) =>
    set({ [k]: view[k].includes(value) ? view[k].filter((x) => x !== value) : [...view[k], value] } as Partial<ViewState>);
  const pristine = JSON.stringify(view) === JSON.stringify(DEFAULT_VIEW);
  const moreOpen = !!compact && more;

  // A click outside closes the open filter list, and the compact panel when the click is outside the toolbar.
  useEffect(() => {
    if (open === null && !moreOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t)) {
        setOpen(null);
        setMore(false);
      } else if (!(t as Element).closest?.('.fgroup')) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, moreOpen]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (open !== null) {
      e.preventDefault();
      const summary = root.current?.querySelector<HTMLElement>('.fgroup[open] > summary');
      setOpen(null);
      summary?.focus();
    } else if (moreOpen) {
      e.preventDefault();
      setMore(false);
      moreBtn.current?.focus();
    }
  };

  // Tabbing out of the open list closes it.
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    if (open !== null && to && !to.closest('.fgroup[open]')) setOpen(null);
  };

  const group = (label: string, k: ListKey, choices: { value: string; text: string }[]) => (
    <Group label={label} values={view[k]} choices={choices} open={open === label} onToggleOpen={() => setOpen(open === label ? null : label)} onToggle={toggle(k)} />
  );
  const plain = (xs: string[]) => xs.map((t) => ({ value: t, text: t }));

  const rest = (
    <>
      {group('Status', 'status', STATUS_ORDER.map((s) => ({ value: s, text: s.replace('_', ' ') })))}
      {group('Stage', 'stage', STAGE_ORDER.map((s) => ({ value: s, text: stageLabel(s) })))}
      {group('Type', 'type', plain(options.types))}
      {group('Repo', 'repo', plain(options.repos))}
      {group('Label', 'label', plain(options.labels))}
      {showEpic && (
        <>
          <label className="vfield" htmlFor={`${id}-epic`}>
            Epic
          </label>
          <select id={`${id}-epic`} value={view.epic ?? ''} onChange={(e) => set(e.target.value ? { epic: e.target.value } : { epic: undefined })}>
            <option value="">Any epic</option>
            <option value={NO_EPIC}>No epic</option>
            {options.epics.map((e) => (
              <option key={e} value={e} title={options.epicTitles[e] ? `${e} ${options.epicTitles[e]}` : e}>
                {epicLabel(e, options.epicTitles)}
              </option>
            ))}
          </select>
        </>
      )}
      <label className={`vcheck${view.ready ? ' active' : ''}`}>
        <input type="checkbox" checked={view.ready} onChange={(e) => set({ ready: e.target.checked })} /> Ready only
      </label>
      <label className={`vcheck${view.blocked ? ' active' : ''}`}>
        <input type="checkbox" checked={view.blocked} onChange={(e) => set({ blocked: e.target.checked })} /> Blocked only
      </label>
      <label className="vcheck">
        <input type="checkbox" checked={view.hideClosed} onChange={(e) => set({ hideClosed: e.target.checked })} /> Hide closed
      </label>
      {showHideEmpty && (
        <label className="vcheck">
          <input type="checkbox" checked={view.hideEmptyEpics} onChange={(e) => set({ hideEmptyEpics: e.target.checked })} /> Hide epics with no matches
        </label>
      )}
    </>
  );

  return (
    <div ref={root} className={`vtools${compact ? ' compact' : ''}`} role="group" aria-label="Sort and filter" onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="vrow">
        <label className="vfield" htmlFor={`${id}-sort`}>
          Sort
        </label>
        <select id={`${id}-sort`} value={view.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
          {SORT_KEYS.map((k) => (
            <option key={k} value={k}>{SORT_LABELS[k]}</option>
          ))}
        </select>
        <button
          type="button"
          className="sbtn"
          onClick={() => set({ dir: view.dir === 'asc' ? 'desc' : 'asc' })}
          aria-label={`Sort direction: ${view.dir === 'asc' ? 'ascending' : 'descending'}. Activate to reverse.`}
        >
          {view.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
        </button>
        <input
          type="search"
          className="vtext"
          aria-label="Filter by id or title"
          placeholder="Filter id or title"
          value={view.text}
          onChange={(e) => set({ text: e.target.value })}
        />
        {compact ? (
          <button
            ref={moreBtn}
            type="button"
            className={`sbtn${n > 0 ? ' on' : ''}`}
            aria-expanded={moreOpen}
            aria-controls={`${id}-more`}
            onClick={() => {
              setMore(!moreOpen);
              setOpen(null);
            }}
          >
            {n === 0 ? 'Filters' : n === 1 ? '1 filter' : `${n} filters`}
          </button>
        ) : (
          rest
        )}
        <span className="spacer" />
        <span className={compact ? 'sr-only' : 'vstat small mu'} aria-live="polite">
          {n === 0 ? 'No filters' : n === 1 ? '1 filter active' : `${n} filters active`}
        </span>
        {trailing}
        <button
          type="button"
          className="sbtn"
          aria-disabled={pristine ? 'true' : undefined}
          onClick={() => {
            if (!pristine) onClear(); // stays focusable when there is nothing to clear
          }}
        >
          Clear
        </button>
      </div>
      {moreOpen && (
        <div className="vmore" id={`${id}-more`}>
          {rest}
        </div>
      )}
    </div>
  );
}
