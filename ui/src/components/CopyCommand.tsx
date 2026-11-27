import { useRef, useState } from 'react';

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
      <p className="mu">Run in a terminal to start a Claude Code session on this bead:</p>
      <div className="cmd">
        <input ref={ref} className="mono" readOnly value={command} aria-label="Start session command" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn" onClick={copy}>Copy</button>
      </div>
      {copied && <p className="mu" role="status">{copied}</p>}
      {reason && <p className="mu">Terminal unavailable: {reason}</p>}
    </>
  );
}
