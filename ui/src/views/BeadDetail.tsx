import { Suspense, lazy, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BeadCard, BeadDetail as Detail } from '../../../src/cockpit/model.ts';
import type { TerminalInfo } from '../../../src/cockpit/pty.ts';
import { ApiError, StaleBeadError, approveSpec, getBead, releaseBead, requestChanges, startSession, stopTerminal, type SessionBody, type TerminalList } from '../api.ts';
import { Artefacts } from '../components/Artefacts.tsx';
import { CopyCommand } from '../components/CopyCommand.tsx';
import { TerminalBoundary } from '../components/TerminalBoundary.tsx';
import { EditBead, type EditOutcome } from '../components/EditBead.tsx';
import { ExtraPills, Pill, PriorityPill, StatusPill } from '../components/Pill.tsx';
import { PrButton } from '../components/PrButton.tsx';
import { RelationChips } from '../components/RelationChips.tsx';
import { Tabs, tabPanelProps } from '../components/Tabs.tsx';
import {
  DESCRIPTION_LINES,
  DESIGN_LINES,
  NOTE_MAX,
  approveState,
  clampText,
  criteriaRows,
  hasProseLines,
  newestFirst,
  requestChangesProblem,
} from '../lib/detail.ts';
import { stageLabel } from '../lib/format.ts';
import type { Drawer, Drawers } from '../lib/drawer.ts';
import { firstEnabled, liveBeadIds, liveElsewhere, sessionButtons, terminalsOf } from '../lib/terminal.ts';
import { dropVerdict } from '../lib/views.ts';
import { LEAVE_DRAFT, tabLeavesDraft } from '../lib/route.ts';
import { useApi } from '../useApi.ts';
import { usePoll } from '../usePoll.ts';

// xterm is about 340 KB: it loads when the first terminal is shown, not with the board.
const TerminalPane = lazy(() => import('../components/TerminalPane.tsx').then((m) => ({ default: m.TerminalPane })));

/** Same 15 s visible-only poll as the board (the server cache TTL). */
const POLL_MS = 15_000;

type TabKey = 'spec' | 'activity' | 'artefacts';
const TABS = [
  ['spec', 'Spec'],
  ['activity', 'Activity'],
  ['artefacts', 'Artefacts'],
] as const;

type P = {
  id: string;
  cards: Map<string, BeadCard>;
  /** The cockpit's terminal list (undefined until the first answer). */
  terminals: TerminalList | undefined;
  onTerminalsChanged: () => void;
  /** A terminal the server just started, to show before the next fetch. */
  onTerminalStarted: (t: TerminalInfo) => void;
  drawers: Drawers;
  onToggleDrawer: (which: Drawer) => void;
  onExpandForSession: () => void;
  /** The edit form holds unsaved changes: App guards route changes and closing the window. */
  onEditDirty: (dirty: boolean) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
};

