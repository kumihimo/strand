// The "needs you" mark on the session index entry: set when a session stops and waits for the engineer,
// cleared when it works again. The cockpit shows it on the bead's card.
// Nothing here throws (ADR 0014): an error goes to stderr and the hook's own work goes on.
// No bd call, no network, no git: one small file read, and a write only when the mark changes.
import { clearNeedsYou, markNeedsYou } from '../core/sessions.ts';

/** `trackerDir` may be a getter that loads the config, so it is read inside the try. */
type Where = { trackerDir: string };

function log(event: string, e: unknown): void {
  process.stderr.write(`strand hook ${event}: needs-you mark: ${e instanceof Error ? e.message : String(e)}\n`);
}

/** The session waits for the engineer. A session with no index entry (no bead) is left alone. */
export function markWaiting(where: Where, sessionId: unknown, event: string): void {
  try {
    if (typeof sessionId === 'string' && sessionId) markNeedsYou(where.trackerDir, sessionId);
  } catch (e) {
    log(event, e);
  }
}

/** The session works again. */
export function clearWaiting(where: Where, sessionId: unknown, event: string): void {
  try {
    if (typeof sessionId === 'string' && sessionId) clearNeedsYou(where.trackerDir, sessionId);
  } catch (e) {
    log(event, e);
  }
}

export type NotificationInput = { session_id: string; notification_type?: string };

/**
 * Notices that do not ask the engineer for anything (the types in the Claude Code hooks reference).
 * The ones that do: permission_prompt, idle_prompt, elicitation_dialog, elicitation_url_dialog, agent_needs_input.
 * A type this list does not know marks the session: a spare marker costs less than a missed question.
 */
const NOT_WAITING = new Set([
  'auth_success',
  'auth_storage_failure',
  'elicitation_complete',
  'elicitation_response',
  'agent_completed',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
  'plugin_notification',
]);

/** Notification: Claude Code asks for permission, shows a dialog, or has been idle waiting for input. */
export async function onNotification(input: NotificationInput, where: Where): Promise<void> {
  if (typeof input?.notification_type === 'string' && NOT_WAITING.has(input.notification_type)) return;
  markWaiting(where, input?.session_id, 'Notification');
}
