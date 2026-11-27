import { buildTrackDeps, runHook } from './runtime.ts';
import { onPostToolUse } from './track.ts';

await runHook((input) => onPostToolUse(input, buildTrackDeps(process.env)), 'PostToolUse');
