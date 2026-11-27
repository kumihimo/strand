import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Epic } from '../../../src/cockpit/model.ts';
import { defaultSpecFormat } from '../../../src/core/spec.ts';
import { createBead, getEpics, getRepos, refreshRepos } from '../api.ts';
import { ApiError } from '../lib/errors.ts';
import {
  ACCEPTANCE_PLACEHOLDER,
  DESCRIPTION_PLACEHOLDER,
  NEEDS_PRIMARY,
  NO_PARENT_OPTION,
  NO_PRIMARY,
  NO_REPO_NOTE,
  emptyForm,
  filterRepos,
  formTouched,
  lacksPrimary,
  makePrimary,
  PRIORITIES,
  TITLE_MAX,
  toggleRepo,
  TYPE_GROUPS,
  validateNewBead,
  type NewBeadErrors,
  type NewBeadForm,
} from '../lib/views.ts';

type P = { onClose: () => void; onCreated: (id: string) => void };

const messageOf = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * The Repos control: the workspace repos with a filter, any number ticked. The first ticked is the primary
 * repo (the session's folder); the others are context folders. Used by the New bead and Edit forms.
 */
export function RepoPicker({ id, value, onChange, error }: { id: string; value: string[]; onChange: (repos: string[]) => void; error?: string }) {
  const [repos, setRepos] = useState<string[]>();
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getRepos().then(
      (r) => live && setRepos(r.repos),
      (e) => live && setLoadError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const refresh = () => {
    setBusy(true);
    refreshRepos()
      .then(
        (r) => (setRepos(r.repos), setLoadError(undefined)),
        (e) => setLoadError(messageOf(e)),
      )
      .finally(() => setBusy(false));
  };

  // A ticked repo stays listed even when it is not in the workspace list (a folder that has gone).
  const ticked = value.filter((r) => r !== NO_PRIMARY);
  const all = [...ticked.filter((r) => !(repos ?? []).includes(r)), ...(repos ?? [])];
  const shown = filterRepos(all, query);
  // Enter in the filter box must not submit the form around it.
  return (
    <div className="repos" role="group" aria-labelledby={`${id}-lbl`} aria-describedby={error ? `${id}-err` : undefined}>
      <div className="rhead">
        <input
          id={id}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
          placeholder="Filter repos"
          aria-label="Filter repos"
        />
        <button type="button" className="sbtn" disabled={busy} onClick={refresh} title="Read the workspace folders again">
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {loadError && <div className="ferr">Repos unavailable: {loadError}</div>}
      {!repos && !loadError && <p className="mu note">Loading repos…</p>}
      <ul>
        {shown.map((r) => {
          const on = ticked.includes(r);
          const primary = value[0] === r;
          return (
            <li key={r}>
              <label className="mono">
                <input type="checkbox" checked={on} onChange={() => onChange(toggleRepo(value, r))} />
                {r}
              </label>
              {primary && <span className="pill">primary</span>}
              {on && !primary && (
                <button type="button" className="sbtn" onClick={() => onChange(makePrimary(value, r))}>
                  Make primary
                </button>
              )}
            </li>
          );
        })}
        {repos && shown.length === 0 && <li className="mu">No repo matches.</li>}
      </ul>
      {ticked.length === 0 && <p className="wa note">{NO_REPO_NOTE}</p>}
      {lacksPrimary(value) && !error && <p className="wa note">{NEEDS_PRIMARY}</p>}
      {error && <div id={`${id}-err`} className="ferr">{error}</div>}
    </div>
  );
}

/** The New bead dialog: focus starts on the title; Esc closes; Enter submits. The caller restores focus on close. */
export function NewBead({ onClose, onCreated }: P) {
  const [form, setForm] = useState<NewBeadForm>(emptyForm);
  const [errors, setErrors] = useState<NewBeadErrors>({});
  const [serverError, setServerError] = useState<string>();
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };
  const [epics, setEpics] = useState<Epic[]>();
  const [epicsError, setEpicsError] = useState<string>();
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  // Esc closes from anywhere while the dialog is open, not only when focus is inside it.
  useEffect(() => {
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // While a create is in flight the dialog cannot be dismissed: the bead is being made either way.
      if (!busyRef.current) onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  useEffect(() => {
    titleRef.current?.focus();
    let live = true;
    getEpics().then(
      (e) => live && setEpics(e),
      (e) => live && setEpicsError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const set = <K extends keyof NewBeadForm>(k: K, v: NewBeadForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setServerError(undefined);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busyRef.current) return;
    const v = validateNewBead(form);
    if ('errors' in v) {
      setErrors(v.errors);
      return;
    }
    setBusy(true);
    createBead(v.ok).then(
      (b) => onCreated(b.id),
      (err) => {
        setBusy(false);
        setServerError(messageOf(err));
      },
    );
  };

  const onKey = (e: KeyboardEvent) => {
    // Enter in a <select> does not submit a form natively; make it consistent with the text fields.
    if (e.key === 'Enter' && e.target instanceof HTMLSelectElement) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Tab' && dialogRef.current) {
      // Keep focus inside the dialog.
      const f = [...dialogRef.current.querySelectorAll<HTMLElement>('input, select, textarea, button')].filter((x) => !(x as HTMLButtonElement).disabled);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const err = (k: keyof NewBeadErrors, id: string) =>
    errors[k] ? <div id={id} className="ferr">{errors[k]}</div> : null;

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && !busyRef.current && !formTouched(form) && onClose()}>
      <form ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="nb-h" aria-busy={busy} onSubmit={submit} onKeyDown={onKey} noValidate>
        <h3 id="nb-h">
          New bead <span className="mono mu small">bd create</span>
        </h3>

        <label className="lbl" htmlFor="nb-title">Title</label>
        <input
          id="nb-title"
          ref={titleRef}
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="What needs doing"
          maxLength={TITLE_MAX}
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'nb-title-err' : undefined}
        />
        {err('title', 'nb-title-err')}

        <label className="lbl" htmlFor="nb-desc">Description <span className="mu">(optional)</span></label>
        <textarea
          id="nb-desc"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={3}
          placeholder={DESCRIPTION_PLACEHOLDER}
        />

        <label className="lbl" htmlFor="nb-accept">Acceptance criteria <span className="mu">(optional, free text for now)</span></label>
        <textarea
          id="nb-accept"
          value={form.acceptance}
          onChange={(e) => set('acceptance', e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={ACCEPTANCE_PLACEHOLDER}
          aria-describedby="nb-accept-note"
        />
        <p id="nb-accept-note" className="mu small">Approve spec needs the story line and one criterion per line in the form shown.</p>

        <div className="row two">
          <div>
            <label className="lbl" htmlFor="nb-type">Type</label>
            <select id="nb-type" value={form.type} onChange={(e) => set('type', e.target.value)} aria-invalid={!!errors.type}>
              {TYPE_GROUPS.map(([group, types]) => (
                <optgroup key={group} label={group}>
                  {types.map((t) => <option key={t} value={t}>{t}</option>)}
                </optgroup>
              ))}
            </select>
            {err('type', 'nb-type-err')}
          </div>
          <div>
            <label className="lbl" htmlFor="nb-spec">Spec format</label>
            <output id="nb-spec" className="ro mono" title="Default for this type; changing it is not in the MVP">
              {defaultSpecFormat(form.type)} <span className="mu">(default)</span>
            </output>
          </div>
        </div>

        <div className="row two">
          <div>
            <label className="lbl" htmlFor="nb-pri">Priority</label>
            <select id="nb-pri" value={form.priority} onChange={(e) => set('priority', Number(e.target.value))}>
              {PRIORITIES.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
            </select>
            {err('priority', 'nb-pri-err')}
          </div>
          <div>
            <label className="lbl" htmlFor="nb-parent">Parent epic {form.type === 'epic' && <span className="mu">(none for an epic)</span>}</label>
            <select
              id="nb-parent"
              value={form.parent}
              onChange={(e) => set('parent', e.target.value)}
              disabled={!epics && !epicsError}
              aria-invalid={!!errors.parent}
              aria-describedby={errors.parent ? 'nb-parent-err' : undefined}
            >
              <option value="">{NO_PARENT_OPTION}</option>
              {(epics ?? []).map((e) => (
                <option key={e.id} value={e.id}>{e.id} {e.title}</option>
              ))}
            </select>
            {err('parent', 'nb-parent-err')}
            {epicsError && <div className="ferr">Epics unavailable: {epicsError}</div>}
          </div>
        </div>

        <label className="lbl" id="nb-repos-lbl" htmlFor="nb-repos">Repos <span className="mu">(first ticked is the primary)</span></label>
        <RepoPicker id="nb-repos" value={form.repos} onChange={(r) => set('repos', r)} error={errors.repos} />

        {serverError && <div className="ferr" role="alert">{serverError}</div>}

        <div className="actions end">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}