export function BeadDetail({ id, cards, terminals, onTerminalsChanged, onTerminalStarted, drawers, onToggleDrawer, onExpandForSession, onEditDirty, onChanged, onError }: P) {
  const [failed, setFailed] = useState<string>();
  // The edit form holds a draft that differs from the bead (told by EditBead). Shown on the collapsed details strip.
  const [dirty, setDirtyState] = useState(false);
  const setDirty = (d: boolean) => {
    setDirtyState(d);
    onEditDirty(d);
  };
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const bodyId = useId();
  const leftId = useId();
  const panelBtn = useRef<HTMLButtonElement>(null);
  const hideBtn = useRef<HTMLButtonElement>(null);
  const showBtn = useRef<HTMLButtonElement>(null);
  const bodyEl = useRef<HTMLDivElement>(null);
  const leftEl = useRef<HTMLDivElement>(null);
  const lastToggle = useRef<Drawer>(undefined);
  const toggleDrawer = (which: Drawer) => {
    lastToggle.current = which;
    onToggleDrawer(which);
  };
  // Focus after a toggle: the pressed button keeps it, or its counterpart when the pressed one is gone. Content that
  // is hidden (inert) must never hold focus: if it did, focus goes to the toggle.
  useEffect(() => {
    const t = lastToggle.current;
    lastToggle.current = undefined;
    if (t === 'details') return void (drawers.details ? showBtn : hideBtn).current?.focus();
    if (t === 'panel') return void panelBtn.current?.focus();
    if (t === 'wide') return; // its button stays in place and keeps focus
    const a = document.activeElement;
    if (!a) return;
    if (drawers.panel && bodyEl.current?.contains(a)) panelBtn.current?.focus();
    else if (drawers.details && leftEl.current?.contains(a)) showBtn.current?.focus();
  }, [drawers.details, drawers.panel, drawers.wide]);
  const { data, reload } = useApi(
    () => getBead(id).then((d) => (setFailed(undefined), d)),
    `bead:${id}`,
    (e) => {
      setFailed(id);
      onError(e);
    },
  );
  usePoll(reload, POLL_MS);
  const [tab, setTab] = useState<TabKey>('spec');
  // Leaving Spec unmounts the edit form: an unsaved draft asks first, as a route change does.
  const switchTab = (next: TabKey) => {
    if (tabLeavesDraft(dirty, tab, next) && !confirm(LEAVE_DRAFT)) return;
    setTab(next);
  };
  if (!data || data.id !== id) {
    return failed === id ? (
      <section className="detail empty" role="alert">
        <p className="ko">
          Could not load {id}.{' '}
          <button type="button" className="sbtn" onClick={reload}>Retry</button>
        </p>
      </section>
    ) : (
      <section className="detail empty" aria-busy="true">
        <p className="none">Loading {id}…</p>
      </section>
    );
  }
  const refresh = () => {
    onChanged();
    reload();
  };
  const termOpen = liveBeadIds(terminals?.terminals ?? []).has(id);
  return (
    <section className="detail" aria-label={`Bead ${id}`}>
      <div className="panelbar">
        <span className="mono pbid">{data.id}</span>
        <span className="pbtitle" title={data.title}>{data.title}</span>
        <Pill>stage: {stageLabel(data.stage)}</Pill>
        {termOpen && <span className="live term" role="img" title="Terminal open" aria-label="Terminal open" />}
        <span className="spacer" />
        {data.pr && <PrButton pr={data.pr} label="Open PR" onError={onError} />}
        {!drawers.panel && !drawers.details && (
          <button ref={hideBtn} type="button" className="sbtn" aria-expanded aria-controls={leftId} onClick={() => toggleDrawer('details')}>
            Hide details
          </button>
        )}
        {/* Hide details gives the session the width. This gives the drawer the height. */}
        {!drawers.panel && (
          <button
            type="button"
            className="sbtn"
            aria-pressed={drawers.wide}
            title={drawers.wide ? 'Give the board its normal height back' : 'Give this drawer 80% of the view'}
            onClick={() => toggleDrawer('wide')}
          >
            {drawers.wide ? 'Shrink' : 'Expand'}
          </button>
        )}
        <button ref={panelBtn} type="button" className="sbtn" aria-expanded={!drawers.panel} aria-controls={bodyId} onClick={() => toggleDrawer('panel')}>
          {drawers.panel ? 'Expand' : 'Collapse'}
        </button>
      </div>
      <div id={bodyId} ref={bodyEl} className={`pbody${drawers.details ? ' dcol' : ''}${drawers.panel ? ' pcol' : ''}`} inert={drawers.panel}>
        {drawers.details && (
          <div className="strip">
            <button ref={showBtn} type="button" className="sbtn" aria-expanded={false} aria-controls={leftId} aria-label="Show details" title="Show details" onClick={() => toggleDrawer('details')}>
              ›
            </button>
            <span className="mono stripid">{data.id}</span>
            {dirty && <span className="live dirty" role="img" title="Unsaved edits" aria-label="Unsaved edits" />}
          </div>
        )}
      <div id={leftId} ref={leftEl} className="left" inert={drawers.details}>
        <div className="head">
          <h2 title={data.title}>{data.title}</h2>
          <div className="meta">
            <Pill className="mono">{data.id}</Pill>
            <PriorityPill priority={data.priority} />
            <StatusPill card={data} />
            {data.needsYou && <Pill className="needs-you-pill" title="Claude is waiting for you">needs you</Pill>}
            <Pill>stage: {stageLabel(data.stage)}</Pill>
            <ExtraPills card={data} />
            <Pill>{data.type}</Pill>
            {data.branch && <Pill className="mono" title="Branch">⎇ {data.branch}</Pill>}
            {data.repo && <Pill className="mono" title="Primary repo">repo: {data.repo}</Pill>}
            {data.context.map((c) => (
              <Pill key={c} className="mono ctx" title="Context folder">+ {c}</Pill>
            ))}
            {data.live && <span className="live" title="Claude Code session live" aria-label="session live" />}
          </div>
        </div>
        <RelationChips relations={data.relations} cards={cards} />
        <div className="tabbar">
          <Tabs tabs={TABS} value={tab} onChange={switchTab} idPrefix="bead" />
          {/* The Spec tab puts its Edit button here (a portal), at the right end of the tab row. */}
          <span ref={setSlot} className="tabslot" />
        </div>
        <div className="dbody" {...tabPanelProps('bead', tab)}>
          {tab === 'spec' && <SpecTab key={data.id} d={data} slot={slot} onApproved={refresh} onError={onError} onDirty={setDirty} />}
          {tab === 'activity' && <ActivityTab d={data} />}
          {tab === 'artefacts' && <Artefacts key={id} beadId={id} artefacts={data.artefacts} onError={onError} />}
        </div>
      </div>
      <SessionPane
        key={data.id}
        d={data}
        list={terminals}
        onStarted={onTerminalStarted}
        onExpand={onExpandForSession}
        onChanged={() => {
          onTerminalsChanged();
          refresh();
        }}
      />
      </div>
    </section>
  );
}

