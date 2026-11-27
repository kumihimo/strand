import { buildDeps, runHook } from './common.ts';
import { onUserPromptSubmit } from './prompt.ts';

await runHook((input) => onUserPromptSubmit(input, buildDeps(process.env), process.env), 'UserPromptSubmit');
