// Test helper, run as its own process: writes one binding or handover many times.
// Usage: node binding-writer.ts <trackerDir> <binding|handover> <count>
import { writeBinding, writeHandover } from '../../src/core/binding.ts';

const [trackerDir, kind, count] = process.argv.slice(2);
try {
  for (let i = 0; i < Number(count); i++) {
    if (kind === 'handover') writeHandover(trackerDir!, { cwd: 'C:\\dev\\svc', bead: `t-${i}`, at: new Date().toISOString() });
    else writeBinding(trackerDir!, 's1', { bead: `t-${process.pid}-${i}` });
  }
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
