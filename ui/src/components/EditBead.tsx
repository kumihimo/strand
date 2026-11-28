import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from 'cn';
import type { BeadDetail, Epic } from '../../../src/cockpit/model.ts';
import { ApiError, StaleBeadError, approveSpec, editBead, getBead, getEpics } from '../api.ts';
import {
  FIELD_LABEL,
  conflictSentence,
  acceptResult,
  droppedCriteria,
  freshnessOutcome,
  shouldRefetch,
  unionFields,
  draftChanges,
  draftProblems,
  editDraft,
  editableAcceptance,
  hasProseLines,
  rebase,
  resolveReason,
  saveAndApproveState,
  staleLines,
  type ConflictField,
  type DraftField,
  type EditDraft,
  type EditProblems,
} from '../lib/detail.ts';
import { ACCEPTANCE_PLACEHOLDER, ALL_TYPES, DESCRIPTION_PLACEHOLDER, NO_PARENT_OPTION, PRIORITIES, TYPE_GROUPS } from '../lib/views.ts';
import { FieldError, FieldLabel, fieldGap } from './form.tsx';
import { RepoPicker } from './NewBead.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './ui/native-select.tsx';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet.tsx';
import { Textarea } from './ui/textarea.tsx';

/** What the Spec tab shows once the form closes. */
export type EditOutcome = {
  saved: boolean;
  changed: string[];
  /** The server saved but could not record the criteria baseline or the comment, or approval carries a WIP warning. */
  warn?: string;
  /** Saved, but the approval was refused or failed. */
  notApproved?: string;
  approved?: boolean;
};

type Field = keyof EditProblems;
type P = {
  /** The bead as the page has it now. It is replaced by each background refresh; the form keeps its own base. */
  d: BeadDetail;
  onClose: (outcome?: EditOutcome) => void;
  /** Told whenever the draft starts or stops differing from the bead (and false on unmount). */
  onDirty?: (dirty: boolean) => void;
};

const messageOf = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Which field a server 400 belongs to; undefined means the form as a whole. */
function serverField(message: string): Field | undefined {
  if (message.startsWith('title')) return 'title';
  if (message.startsWith('description')) return 'description';
  if (message.startsWith('needs a parent') || message.startsWith('invalid parent')) return 'parent';
  if (message.startsWith('invalid type')) return 'type';
  if (message.startsWith('criterion') || message.startsWith('needs at least one') || /^\d+ acceptance line/.test(message)) return 'acceptance';
  if (/^(unknown repo|invalid repo name|invalid context|a bead with context folders)/.test(message) || / has a branch in /.test(message)) return 'repos';
  return undefined;
}

const actions = 'flex flex-wrap items-center gap-2 py-2';
const preBox = 'my-1 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted px-2.5 py-2 font-mono text-xs [overflow-wrap:anywhere]';
/** Fixed height from `rows`, resizable by hand. */
const area = 'field-sizing-fixed resize-y';

const FIELD_ORDER: Field[] = ['title', 'description', 'acceptance', 'type', 'parent', 'repos'];

const shown = (c: ConflictField['theirs'], field: DraftField): string => {
  if (field === 'priority') return PRIORITIES.find(([n]) => n === c)?.[1] ?? String(c);
  if (Array.isArray(c)) return c.filter(Boolean).join(', ') || '(none)';
  return String(c) || '(empty)';
};

/**
 * The spec form, in a sheet over the page: focus is kept inside it, Esc asks before it drops a draft.
 * The caller puts focus back on its Edit button on close.
 */
