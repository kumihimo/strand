import type { Board, BeadCard, BeadDetail, Epic } from '../../src/cockpit/model.ts';
import type { SettingsView } from '../../src/core/settings.ts';
import type { InstallState, SetupView } from '../../src/cockpit/setup-routes.ts';
import type { OfferedTool } from '../../src/core/offered.ts';
import { ApiError, errorFromResponse } from './lib/errors.ts';
import type { Brief } from '../../src/cli/commands/brief.ts';
import type { TerminalInfo } from '../../src/cockpit/pty.ts';
import { socketUrl } from './lib/terminal.ts';

export { ApiError };

/** A 409 from an edit whose `version` is old: `current` is the bead as it is now. */
export class StaleBeadError extends ApiError {
  current: BeadDetail;
  constructor(message: string, current: BeadDetail) {
    super(409, message);
    this.name = 'StaleBeadError';
    this.current = current;
  }
}

export function staleFrom(status: number, text: string): StaleBeadError | undefined {
  if (status !== 409) return undefined;
  try {
    const b = JSON.parse(text) as { error?: unknown; current?: BeadDetail } | null;
    if (b?.current && typeof b.current === 'object') {
      return new StaleBeadError(typeof b.error === 'string' ? b.error : 'This bead changed since you opened it.', b.current);
    }
  } catch {
    // Not JSON: fall through to the plain error.
  }
  return undefined;
}

async function call<T>(path: string, init?: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown }): Promise<T> {
  let res: Response;
  const hasBody = init?.body !== undefined;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      method: init?.method ?? 'GET',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw errorFromResponse(0, e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  if (!res.ok) throw staleFrom(res.status, text) ?? errorFromResponse(res.status, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export type NewBead = {
  title: string;
  type: string;
  priority?: number;
  repo?: string;
  context?: string[];
  parent?: string;
  description?: string;
  acceptance?: string;
};
/** The repo folders under the workspace, as the server read them at `at`. */
export type RepoList = { repos: string[]; at: string };
export type CreatedBead = { id: string; title: string; type: string; priority: number; labels: string[] };

export const getBoard = () => call<Board>('/api/board');
export const getBead = (id: string) => call<BeadDetail>(`/api/beads/${enc(id)}`);
export const getEpics = () => call<Epic[]>('/api/epics');
export const getReview = () => call<BeadCard[]>('/api/review');
export const getBrief = () => call<Brief>('/api/brief');
export const getRepos = () => call<RepoList>('/api/repos');
/** Reads the workspace again. */
export const refreshRepos = () => call<RepoList>('/api/repos/refresh', { method: 'POST', body: {} });
/**
 * 200 { approved, warn? }; a 409 (closed, already approved, spec problems, WIP refused) throws an ApiError with the
 * server's message. With `version`, a bead that moved since is not approved: a StaleBeadError.
 */
export const approveSpec = (id: string, version?: string) =>
  call<{ approved: true; warn?: string }>(`/api/beads/${enc(id)}/approve`, { method: 'POST', body: version === undefined ? {} : { version } });
/** 200 { released, warning? }. `warning` says some session bindings were not cleared. A 409 (not in Specify any more, or a live session) throws an ApiError with the server's message. */
export const releaseBead = (id: string) => call<{ released: true; warning?: string }>(`/api/beads/${enc(id)}/release`, { method: 'POST', body: {} });
export const requestChanges = (id: string, note: string) =>
  call<{ ok: true }>(`/api/beads/${enc(id)}/request-changes`, { method: 'POST', body: { note } });
export const createBead = (input: NewBead) => call<CreatedBead>('/api/beads', { method: 'POST', body: input });
export type BeadEditBody = { version: string } & Partial<{
  title: string;
  description: string;
  acceptance: string;
  design: string;
  type: string;
  priority: number;
  parent: string;
  /** An empty string clears the primary repo. With `context`, it replaces the bead's repo labels. */
  repo: string;
  context: string[];
}>;
/** 200 { changed, rebaselined, warning? }. A stale `version` throws a StaleBeadError carrying the current bead; other refusals throw an ApiError. */
export const editBead = (id: string, body: BeadEditBody) =>
  call<{ changed: string[]; rebaselined: boolean; warning?: string }>(`/api/beads/${enc(id)}`, { method: 'PUT', body });
export const openTarget = (t: { path?: string; url?: string; beadId?: string }) =>
  call<unknown>('/api/open', { method: 'POST', body: t });
export type TerminalList = { available: boolean; reason?: string; terminals: TerminalInfo[] };
export type SessionBody = { mode: 'work' | 'specify' } | { mode: 'resume'; sessionId: string };
export const getTerminals = () => call<TerminalList>('/api/terminals');
/** 201 { terminal }. 404 (no repo folder), 409 (limit, or the bead has a live terminal) and 503 throw an ApiError with the server's message. */
export const startSession = (beadId: string, body: SessionBody) =>
  call<{ terminal: TerminalInfo }>(`/api/beads/${enc(beadId)}/session`, { method: 'POST', body });
/** 200 { stopping: true }: the call returns at once, the process may take a few seconds to end. */
export const stopTerminal = (tid: string) => call<{ stopping: true }>(`/api/terminals/${enc(tid)}`, { method: 'DELETE' });
export const terminalSocketUrl = (tid: string) => socketUrl(location, tid);
/** The work queue (ADR 0023): queued Backlog bead ids, front first. `available` is false without terminals. */
export type QueueState = { available: boolean; reason?: string; ids: string[] };
export const getQueue = () => call<QueueState>('/api/queue');
/** Appends Backlog beads in this order. 404 (unknown), 409 (not in Backlog) and 503 throw an ApiError. */
export const addToQueue = (ids: string[]) => call<{ ids: string[] }>('/api/queue', { method: 'POST', body: { ids } });
/** Reorders the queue; an id left out leaves it. 409 when the list names an id that is not queued. */
export const setQueueOrder = (ids: string[]) => call<{ ids: string[] }>('/api/queue', { method: 'PUT', body: { ids } });
export const removeFromQueue = (id: string) => call<{ ids: string[] }>(`/api/queue/${enc(id)}`, { method: 'DELETE' });
export const artefactUrl = (id: string, rel: string) => `/api/beads/${enc(id)}/artefact?rel=${enc(rel)}`;

export type Settings = SettingsView & { giteaToken: boolean };
export const getSettings = () => call<Settings>('/api/settings');
/** 200 with the saved settings. A 400 throws an ApiError whose `fields` holds a message per refused field; nothing was saved. */
export const saveSettings = (patch: Record<string, unknown>) => call<Settings>('/api/settings', { method: 'PUT', body: patch });

export type { InstallState, SetupView };
export const getSetup = () => call<SetupView>('/api/setup');
/** Start the official installer of a missing tool; `consent` is the ticked box beside its licence (ADR 0029). */
export const startInstall = (tool: OfferedTool) => call<{ install: InstallState }>('/api/setup/install', { method: 'POST', body: { tool, consent: true } });
export const getInstall = (tool: OfferedTool) => call<InstallState>(`/api/setup/install/${enc(tool)}`);
