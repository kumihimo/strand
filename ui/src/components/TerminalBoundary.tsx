import { Component, type ReactNode } from 'react';
import { CopyCommand } from './CopyCommand.tsx';
import { Button } from './ui/button.tsx';

type P = { command: string; children: ReactNode };
type S = { failed: boolean };

/**
 * Keeps a terminal that cannot load (the lazy xterm chunk is gone after a rebuild) from blanking the whole app.
 * Local to the terminal pane: the rest of the bead detail stays up.
 */
export class TerminalBoundary extends Component<P, S> {
  state: S = { failed: false };

  static getDerivedStateFromError(): S {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert">
        <p className="mb-2 text-destructive">Could not load the terminal. Reload the page.</p>
        <p className="mb-2">
          <Button type="button" onClick={() => location.reload()}>Reload</Button>
        </p>
        <CopyCommand command={this.props.command} />
      </div>
    );
  }
}
