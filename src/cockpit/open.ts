export type TargetOpener = (target: string) => Promise<unknown> | unknown;

/** Open a path or URL in the OS default app. A missing launcher (no xdg-open) is an async 'error' on the child, not a rejection. */
export async function openTarget(target: string, opener?: TargetOpener): Promise<void> {
  const launch: TargetOpener = opener ?? (async (t) => (await import('open')).default(t, { wait: false }));
  const watched = new WeakSet<object>();
  const watch = (child: unknown) => {
    if (child && typeof (child as { on?: unknown }).on === 'function' && !watched.has(child)) {
      watched.add(child);
      (child as NodeJS.EventEmitter).on('error', () => {});
    }
  };
  const result = launch(target);
  watch(result);
  watch(await result);
}
