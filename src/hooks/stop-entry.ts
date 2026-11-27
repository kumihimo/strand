import { buildDeps, runHook } from './common.ts';
import { onStop } from './stop.ts';

await runHook((input) => onStop(input, buildDeps(process.env)), 'Stop');
