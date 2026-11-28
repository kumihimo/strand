import { useState } from 'react';
import type { ArtefactFile, ArtefactList } from '../../../src/cockpit/model.ts';
import { artefactUrl, openTarget } from '../api.ts';
import { cn } from 'cn';
import { defaultPreview, formatSize, openResultText, previewKind } from '../lib/detail.ts';
import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';

type P = { beadId: string; artefacts: ArtefactList; onError: (e: unknown) => void };

function Thumb({ beadId, f }: { beadId: string; f: ArtefactFile }) {
  return (
    <div className="thumb">
      <span className="absolute top-1.5 left-1.5 rounded bg-background/80 px-1.5 font-mono text-[10px] text-muted-foreground">{f.kind}</span>
      {previewKind(f) === 'image' ? (
        <img src={artefactUrl(beadId, f.relPath)} alt="" loading="lazy" />
      ) : (
        <span className="font-mono text-muted-foreground">{f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')) : f.kind}</span>
      )}
    </div>
  );
}

export function Artefacts({ beadId, artefacts, onError }: P) {
  const [picked, setPicked] = useState<string>();
  const [result, setResult] = useState<string>();
  const all = [...artefacts.kept, ...artefacts.scratch];
  const cur = all.find((f) => f.relPath === picked && previewKind(f)) ?? defaultPreview(artefacts);

  const open = (f: ArtefactFile) => {
    setResult(undefined);
    openTarget({ path: f.relPath, beadId }).then((r) => setResult(openResultText(r, f.name)), onError);
  };

  const tile = (f: ArtefactFile) => (
    <Card key={f.relPath} size="sm" className={cn('gap-0 py-0', cur?.relPath === f.relPath && 'ring-2 ring-primary')}>
      <button type="button" className="block w-full cursor-pointer text-left disabled:cursor-default" disabled={!previewKind(f)} onClick={() => setPicked(f.relPath)} title={previewKind(f) ? `Preview ${f.name}` : undefined}>
        <Thumb beadId={beadId} f={f} />
        <div className="truncate px-2 pt-1.5 pb-0.5 font-mono text-xs" title={f.name}>{f.name}</div>
        <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">{formatSize(f.size)}</div>
      </button>
      <div className="flex gap-1 px-2 pb-2">
        <Button type="button" variant="outline" size="xs" onClick={() => open(f)}>Open</Button>
      </div>
    </Card>
  );

  const empty = all.length === 0 && artefacts.transcripts.length === 0;
  const kind = cur && previewKind(cur);
  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">artefacts/{beadId}/</span>
        {result && <span className="text-muted-foreground" role="status">{result}</span>}
      </div>
      {empty && (
        <p className="text-xs text-muted-foreground">
          No artefacts yet. Claude saves mockups, screenshots and recordings here as it works; iterations go to <span className="font-mono">scratch/</span>.
        </p>
      )}
      {cur && kind && (
        <Card size="sm" className="mb-3 gap-0 py-0">
          <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-xs">
            <b className="font-mono">{cur.relPath}</b>
            <span className="text-muted-foreground">{formatSize(cur.size)}</span>
            <span className="spacer" />
            <Button type="button" variant="outline" size="xs" onClick={() => open(cur)}>Open</Button>
          </div>
          <div className="preview-body">
            {kind === 'image' ? (
              <img src={artefactUrl(beadId, cur.relPath)} alt={cur.name} />
            ) : (
              <iframe sandbox="" src={artefactUrl(beadId, cur.relPath)} title={`Preview of ${cur.name}`} />
            )}
          </div>
        </Card>
      )}
      {!empty && (
        <>
          <div className="mb-2">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Kept ({artefacts.kept.length})</h4>
            {artefacts.kept.length ? <div className="tiles">{artefacts.kept.map(tile)}</div> : <span className="text-xs text-muted-foreground">None.</span>}
          </div>
          <div className="mb-2">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Scratch · iterations ({artefacts.scratch.length})</h4>
            {artefacts.scratch.length ? <div className="tiles">{artefacts.scratch.map(tile)}</div> : <span className="text-xs text-muted-foreground">Empty.</span>}
          </div>
          <div className="mb-2">
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sessions · archived transcripts ({artefacts.transcripts.length})</h4>
            {artefacts.transcripts.length === 0 && <span className="text-xs text-muted-foreground">None archived yet.</span>}
            {artefacts.transcripts.map((f) => (
              <div key={f.relPath} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b py-1.5 text-[12.5px]">
                <span className="truncate font-mono">{f.relPath}</span>
                <span className="text-muted-foreground">{formatSize(f.size)}</span>
                <Button type="button" variant="outline" size="xs" onClick={() => open(f)}>Open</Button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
