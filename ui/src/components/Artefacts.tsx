import { useState } from 'react';
import type { ArtefactFile, ArtefactList } from '../../../src/cockpit/model.ts';
import { artefactUrl, openTarget } from '../api.ts';
import { defaultPreview, formatSize, openResultText, previewKind } from '../lib/detail.ts';

type P = { beadId: string; artefacts: ArtefactList; onError: (e: unknown) => void };

function Thumb({ beadId, f }: { beadId: string; f: ArtefactFile }) {
  return (
    <div className="thumb">
      <span className="kind">{f.kind}</span>
      {previewKind(f) === 'image' ? (
        <img src={artefactUrl(beadId, f.relPath)} alt="" loading="lazy" />
      ) : (
        <span className="mu mono">{f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.')) : f.kind}</span>
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
    <div key={f.relPath} className={`tile${cur?.relPath === f.relPath ? ' on' : ''}`}>
      <button type="button" className="tilepick" disabled={!previewKind(f)} onClick={() => setPicked(f.relPath)} title={previewKind(f) ? `Preview ${f.name}` : undefined}>
        <Thumb beadId={beadId} f={f} />
        <div className="nm" title={f.name}>{f.name}</div>
        <div className="sz">{formatSize(f.size)}</div>
      </button>
      <div className="tileacts">
        <button type="button" className="sbtn" onClick={() => open(f)}>Open</button>
      </div>
    </div>
  );

  const empty = all.length === 0 && artefacts.transcripts.length === 0;
  const kind = cur && previewKind(cur);
  return (
    <>
      <div className="art-tools">
        <span className="path mono">artefacts/{beadId}/</span>
        {result && <span className="mu" role="status">{result}</span>}
      </div>
      {empty && (
        <p className="none">
          No artefacts yet. Claude saves mockups, screenshots and recordings here as it works; iterations go to <span className="mono">scratch/</span>.
        </p>
      )}
      {cur && kind && (
        <div className="preview">
          <div className="ph">
            <b className="mono">{cur.relPath}</b>
            <span className="mu">{formatSize(cur.size)}</span>
            <span className="spacer" />
            <button type="button" className="sbtn" onClick={() => open(cur)}>Open</button>
          </div>
          <div className="pb">
            {kind === 'image' ? (
              <img src={artefactUrl(beadId, cur.relPath)} alt={cur.name} />
            ) : (
              <iframe sandbox="" src={artefactUrl(beadId, cur.relPath)} title={`Preview of ${cur.name}`} />
            )}
          </div>
        </div>
      )}
      {!empty && (
        <>
          <div className="section">
            <h4>Kept ({artefacts.kept.length})</h4>
            {artefacts.kept.length ? <div className="grid">{artefacts.kept.map(tile)}</div> : <span className="none">None.</span>}
          </div>
          <div className="section">
            <h4>Scratch · iterations ({artefacts.scratch.length})</h4>
            {artefacts.scratch.length ? <div className="grid">{artefacts.scratch.map(tile)}</div> : <span className="none">Empty.</span>}
          </div>
          <div className="section">
            <h4>Sessions · archived transcripts ({artefacts.transcripts.length})</h4>
            {artefacts.transcripts.length === 0 && <span className="none">None archived yet.</span>}
            {artefacts.transcripts.map((f) => (
              <div key={f.relPath} className="srow">
                <span className="mono">{f.relPath}</span>
                <span className="mu">{formatSize(f.size)}</span>
                <button type="button" className="sbtn" onClick={() => open(f)}>Open</button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