export function EditBead({ d, onClose, onDirty }: P) {
  // The bead the draft started from. A rebase moves it to the newer bead.
  const [base, setBase] = useState(d);
  const [version, setVersion] = useState(d.version);
  const [draft, setDraft] = useState<EditDraft>(() => editDraft(d));
  const [errors, setErrors] = useState<EditProblems>({});
  const [formError, setFormError] = useState<string>();
  const [conflicts, setConflicts] = useState<ConflictField[]>([]);
  const [notice, setNotice] = useState<{ taken: DraftField[] }>();
  const [newest, setNewest] = useState<BeadDetail>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };
  const [epics, setEpics] = useState<Epic[]>();
  const titleRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // The newest state, for callbacks that outlive a render (a request that comes back later).
  const latest = useRef({ base, draft, conflicts, version });
  latest.current = { base, draft, conflicts, version };
  const fetching = useRef(false);
  const alive = useRef(true);
  // One counter numbers every fetch whose result may be applied: poll refetch, freshness check, a 409.
  const seqCounter = useRef(0);
  const appliedSeq = useRef(0);
  // The field that had focus before Cancel or Esc, for "Keep editing" in the discard prompt.
  const lastField = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    // Without the list the select still holds the current parent, so a save is not blocked.
    getEpics().then((e) => live && setEpics(e), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  /** A newer bead arrived (a 409, a fresh fetch, or a background refresh): carry the draft over to it. */
  const applyNewer = (current: BeadDetail, seq: number): boolean => {
    // An older request that finishes late must not roll back what a later one already brought in.
    if (!acceptResult(seq, appliedSeq.current)) return false;
    appliedSeq.current = seq;
    const l = latest.current;
    const r = rebase(l.base, current, l.draft, l.conflicts);
    latest.current = { base: r.base, draft: r.draft, conflicts: r.conflicts, version: current.version };
    setBase(r.base);
    setVersion(current.version);
    setDraft(r.draft);
    setConflicts(r.conflicts);
    // Fields taken earlier stay named until the notice is dismissed.
    setNotice((n) => ({ taken: unionFields(n?.taken ?? [], r.taken) }));
    setNewest(current);
    setErrors({});
    return true;
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Runs on every poll delivery (useApi sets a new `d` object each time) and when a save or approve settles.
  // Versions cannot be ordered and a poll can lag, so the polled payload is never rebased onto: if its
  // version differs, fetch the bead and rebase only if that result still differs from the form's version.
  // A failed fetch, or a version that moved while one was in flight, is picked up by the next delivery.
  useEffect(() => {
    // busyRef too: the render-time `busy` can be stale when a save starts between render and effect.
    if (!shouldRefetch(latest.current.version, d.version, busy || busyRef.current || fetching.current)) return;
    fetching.current = true;
    const seq = ++seqCounter.current;
    getBead(d.id)
      .finally(() => {
        fetching.current = false;
      })
      .then(
        (cur) => {
          if (!alive.current || !shouldRefetch(latest.current.version, cur.version, busyRef.current)) return;
          try {
            applyNewer(cur, seq);
          } catch (e) {
            console.error('Could not apply the newer version of the bead', e);
          }
        },
        () => undefined,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, busy]);

  const set = <K extends keyof EditDraft>(k: K, v: EditDraft[K]) => {
    setDraft((x) => ({ ...x, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setFormError(undefined);
  };

  const approve = saveAndApproveState(base, draft);
  const blocked = resolveReason(conflicts);
  const approved = base.planApprovedAt !== undefined;
  const touchedCriteria = draft.acceptance.trim() !== editableAcceptance(base);
  // Only after approval are prose lines dropped on save; before it the text is stored as typed.
  const prose = approved && touchedCriteria && hasProseLines(base.acceptance);
  const dirty = Object.keys(draftChanges(base, draft)).length > 0;
  const dirtyRef = useRef(onDirty);
  dirtyRef.current = onDirty;
  useEffect(() => {
    dirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyRef.current?.(false), []);

  const focusField = (k: Field) => document.getElementById(`eb-${k}`)?.focus();

  const finish = (outcome: EditOutcome) => {
    setBusy(false);
    onClose(outcome);
  };

  const submit = (andApprove: boolean) => {
    if (busyRef.current || conflicts.length > 0) return;
    const problems = draftProblems(base, draft);
    const first = FIELD_ORDER.find((k) => problems[k]);
    if (first) {
      setErrors(problems);
      focusField(first);
      return;
    }
    const changes = draftChanges(base, draft);
    const noChange = Object.keys(changes).length === 0;
    if (noChange && !andApprove) return onClose({ saved: false, changed: [] });
    setBusy(true);
    setFormError(undefined);
    const afterSave = (changed: string[], warn?: string) => {
      // A form closed while the save was in flight does not approve: the engineer left it.
      if (!andApprove || !alive.current) return finish({ saved: true, changed, ...(warn ? { warn } : {}) });
      approveSpec(base.id).then(
        (r) => finish({ saved: true, changed, approved: true, ...(warn || r.warn ? { warn: [warn, r.warn].filter(Boolean).join(' ') } : {}) }),
        (e) => finish({ saved: true, changed, ...(warn ? { warn } : {}), notApproved: messageOf(e) }),
      );
    };
    const seq = ++seqCounter.current;
    if (noChange) {
      // Nothing to save, so no write checks freshness: look first, and do not approve a spec that moved.
      getBead(base.id).then(
        (cur) => {
          try {
            const next = freshnessOutcome(alive.current, cur.version, latest.current.version);
            if (next === 'gone') return;
            if (next === 'approve') return afterSave([]);
            setBusy(false);
            applyNewer(cur, seq);
          } catch (e) {
            setBusy(false);
            setFormError(messageOf(e));
          }
        },
        (e) => {
          setBusy(false);
          setFormError(messageOf(e));
        },
      );
      return;
    }
    editBead(base.id, { version, ...changes }).then(
      (r) => afterSave(r.changed, r.warning),
      (err) => {
        setBusy(false);
        if (err instanceof StaleBeadError) {
          // Refused as older: the form already holds a later version, but this save did not happen.
          if (!applyNewer(err.current, seq)) setFormError('Not saved. The bead changed again. Check the fields and save again.');
          return;
        }
        const msg = messageOf(err);
        const k = err instanceof ApiError && err.status === 400 ? serverField(msg) : undefined;
        if (k) {
          setErrors((e) => ({ ...e, [k]: msg }));
          focusField(k);
        } else setFormError(msg);
      },
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(false);
  };

  /** Cancel and Esc: ask once when there is something to lose. */
  const requestClose = () => (dirty ? setConfirming(true) : onClose());

  /** Esc in the sheet: never closes it outright. It closes the discard prompt, or asks for one when there is a draft. */
  const onEscape = () => {
    if (busyRef.current) return;
    if (confirming) keepEditing();
    else requestClose();
  };

  /** Close the discard prompt and put focus back on the field that had it, else the first field. */
  const keepEditing = () => {
    setConfirming(false);
    requestAnimationFrame(() => (lastField.current?.isConnected ? lastField.current : titleRef.current)?.focus());
  };

  const loadNewer = () => {
    if (!newest) return;
    setBase(newest);
    setVersion(newest.version);
    setDraft(editDraft(newest));
    setErrors({});
    setConflicts([]);
    setNotice(undefined);
    requestAnimationFrame(() => titleRef.current?.focus());
  };
  const useTheirs = (c: ConflictField) => {
    setDraft((x) => ({ ...x, [c.field]: c.theirs }));
    setErrors((e) => ({ ...e, [c.field]: undefined }));
    setConflicts((cs) => cs.filter((x) => x.field !== c.field));
  };
  const keepMine = (c: ConflictField) => setConflicts((cs) => cs.filter((x) => x.field !== c.field));

  const err = (k: Field) => (errors[k] ? <FieldError id={`eb-${k}-err`} alert>{errors[k]}</FieldError> : null);
  const aria = (k: Field, extra?: string) => ({
    'aria-invalid': !!errors[k],
    'aria-describedby': [errors[k] ? `eb-${k}-err` : '', extra ?? ''].filter(Boolean).join(' ') || undefined,
  });

  const parents = epics ? [...epics] : [];
  const currentParent = base.parent;
  const hasParentOption = !currentParent || parents.some((e) => e.id === currentParent);

  return (
    <Sheet open onOpenChange={(o) => !o && onEscape()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 overflow-auto p-4 sm:max-w-[640px] data-[side=right]:sm:max-w-[640px]"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          titleRef.current?.focus();
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onEscape();
        }}
        // The draft is not lost to a stray click: only Cancel, Esc and the buttons close the sheet.
        onInteractOutside={(e) => e.preventDefault()}
      >
    <SheetTitle className="mb-3 text-base">Edit <span className="font-mono">{base.id}</span></SheetTitle>
    <form
      onSubmit={onSubmit}
      onFocus={(e) => {
        const t = e.target;
        if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) lastField.current = t;
      }}
      noValidate aria-busy={busy} aria-label={`Edit ${base.id}`}>
      {(notice || conflicts.length > 0) && (
        <div className="mb-2.5 rounded-lg border border-amber-400 px-2.5 py-2" role="alert">
          {staleLines(notice?.taken ?? []).map((l) => <p key={l} className="mb-1">{l}</p>)}
          {conflicts.map((c) => {
            const label = FIELD_LABEL[c.field];
            const dropped = c.field === 'acceptance' ? droppedCriteria(String(c.mine), String(c.theirs)) : [];
            return (
              <div key={c.field} className="mt-1.5 border-t pt-1.5">
                <p className="mb-1">{conflictSentence(c.field)}</p>
                <details open>
                  <summary className="cursor-pointer">Newer {label}</summary>
                  <pre className={preBox}>{shown(c.theirs, c.field)}</pre>
                </details>
                <div className={actions}>
                  <Button type="button" onClick={() => useTheirs(c)}>Use the newer {label}</Button>
                  <Button type="button" variant="outline" onClick={() => keepMine(c)}>Keep mine</Button>
                </div>
                {dropped.length > 0 && (
                  <div className="text-muted-foreground">
                    <p className="mb-1">Keep mine removes {dropped.length} {dropped.length === 1 ? 'criterion' : 'criteria'} the newer version has:</p>
                    <pre className={preBox}>{dropped.join('\n')}</pre>
                  </div>
                )}
              </div>
            );
          })}
          <div className={actions}>
            {newest && <Button type="button" variant="outline" onClick={loadNewer}>Load the newer version</Button>}
            {conflicts.length === 0 && <Button type="button" variant="outline" onClick={() => setNotice(undefined)}>Dismiss</Button>}
          </div>
        </div>
      )}

      <FieldLabel htmlFor="eb-title">Title</FieldLabel>
      <Input id="eb-title" ref={titleRef} className={fieldGap} value={draft.title} onChange={(e) => set('title', e.target.value)} {...aria('title')} />
      {err('title')}

      <FieldLabel htmlFor="eb-description">Description</FieldLabel>
      <Textarea
        id="eb-description"
        className={cn(area, fieldGap)}
        value={draft.description}
        onChange={(e) => set('description', e.target.value)}
        rows={3}
        placeholder={DESCRIPTION_PLACEHOLDER}
        {...aria('description')}
      />
      {err('description')}

      <FieldLabel htmlFor="eb-acceptance">
        Acceptance criteria <span className="normal-case">{approved ? '(one per line, each names its check)' : '(free text until the spec is approved)'}</span>
      </FieldLabel>
      <Textarea
        id="eb-acceptance"
        className={cn(area, 'font-mono text-[12.5px] md:text-[12.5px]')}
        value={draft.acceptance}
        onChange={(e) => set('acceptance', e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={ACCEPTANCE_PLACEHOLDER}
        {...aria('acceptance', 'eb-acceptance-note')}
      />
      {err('acceptance')}
      <p id="eb-acceptance-note" className={cn('mt-1 text-xs text-muted-foreground', fieldGap)}>
        Ticks and evidence stay on a criterion whose text and check are unchanged. A changed criterion is unticked.
        {!approved && ' Approve spec needs every line in the form shown.'}
      </p>
      {prose && <p className={cn('text-xs text-amber-700', fieldGap)}>Lines that are not criteria will be removed when you save.</p>}

      <FieldLabel htmlFor="eb-design">Spec body <span className="normal-case">({base.specFormat})</span></FieldLabel>
      <Textarea id="eb-design" className={cn(area, 'font-mono text-[12.5px] md:text-[12.5px]', fieldGap)} value={draft.design} onChange={(e) => set('design', e.target.value)} rows={8} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className={fieldGap}>
          <FieldLabel htmlFor="eb-type">Type</FieldLabel>
          <NativeSelect className="w-full" id="eb-type" value={draft.type} onChange={(e) => set('type', e.target.value)} {...aria('type')}>
            {!ALL_TYPES.includes(draft.type) && <NativeSelectOption value={draft.type}>{draft.type}</NativeSelectOption>}
            {TYPE_GROUPS.map(([group, types]) => (
              <NativeSelectOptGroup key={group} label={group}>
                {types.map((t) => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
              </NativeSelectOptGroup>
            ))}
          </NativeSelect>
          {err('type')}
        </div>
        <div className={fieldGap}>
          <FieldLabel htmlFor="eb-priority">Priority</FieldLabel>
          <NativeSelect className="w-full" id="eb-priority" value={draft.priority} onChange={(e) => set('priority', Number(e.target.value))}>
            {PRIORITIES.map(([n, label]) => <NativeSelectOption key={n} value={n}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <div className={fieldGap}>
          <FieldLabel htmlFor="eb-parent">Parent epic {draft.type === 'epic' && <span className="normal-case">(none for an epic)</span>}</FieldLabel>
          <NativeSelect className="w-full" id="eb-parent" value={draft.parent} onChange={(e) => set('parent', e.target.value)} {...aria('parent')}>
            <NativeSelectOption value="">{NO_PARENT_OPTION}</NativeSelectOption>
            {!hasParentOption && <NativeSelectOption value={currentParent}>{currentParent}</NativeSelectOption>}
            {parents.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>{e.id} {e.title}</NativeSelectOption>
            ))}
          </NativeSelect>
          {err('parent')}
        </div>
      </div>

      <FieldLabel id="eb-repos-lbl" htmlFor="eb-repos">Repos <span className="normal-case">(first ticked is the primary)</span></FieldLabel>
      <RepoPicker id="eb-repos" value={draft.repos} onChange={(r) => set('repos', r)} error={errors.repos} />

      {formError && <FieldError alert>{formError}</FieldError>}

      {confirming && (
        <div className="mb-2.5 rounded-lg border border-amber-400 px-2.5 py-2" role="alert">
          <p className="mb-1">Discard your changes?</p>
          <div className={actions}>
            <Button ref={keepRef} type="button" onClick={keepEditing}>Keep editing</Button>
            <Button type="button" variant="outline" onClick={() => onClose()}>Discard</Button>
          </div>
        </div>
      )}

      <div className={actions}>
        <Button type="submit" disabled={busy || !!blocked} aria-describedby={blocked ? 'eb-blocked' : undefined}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          disabled={busy || !approve.enabled || !!blocked}
          aria-describedby={blocked ? 'eb-blocked' : approve.reason ? 'eb-approve-why' : undefined}
          onClick={() => submit(true)}
        >
          Save and approve
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>Cancel</Button>
        {blocked && <span id="eb-blocked" className="text-amber-700">{blocked}</span>}
        {!blocked && approve.reason && base.stage === 'specify' && <span id="eb-approve-why" className="text-muted-foreground">{approve.reason}</span>}
        {/* From the bead as the page has it now, not as the form opened. */}
        {approve.enabled && d.wipWarning && <span className="text-amber-700" role="status">{d.wipWarning}</span>}
      </div>
    </form>
      </SheetContent>
    </Sheet>
  );
}
