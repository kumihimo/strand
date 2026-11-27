import { buildDeps, runHook } from './common.ts';
import { onSessionStart } from './session.ts';

await runHook((input) => onSessionStart(input, buildDeps(process.env), process.env), 'SessionStart');
