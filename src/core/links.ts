// The one rule for a link that leaves the cockpit for the default browser. Pure: no Node imports, so the UI
// (the terminal pane) and the desktop app's main process share it.

/** Longer links are refused rather than passed to the OS. */
const MAX_LENGTH = 8192;

/**
 * The normalised URL when `raw` is an http or https URL with a host and no credentials; otherwise undefined.
 * Fail closed: anything that does not parse, any other scheme (file:, javascript:, data:, custom protocols)
 * and anything that is not a string is refused.
 */
export function externalUrl(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.hostname === '' || u.username !== '' || u.password !== '') return undefined;
  return u.href;
}
