import type { KeyboardEvent } from 'react';

/** A WAI-ARIA tab list; arrow keys move between tabs. The panel is rendered by the caller with `tabPanelProps`. */
export function Tabs<K extends string>({ tabs, value, onChange, idPrefix }: {
  tabs: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
  idPrefix: string;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex(([k]) => k === value);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    onChange(next);
    document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  };
  return (
    <div className="dtabs" role="tablist" onKeyDown={onKey}>
      {tabs.map(([k, label]) => (
        <button
          key={k}
          id={`${idPrefix}-tab-${k}`}
          type="button"
          role="tab"
          aria-selected={k === value}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={k === value ? 0 : -1}
          className={`dtab${k === value ? ' on' : ''}`}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export const tabPanelProps = (idPrefix: string, value: string) => ({
  id: `${idPrefix}-panel`,
  role: 'tabpanel',
  'aria-labelledby': `${idPrefix}-tab-${value}`,
});
