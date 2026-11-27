import { buildDeps, runHook } from './common.ts';
import { onSessionEnd } from './session.ts';

await runHook((input) => onSessionEnd(input, buildDeps(process.env)), 'SessionEnd');
