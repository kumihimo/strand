import { buildGateDeps, runHook } from './runtime.ts';
import { onPreToolUse } from './gate.ts';

await runHook((input) => onPreToolUse(input, buildGateDeps(process.env)), 'PreToolUse');
