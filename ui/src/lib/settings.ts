import type { SettingField } from '../../../src/core/settings.ts';

/** The form's text per field: the file value, or the value in force for a field the env sets (shown read-only). */
export function draftOf(fields: readonly SettingField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = f.envVar ? f.effective : f.file;
    out[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** Shown in an empty field: the value that applies when the file has none. */
export function placeholderOf(f: SettingField): string {
  return f.file === undefined && f.effective !== undefined ? String(f.effective) : '';
}

/**
 * The PUT body: only fields the engineer changed, never one the env sets. An emptied field is sent as `''`, which
 * removes it from the file. A number field sends a number when its text parses, else the text, so the server
 * names the problem.
 */
export function patchOf(fields: readonly SettingField[], draft: Record<string, string>): Record<string, unknown> {
  const before = draftOf(fields);
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.envVar) continue;
    const text = draft[f.key] ?? '';
    if (text === before[f.key]) continue;
    if (f.kind === 'number') {
      const t = text.trim();
      patch[f.key] = t === '' ? '' : /^-?\d+$/.test(t) ? Number(t) : text;
    } else patch[f.key] = text;
  }
  return patch;
}

/** The notes under a field. */
export function hintsOf(f: SettingField): string[] {
  const out: string[] = [];
  if (f.envVar) out.push(`Set by ${f.envVar}; unset it to change it here.`);
  if (f.restart) out.push('Applies after the cockpit restarts.');
  if (f.key === 'claudePath') out.push('The full path to the claude program. Empty finds claude on PATH.');
  if (f.key === 'artefactsVcs') out.push('Changing this does not move or convert the artefacts already in the tracker.');
  if (f.key === 'trackerDir' || f.key === 'docsRepo') out.push('Empty uses a folder under the workspace.');
  return out;
}
