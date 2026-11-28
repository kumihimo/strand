import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { cn } from 'cn';
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
import { FieldError, FieldLabel, fieldGap } from './form.tsx';
import { Pill } from './Pill.tsx';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.tsx';
import { Input } from './ui/input.tsx';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './ui/native-select.tsx';
import { Textarea } from './ui/textarea.tsx';

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
    <div className={cn('rounded-lg border px-2 py-1.5', fieldGap)} role="group" aria-labelledby={`${id}-lbl`} aria-describedby={error ? `${id}-err` : undefined}>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="search"
          className="h-7 flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
          placeholder="Filter repos"
          aria-label="Filter repos"
        />
        <Button type="button" variant="outline" size="xs" disabled={busy} onClick={refresh} title="Read the workspace folders again">
          {busy ? 'Reading…' : 'Refresh'}
        </Button>
      </div>
      {loadError && <div className="mt-1.5 text-xs text-destructive">Repos unavailable: {loadError}</div>}
      {!repos && !loadError && <p className="mt-1.5 text-xs text-muted-foreground">Loading repos…</p>}
      <ul className="mt-1.5 max-h-[150px] overflow-auto">
        {shown.map((r) => {
          const on = ticked.includes(r);
          const primary = value[0] === r;
          return (
            <li key={r} className="flex items-center gap-1.5 py-px text-[12.5px]">
              <label className="flex min-w-0 flex-1 items-center gap-1.5 font-mono [overflow-wrap:anywhere]">
                <input type="checkbox" className="accent-primary" checked={on} onChange={() => onChange(toggleRepo(value, r))} />
                {r}
              </label>
              {primary && <Pill>primary</Pill>}
              {on && !primary && (
                <Button type="button" variant="outline" size="xs" onClick={() => onChange(makePrimary(value, r))}>
                  Make primary
                </Button>
              )}
            </li>
          );
        })}
        {repos && shown.length === 0 && <li className="text-muted-foreground">No repo matches.</li>}
      </ul>
      {ticked.length === 0 && <p className="mt-1.5 text-xs text-amber-700">{NO_REPO_NOTE}</p>}
      {lacksPrimary(value) && !error && <p className="mt-1.5 text-xs text-amber-700">{NEEDS_PRIMARY}</p>}
      {error && <div id={`${id}-err`} className="mt-1.5 text-xs text-destructive">{error}</div>}
    </div>
  );
}

/**
 * The New bead dialog: focus starts on the title and is kept inside (Radix); Esc closes; Enter submits.
 * The caller restores focus on close.
 */
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

  useEffect(() => {
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
  };

  const err = (k: keyof NewBeadErrors, id: string) => (errors[k] ? <FieldError id={id}>{errors[k]}</FieldError> : null);

  return (
    <Dialog open onOpenChange={(o) => !o && !busyRef.current && onClose()}>
      <DialogContent
        className="max-h-[94vh] overflow-auto sm:max-w-[600px]"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          titleRef.current?.focus();
        }}
        // While a create is in flight the dialog cannot be dismissed: the bead is being made either way.
        onEscapeKeyDown={(e) => busyRef.current && e.preventDefault()}
        // A click outside closes only an untouched form.
        onInteractOutside={(e) => (busyRef.current || formTouched(form)) && e.preventDefault()}
      >
        <form aria-busy={busy} onSubmit={submit} onKeyDown={onKey} noValidate>
          <DialogTitle className="mb-2.5">
            New bead <span className="font-mono text-xs font-normal text-muted-foreground">bd create</span>
          </DialogTitle>

          <FieldLabel htmlFor="nb-title">Title</FieldLabel>
          <Input
            id="nb-title"
            ref={titleRef}
            className={fieldGap}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="What needs doing"
            maxLength={TITLE_MAX}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? 'nb-title-err' : undefined}
          />
          {err('title', 'nb-title-err')}

          <FieldLabel htmlFor="nb-desc">Description <span className="normal-case">(optional)</span></FieldLabel>
          <Textarea
            id="nb-desc"
            className={cn('field-sizing-fixed resize-y', fieldGap)}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            rows={3}
            placeholder={DESCRIPTION_PLACEHOLDER}
          />

          <FieldLabel htmlFor="nb-accept">Acceptance criteria <span className="normal-case">(optional, free text for now)</span></FieldLabel>
          <Textarea
            id="nb-accept"
            className="field-sizing-fixed resize-y font-mono text-[12.5px] md:text-[12.5px]"
            value={form.acceptance}
            onChange={(e) => set('acceptance', e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={ACCEPTANCE_PLACEHOLDER}
            aria-describedby="nb-accept-note"
          />
          <p id="nb-accept-note" className={cn('mt-1 text-xs text-muted-foreground', fieldGap)}>Approve spec needs the story line and one criterion per line in the form shown.</p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className={fieldGap}>
              <FieldLabel htmlFor="nb-type">Type</FieldLabel>
              <NativeSelect className="w-full" id="nb-type" value={form.type} onChange={(e) => set('type', e.target.value)} aria-invalid={!!errors.type}>
                {TYPE_GROUPS.map(([group, types]) => (
                  <NativeSelectOptGroup key={group} label={group}>
                    {types.map((t) => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
                  </NativeSelectOptGroup>
                ))}
              </NativeSelect>
              {err('type', 'nb-type-err')}
            </div>
            <div className={fieldGap}>
              <FieldLabel htmlFor="nb-spec">Spec format</FieldLabel>
              <output id="nb-spec" className="block h-8 rounded-lg border bg-muted px-2.5 py-1.5 font-mono" title="Default for this type; changing it is not in the MVP">
                {defaultSpecFormat(form.type)} <span className="text-muted-foreground">(default)</span>
              </output>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className={fieldGap}>
              <FieldLabel htmlFor="nb-pri">Priority</FieldLabel>
              <NativeSelect className="w-full" id="nb-pri" value={form.priority} onChange={(e) => set('priority', Number(e.target.value))}>
                {PRIORITIES.map(([n, label]) => <NativeSelectOption key={n} value={n}>{label}</NativeSelectOption>)}
              </NativeSelect>
              {err('priority', 'nb-pri-err')}
            </div>
            <div className={fieldGap}>
              <FieldLabel htmlFor="nb-parent">Parent epic {form.type === 'epic' && <span className="normal-case">(none for an epic)</span>}</FieldLabel>
              <NativeSelect
                className="w-full"
                id="nb-parent"
                value={form.parent}
                onChange={(e) => set('parent', e.target.value)}
                disabled={!epics && !epicsError}
                aria-invalid={!!errors.parent}
                aria-describedby={errors.parent ? 'nb-parent-err' : undefined}
              >
                <NativeSelectOption value="">{NO_PARENT_OPTION}</NativeSelectOption>
                {(epics ?? []).map((e) => (
                  <NativeSelectOption key={e.id} value={e.id}>{e.id} {e.title}</NativeSelectOption>
                ))}
              </NativeSelect>
              {err('parent', 'nb-parent-err')}
              {epicsError && <div className="mt-1 text-xs text-destructive">Epics unavailable: {epicsError}</div>}
            </div>
          </div>

          <FieldLabel id="nb-repos-lbl" htmlFor="nb-repos">Repos <span className="normal-case">(first ticked is the primary)</span></FieldLabel>
          <RepoPicker id="nb-repos" value={form.repos} onChange={(r) => set('repos', r)} error={errors.repos} />

          {serverError && <FieldError alert>{serverError}</FieldError>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
