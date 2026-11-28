declare module '*.css';

/** The desktop app's receive-only menu hook (electron/preload.cjs, ADR 0030); absent in a browser tab. */
interface Window {
  strandMenu?: { onCommand(cb: (command: string) => void): () => void };
}
