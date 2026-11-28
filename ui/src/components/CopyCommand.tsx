import { useRef, useState } from 'react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

/** The copyable `strand work <id>` command: what the pane shows when terminals are unavailable or cannot load. */
export function CopyCommand({ command, reason }: { command: string; reason?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<string>();
  const copy = () => {
    const select = () => {
      ref.current?.focus();
      ref.current?.select();
      setCopied('Selected. Press Ctrl+C or ⌘C to copy.');
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(command).then(() => setCopied('Copied'), select);
    else select();
  };
  return (
    <>
      <p className="mb-2 text-muted-foreground">Run in a terminal to start a Claude Code session on this bead:</p>
      <div className="mb-2 flex gap-2">
        <Input ref={ref} className="min-w-0 flex-1 bg-background font-mono" readOnly value={command} aria-label="Start session command" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" onClick={copy}>Copy</Button>
      </div>
      {copied && <p className="mb-2 text-muted-foreground" role="status">{copied}</p>}
      {reason && <p className="mb-2 text-muted-foreground">Terminal unavailable: {reason}</p>}
    </>
  );
}
