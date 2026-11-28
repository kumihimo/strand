import { useCallback, useEffect, useState } from 'react';
import type { OfferedTool } from '../../../src/core/offered.ts';
import { getInstall, getSetup, startInstall, type InstallState, type SetupView as Setup } from '../api.ts';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Label } from '../components/ui/label.tsx';
import { rowOf, SKIP_KEY, type SetupRow } from '../lib/setup.ts';

const POLL_MS = 1000;

function skip(): void {
  try {
    sessionStorage.setItem(SKIP_KEY, '1');
  } catch {
    // Storage blocked: the Brief still opens, and Setup may show again on the next load.
  }
  location.hash = '#/brief';
}

/** One offered tool that is missing: its licence, source and what runs, a consent box and Install. */
function Offer({ row, busy, onInstall }: { row: SetupRow; busy: boolean; onInstall: (tool: OfferedTool) => void }) {
  const [agreed, setAgreed] = useState(false);
  const o = row.offer!;
  const id = `consent-${o.tool}`;
  return (
    <div className="mt-2 rounded-md border p-3" data-testid={`offer-${o.tool}`}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted-foreground">Licence</dt>
        <dd>
          <a href={o.licence.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{o.licence.name}</a>
        </dd>
        <dt className="text-muted-foreground">From</dt>
        <dd>{o.source}</dd>
        <dt className="text-muted-foreground">What runs</dt>
        <dd>{o.action}</dd>
      </dl>
      <div className="mt-2.5 flex items-start gap-2">
        <input id={id} type="checkbox" className="mt-0.5 size-4" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <Label htmlFor={id} className="leading-snug font-normal">
          I accept the {o.title} licence and agree that Strand runs this installer.
        </Label>
      </div>
      <Button type="button" className="mt-2.5" disabled={!agreed || busy} onClick={() => onInstall(o.tool)}>
        Install {o.title}
      </Button>
    </div>
  );
}

export function SetupView({ onError }: { onError: (e: unknown) => void }) {
  const [setup, setSetup] = useState<Setup>();
  const [install, setInstall] = useState<InstallState>();
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(() => {
    setChecking(true);
    getSetup()
      .then((s) => {
        setSetup(s);
        if (s.install) setInstall(s.install);
      }, onError)
      .finally(() => setChecking(false));
  }, [onError]);
  useEffect(refresh, [refresh]);

  // While an install runs, follow its log; when it ends, probe again.
  const running = install?.state === 'running';
  useEffect(() => {
    if (!running || !install) return;
    const tool = install.tool;
    const id = setInterval(() => {
      getInstall(tool).then((st) => {
        setInstall(st);
        if (st.state !== 'running') refresh();
      }, onError);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [running, install, refresh, onError]);

  const onInstall = (tool: OfferedTool) => {
    startInstall(tool).then((r) => setInstall(r.install), onError);
  };

  const rows = setup ? setup.tools.map((t) => rowOf(t, setup)) : [];
  const doneOffer = install && setup?.offers.find((o) => o.tool === install.tool);

  return (
    <section aria-label="Setup" aria-busy={!setup} className="max-w-3xl">
      <h2 className="mb-1 text-lg font-semibold">Set up Strand</h2>
      <p className="mb-3.5 text-muted-foreground">
        Strand works with these tools. It can install a missing one from its official source, once you accept its licence. It never signs in for you.
      </p>
      {!setup && <p className="text-xs text-muted-foreground">Checking your tools…</p>}
      {setup && (
        <>
          {setup.ready ? (
            <Alert className="mb-3">
              <AlertDescription>Every tool Strand needs is installed.</AlertDescription>
            </Alert>
          ) : null}
          <ul className="flex flex-col gap-3" aria-label="Tools">
            {rows.map((row) => (
              <li key={row.tool.name}>
                <Card className="gap-0 py-3">
                  <CardContent className="px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{row.offer?.title ?? row.tool.name}</h3>
                      <Badge variant={row.tool.status === 'ok' ? 'secondary' : 'destructive'}>{row.label}</Badge>
                      {!row.tool.required && <span className="text-xs text-muted-foreground">Needed for repos on GitHub</span>}
                    </div>
                    {row.tool.path && <p className="mt-1 font-mono text-[12px] text-muted-foreground">{row.tool.path}</p>}
                    {row.note && <p className="mt-1 text-[13px]">{row.note}</p>}
                    {row.install && <Offer row={row} busy={running} onInstall={onInstall} />}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
          {install && (
            <Card className="mt-3 gap-0 py-3" aria-live="polite">
              <CardContent className="px-4">
                <h3 className="text-sm font-semibold">
                  {install.state === 'running' ? `Installing ${doneOffer?.title ?? install.tool}…` : install.state === 'done' ? `${doneOffer?.title ?? install.tool} is installed` : `${doneOffer?.title ?? install.tool} did not install`}
                </h3>
                {install.state === 'failed' && <p role="alert" className="mt-1 text-[13px] text-destructive">{install.error}</p>}
                {install.state === 'done' && doneOffer && <p className="mt-1 text-[13px]">{doneOffer.after}</p>}
                {install.log.length > 0 && (
                  <pre className="mt-2 max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-[12px] whitespace-pre-wrap" data-testid="install-log">{install.log.join('\n')}</pre>
                )}
              </CardContent>
            </Card>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button type="button" variant="outline" disabled={checking || running} onClick={refresh}>{checking ? 'Checking…' : 'Check again'}</Button>
            <Button type="button" variant={setup.ready ? 'default' : 'ghost'} onClick={skip}>{setup.ready ? 'Go to the Brief' : 'Skip for now'}</Button>
          </div>
        </>
      )}
    </section>
  );
}
