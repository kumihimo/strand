declare module '*.css';
declare module '*.png' {
  const url: string;
  export default url;
}

/** The desktop app's receive-only menu hook (electron/preload.cjs, ADR 0030); absent in a browser tab. */
interface Window {
  strandMenu?: { onCommand(cb: (command: string) => void): () => void; run(name: string): void };
}