const messageOf = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Text cut to a few lines, with a Show more / Show less button. Collapsed, only the cut text is in the DOM. */
function Clamped({ text, lines, pre }: { text: string; lines: number; pre?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const c = clampText(text, lines);
  const shown = open || !c.cut ? text : c.text + '…';
  return (
    <>
      {pre ? <pre className="design" id={id}>{shown}</pre> : <p className="pre clamp" id={id}>{shown}</p>}
      {c.cut && (
        <button type="button" className="sbtn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

const CRIT_MARK = { verified: '✓', unverified: '!', open: '○' } as const;
const CRIT_LABEL = { verified: 'verified', unverified: 'ticked, no evidence', open: 'open' } as const;

function SpecTab({ d, slot, onApproved, onError, onDirty }: { d: Detail; slot: HTMLElement | null; onApproved: () => void; onError: (e: unknown) => void; onDirty: (dirty: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<string>();
  const [approveError, setApproveError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const askBtn = useRef<HTMLButtonElement>(null);
  // The form unmounts on Cancel and on success; put focus back on the button that opened it.
  const closeAsking = () => {
    setAsking(false);
    requestAnimationFrame(() => askBtn.current?.focus());
  };
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string>();
  const editBtn = useRef<HTMLButtonElement>(null);
  const closeEditing = (o?: EditOutcome) => {
    setEditing(false);
    setWarn(o?.warn);
    setApproveError(o?.notApproved === undefined ? undefined : `Saved. Not approved: ${o.notApproved}`);
    setSaved(o?.saved ? `Saved${o.changed.length ? `: ${o.changed.join(', ')}` : ''}${o.approved ? '. Approved.' : ''}` : undefined);
    if (o?.saved) onApproved();
    requestAnimationFrame(() => editBtn.current?.focus());
  };
  const approval = approveState(d);
  const rows = criteriaRows(d.criteria);
  // Before approval the criteria may be free text: show it as typed.
  const prose = !d.planApprovedAt && hasProseLines(d.acceptance);
  if (editing) return <EditBead d={d} onClose={closeEditing} onDirty={onDirty} />;
  const doApprove = () => {
    setBusy(true);
    setWarn(undefined);
    setApproveError(undefined);
    // The version on screen: a spec Claude rewrote since the last poll is not approved unseen.
    approveSpec(d.id, d.version)
      .then(
        (r) => {
          setWarn(r.warn);
          onApproved();
        },
        (e) => {
          if (e instanceof StaleBeadError) {
            setApproveError(`${e.message} Not approved: check the newer spec, then approve again.`);
            onApproved();
          } else if (e instanceof ApiError && e.status === 409) setApproveError(e.message);
          else onError(e);
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      {d.editable &&
        slot &&
        createPortal(
          <button
            ref={editBtn}
            type="button"
            className="sbtn"
            disabled={busy}
            onClick={() => (setSaved(undefined), setWarn(undefined), setApproveError(undefined), setSent(false), setEditing(true))}
          >
            Edit
          </button>,
          slot,
        )}
      {saved && <p className="ok" role="status">{saved}</p>}
      {d.description?.trim() && (
        <div className="section">
          <h4>Description</h4>
          <Clamped text={d.description} lines={DESCRIPTION_LINES} />
        </div>
      )}
      <div className="section">
        <h4>
          Criteria
          {d.planApprovedAt && <span className="mu"> · plan approved {d.planApprovedAt.replace('T', ' ').slice(0, 16)}</span>}
        </h4>
        {d.criteriaChanged && (
          <p className="wa" role="status">
            The criteria no longer match the approved baseline. Claude should show you the change and ask before going on.
          </p>
        )}
        {rows.length === 0 && !prose && <p className="none">No acceptance criteria written yet.</p>}
        {prose && <Clamped text={d.acceptance ?? ''} lines={DESIGN_LINES} pre />}
        {rows.length > 0 && !prose && (
          <ul className="crit">
            {rows.map((r, i) => (
              <li key={i}>
                <span className={`cmark ${r.state === 'verified' ? 'ok' : r.state === 'unverified' ? 'wa' : 'mu'}`} role="img" aria-label={CRIT_LABEL[r.state]} title={CRIT_LABEL[r.state]}>
                  {CRIT_MARK[r.state]}
                </span>
                <span className="ctext pre">{r.text}</span>
                {/* The title is for the mouse only: the hidden word names the note for a screen reader. */}
                {r.check !== undefined && (
                  <span className="cnote mono" title="Check">
                    <span className="sr-only">Check: </span>
                    {r.check}
                  </span>
                )}
                {r.evidence !== undefined && (
                  <span className="cnote pre" title="Evidence">
                    <span className="sr-only">Evidence: </span>
                    {r.evidence}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {approval.show && (
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || approval.disabled}
              aria-describedby={approval.reasons.length ? 'approve-why' : undefined}
              onClick={doApprove}
            >
              Approve spec
            </button>
            <button ref={askBtn} type="button" className="btn ghost" disabled={busy || asking} onClick={() => (setAsking(true), setSent(false))}>
              Request changes
            </button>
            {d.wipWarning && <span className="wa" role="status">{d.wipWarning}</span>}
          </div>
        )}
        {approval.show && approval.reasons.length > 0 && (
          <div id="approve-why" className="mu small whynot">
            Approval needs:
            <ul>
              {approval.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}
        {warn && <p className="wa" role="status">{warn}</p>}
        {approveError && <p className="ko" role="alert">{approveError}</p>}
        {sent && <p className="ok" role="status">Change request sent</p>}
        {asking && (
          <RequestChanges
            id={d.id}
            onDone={() => {
              closeAsking();
              setSent(true);
              onApproved();
            }}
            onCancel={closeAsking}
          />
        )}
      </div>
      <div className="section">
        <h4>Spec · {d.specFormat}</h4>
        {d.design?.trim() ? <Clamped text={d.design} lines={DESIGN_LINES} pre /> : <p className="none">No spec written yet.</p>}
      </div>
    </>
  );
}

function RequestChanges({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const field = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = requestChangesProblem(note);
    if (problem) return setError(problem);
    setBusy(true);
    requestChanges(id, note.trim()).then(onDone, (err) => {
      setBusy(false);
      setError(messageOf(err));
    });
  };
  return (
    <form onSubmit={submit} noValidate aria-busy={busy}>
      <label className="lbl" htmlFor={field}>Change request note</label>
      <textarea
        className="dtext"
        id={field}
        value={note}
        onChange={(e) => (setNote(e.target.value), setError(undefined))}
        rows={4}
        maxLength={NOTE_MAX}
        placeholder="What should change in the spec or the criteria"
        aria-invalid={!!error}
        autoFocus
      />
      {error && <div className="ferr" role="alert">{error}</div>}
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Sending…' : 'Submit'}</button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function ActivityTab({ d }: { d: Detail }) {
  const comments = newestFirst(d.comments);
  if (comments.length === 0) return <p className="none">No comments yet.</p>;
  return (
    <table>
      <thead>
        <tr><th>When</th><th>Who</th><th>Comment</th></tr>
      </thead>
      <tbody>
        {comments.map((c) => (
          <tr key={c.id}>
            <td className="mu nowrap">{c.created_at.replace('T', ' ').slice(0, 16)}</td>
            <td className="mu">{c.author}</td>
            <td className="pre">{c.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** After Stop the process can take several seconds to end: past this the button comes back. */
const STOP_SLOW_MS = 15_000;

function SessionPane({
  d,
  list,
  onChanged,
  onStarted,
  onExpand,
}: {
  d: Detail;
  list: TerminalList | undefined;
  onChanged: () => void;
  /** Starting a session opens the panel. */
  onExpand: () => void;
  /** A terminal the server just started: shown at once, before the next fetch of the list. */
  onStarted: (t: TerminalInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [picked, setPicked] = useState<string>();
  const [focusId, setFocusId] = useState<string>();
  const [stopping, setStopping] = useState<string>();
  const [slow, setSlow] = useState(false);
  const [presses, setPresses] = useState(0);
  const [resumeId, setResumeId] = useState<string>();
  const resumeField = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const stopBtn = useRef<HTMLButtonElement>(null);
  const aside = useRef<HTMLElement>(null);

  const known = list !== undefined;
  const available = list?.available ?? false;
  const buttons = sessionButtons(d, list?.terminals ?? [], available, list?.reason);
  const mine = terminalsOf(list?.terminals ?? [], d.id);
  const active = mine.find((t) => t.id === picked) ?? mine[0];
  const resumeValue = buttons.resume.find((r) => r.sessionId === resumeId)?.sessionId ?? buttons.resume[0]?.sessionId;

  // Release goes back to Backlog: the same verdict as dropping the card there.
  const releaseVerdict = dropVerdict(d, 'backlog', buttons.stop !== undefined);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string>();
  const [releaseWarn, setReleaseWarn] = useState<string>();
  const doRelease = () => {
    setReleasing(true);
    setReleaseError(undefined);
    setReleaseWarn(undefined);
    // A 409 means the bead is no longer in Specify: say so, and refresh to show where it is now.
    releaseBead(d.id)
      .then(
        (r) => setReleaseWarn(r.warning),
        (e) => setReleaseError(messageOf(e)),
      )
      .then(onChanged)
      .finally(() => setReleasing(false));
  };

  const begin = (body: SessionBody) => {
    onExpand();
    setBusy(true);
    setProblem(undefined);
    startSession(d.id, body)
      .then(
        ({ terminal }) => {
          // In the list before `busy` clears, so the Start button does not flash back and invite a 409.
          onStarted(terminal);
          setPicked(terminal.id);
          setFocusId(terminal.id);
          onChanged();
        },
        (e) => setProblem(messageOf(e)),
      )
      .finally(() => setBusy(false));
  };
  const stop = (tid: string) => {
    setProblem(undefined);
    setSlow(false);
    setStopping(tid);
    // A new press restarts the slow timer, even when `stopping` keeps its value.
    setPresses((n) => n + 1);
    stopTerminal(tid).then(onChanged, (e) => {
      setStopping(undefined);
      setProblem(messageOf(e));
    });
  };
  // Stop is over once the terminal shows as exited or leaves the list. If it takes long, say so and let Stop be pressed again.
  const stoppingNow = stopping !== undefined && stopping === buttons.stop;
  useEffect(() => {
    if (stopping !== undefined && stopping !== buttons.stop) {
      setStopping(undefined);
      setSlow(false);
      setPresses(0);
    }
  }, [stopping, buttons.stop]);
  useEffect(() => {
    if (!stoppingNow) return;
    const timer = setTimeout(() => setSlow(true), STOP_SLOW_MS);
    return () => clearTimeout(timer);
  }, [stoppingNow, presses]);
  /** Ctrl+Shift+F6 in the terminal: focus goes to the tab list, else Stop, else the first control of the pane. Disabled ones are skipped. */
  const leaveTerminal = () => {
    firstEnabled<HTMLButtonElement | HTMLSelectElement>([
      tabs.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]'),
      stopBtn.current,
      aside.current?.querySelector<HTMLButtonElement | HTMLSelectElement>('button:not(:disabled), select:not(:disabled)'),
    ])?.focus();
  };

  return (
    <aside ref={aside} className="session">
      <h4>Session</h4>
      {(!known || buttons.fallback !== undefined) && <CopyCommand command={d.command} reason={known ? buttons.fallback : undefined} />}
      {d.stage === 'specify' && (
        <div className="actions">
          <button type="button" className="btn ghost" disabled={busy || releasing || !known || !releaseVerdict.ok} onClick={doRelease}>
            {releasing ? 'Releasing…' : 'Release'}
          </button>
          {!known ? <span className="mu">Checking…</span> : !releaseVerdict.ok && releaseVerdict.reason && <span className="mu">{releaseVerdict.reason}</span>}
          {releaseError && <span className="ko" role="alert">{releaseError}</span>}
        </div>
      )}
      {/* Outside the Specify block: after a release the bead is in Backlog and the block is gone. */}
      {releaseWarn && <p className="wa" role="status">{releaseWarn}</p>}
      {known && liveElsewhere(d, list.terminals, d.id) && <p className="mu small">The tracker lists a live session for this bead that is not in this cockpit.</p>}
      {known && available && (
        <>
          <div className="actions">
            {buttons.specify && (
              <button type="button" className="btn" disabled={busy} onClick={() => begin({ mode: 'specify' })}>Start specifying</button>
            )}
            {buttons.start && (
              <button type="button" className={buttons.specify ? 'btn ghost' : 'btn'} disabled={busy} onClick={() => begin({ mode: 'work' })}>
                Start session
              </button>
            )}
            {buttons.stop && (
              <button ref={stopBtn} type="button" className="btn ghost" disabled={stoppingNow && !slow} onClick={() => stop(buttons.stop!)}>
                {stoppingNow && !slow ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {stoppingNow && slow && (
              <span className="wa" role="status">
                {presses > 1 ? 'Still stopping. If it does not end, restart the cockpit.' : 'Still stopping. Press Stop again to end it.'}
              </span>
            )}
          </div>
          {buttons.resume.length > 0 && resumeValue && (
            <div className="actions">
              <label className="lbl" htmlFor={resumeField}>Resume</label>
              <select id={resumeField} value={resumeValue} onChange={(e) => setResumeId(e.target.value)}>
                {buttons.resume.map((r) => (
                  <option key={r.sessionId} value={r.sessionId}>{r.label}</option>
                ))}
              </select>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => begin({ mode: 'resume', sessionId: resumeValue })}>
                Resume
              </button>
            </div>
          )}
          {problem && <p className="ko" role="alert">{problem}</p>}
          {mine.length > 1 && (
            <div ref={tabs} className="termtabs" role="group" aria-label="Terminals of this bead">
              {mine.map((t) => (
                <button key={t.id} type="button" className={`sbtn${t.id === active?.id ? ' on' : ''}`} aria-pressed={t.id === active?.id} onClick={() => setPicked(t.id)}>
                  {t.mode} {timeOf(t.startedAt)}
                  {t.exited ? ' (ended)' : ''}
                </button>
              ))}
            </div>
          )}
          {active ? (
            <TerminalBoundary command={d.command}>
              <Suspense fallback={<p className="mu">Loading terminal…</p>}>
                <TerminalPane
                  key={active.id}
                  terminalId={active.id}
                  label={`Terminal for ${d.id}`}
                  focus={focusId === active.id}
                  onEnded={onChanged}
                  onLeave={leaveTerminal}
                />
              </Suspense>
            </TerminalBoundary>
          ) : (
            <p className="none">No terminal open for this bead.</p>
          )}
        </>
      )}
      <h4>Sessions</h4>
      {d.sessions.length === 0 && <p className="none">No sessions recorded.</p>}
      {d.sessions.map((s) => (
        <div key={s.sessionId} className="srow">
          <span className="mono">{s.sessionId}</span>
          <span className="mu">{s.startedAt.replace('T', ' ').slice(0, 16)}</span>
          <span className={s.endedAt ? 'mu' : 'ok'}>{s.endedAt ? (s.archived ? 'archived' : 'ended') : 'live'}</span>
        </div>
      ))}
    </aside>
  );
}
