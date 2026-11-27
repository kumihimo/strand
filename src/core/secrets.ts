import { Entry } from '@napi-rs/keyring';

const SERVICE = 'strand';
/** The keychain service before the rename to Strand (ADR 0021): read when `strand` has no entry. */
const LEGACY_SERVICE = 'sdlc';
const ACCOUNT = 'gitea-token';

/** The OS keychain, behind a seam so tests never touch the real one. `get` gives null when there is no entry. */
export type Keyring = {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
};

const osKeyring: Keyring = {
  get: (service, account) => new Entry(service, account).getPassword() ?? null,
  set: (service, account, value) => new Entry(service, account).setPassword(value),
};

/**
 * Gitea token: `STRAND_GITEA_TOKEN`, then `SDLC_GITEA_TOKEN`, then the keychain's `strand` entry. With no
 * `strand` entry the old `sdlc` one is read and copied under `strand`; the old entry is kept. Undefined if absent
 * or the keychain is unavailable.
 */
export function getGiteaToken(env: NodeJS.ProcessEnv = process.env, keyring: Keyring = osKeyring): string | undefined {
  const fromEnv = env.STRAND_GITEA_TOKEN || env.SDLC_GITEA_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const current = keyring.get(SERVICE, ACCOUNT);
    if (current) return current;
    const legacy = keyring.get(LEGACY_SERVICE, ACCOUNT);
    if (!legacy) return undefined;
    try {
      keyring.set(SERVICE, ACCOUNT, legacy);
    } catch {
      // The copy is a convenience: the old entry still answers next time.
    }
    return legacy;
  } catch {
    return undefined;
  }
}

export function setGiteaToken(token: string, keyring: Keyring = osKeyring): void {
  keyring.set(SERVICE, ACCOUNT, token);
}
