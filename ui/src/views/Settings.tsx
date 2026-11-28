import { useEffect, useMemo, useState } from 'react';
import type { SettingField } from '../../../src/core/settings.ts';
import { ApiError, getSettings, saveSettings, type Settings } from '../api.ts';
import { notifyChanged } from '../changes.ts';
import { Alert, AlertDescription } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardContent } from '../components/ui/card.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select.tsx';
import { draftOf, hintsOf, patchOf, placeholderOf } from '../lib/settings.ts';
import { SetupView } from './Setup.tsx';
import { useApi } from '../useApi.ts';

/** Fields grouped as the screen shows them. */
const GROUPS: [string, string[]][] = [
  ['Folders', ['workspaceRoot', 'trackerDir', 'docsRepo']],
  ['Work in progress', ['wip.build', 'wip.review', 'wip.mode']],
  ['Claude Code', ['claudePath', 'claudeModel', 'claudeEffort']],
  ['Git and forge', ['branchPrefix', 'giteaUrl', 'artefactsVcs', 'butPath', 'ghPath']],
  ['Cockpit', ['cockpit.window', 'cockpit.maxSessions']],
];

const idOf = (key: string) => `set-${key.replace('.', '-')}`;

function Control({ f, value, onChange, error }: { f: SettingField; value: string; onChange: (v: string) => void; error?: string }) {
  const id = idOf(f.key);
  const describedBy = [error ? `${id}-err` : '', hintsOf(f).length ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  const common = { id, disabled: !!f.envVar, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy };
  if (f.kind === 'choice') {
    return (
      <NativeSelect className="w-full" {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">{f.effective !== undefined && !f.file ? `Default (${String(f.effective)})` : 'Default'}</NativeSelectOption>
        {(f.choices ?? []).map((c) => <NativeSelectOption key={c} value={c}>{c}</NativeSelectOption>)}
      </NativeSelect>
    );
  }
  return (
    <Input
      {...common}
      type={f.kind === 'number' ? 'number' : 'text'}
      inputMode={f.kind === 'number' ? 'numeric' : undefined}
      spellCheck={false}
      className={f.kind === 'path' || f.kind === 'url' ? 'font-mono text-[12.5px]' : undefined}
      value={value}
      placeholder={placeholderOf(f)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function SettingsView({ onError }: { onError: (e: unknown) => void }) {
  const { data } = useApi(getSettings, 'settings', onError);
  const [current, setCurrent] = useState<Settings>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string>();

  useEffect(() => {
    if (!data) return;
    setCurrent(data);
    setDraft(draftOf(data.fields));
  }, [data]);

  const patch = useMemo(() => (current ? patchOf(current.fields, draft) : {}), [current, draft]);
  const changed = Object.keys(patch).length > 0;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setSaved(undefined);
    try {
      const next = await saveSettings(patch);
      setCurrent(next);
      setDraft(draftOf(next.fields));
      setErrors({});
      setSaved(`Saved to ${next.path}`);
      notifyChanged();
    } catch (err) {
      if (err instanceof ApiError && err.fields && Object.keys(err.fields).length) setErrors(err.fields);
      else onError(err);
    } finally {
      setSaving(false);
    }
  };

  const byKey = new Map((current?.fields ?? []).map((f) => [f.key, f]));

  return (
    <section aria-label="Settings" aria-busy={!current} className="max-w-3xl">
      <h2 className="mb-3 text-lg font-semibold">Settings</h2>
      <SetupView onError={onError} />
      <h3 className="mb-1 text-base font-semibold">Configuration</h3>
      <p className="mb-3.5 text-muted-foreground">
        Saved to <code className="font-mono text-[12.5px]">{current?.path ?? 'config.json'}</code>. An empty field uses the default shown in it.
      </p>
      {!current && <p className="text-xs text-muted-foreground">Loading…</p>}
      {current && (
        <form onSubmit={save} noValidate>
          {GROUPS.map(([title, keys]) => (
            <Card key={title} className="mb-3 gap-0 py-3">
              <CardContent className="px-4">
                <h3 className="mb-2 text-sm font-semibold">{title}</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {keys.map((key) => {
                    const f = byKey.get(key);
                    if (!f) return null;
                    const id = idOf(key);
                    const hints = hintsOf(f);
                    return (
                      <div key={key} className={f.kind === 'path' || f.kind === 'url' ? 'sm:col-span-2' : undefined}>
                        <Label htmlFor={id} className="mb-1">{f.label}</Label>
                        <Control
                          f={f}
                          value={draft[key] ?? ''}
                          error={errors[key]}
                          onChange={(v) => {
                            setDraft((d) => ({ ...d, [key]: v }));
                            setSaved(undefined);
                          }}
                        />
                        {errors[key] && <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-destructive">{f.label} {errors[key]}.</p>}
                        {hints.length > 0 && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hints.join(' ')}</p>}
                      </div>
                    );
                  })}
                </div>
                {title === 'Git and forge' && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Gitea token: {current.giteaToken ? 'in use' : 'none in use'}. It is kept in the OS keychain, not here.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!changed || saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button
              type="button"
              variant="outline"
              disabled={!changed || saving}
              onClick={() => {
                setDraft(draftOf(current.fields));
                setErrors({});
              }}
            >
              Discard changes
            </Button>
            {saved && <span role="status" className="text-xs text-muted-foreground">{saved}</span>}
          </div>
          {Object.keys(errors).length > 0 && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription className="text-destructive">Nothing was saved. Fix the fields marked above.</AlertDescription>
            </Alert>
          )}
        </form>
      )}
    </section>
  );
}
