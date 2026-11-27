import { onNotification } from './needs-you.ts';
import { buildGateDeps, runHook } from './runtime.ts';

// Only the config is loaded: no bd call, no network, no git.
await runHook((input) => onNotification(input, buildGateDeps(process.env)), 'Notification');
