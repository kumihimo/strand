import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGiteaToken, setGiteaToken } from '../src/core/secrets.ts';
import type { Keyring } from '../src/core/secrets.ts';

/** An in-memory keyring keyed by `service/account`; `fail` makes every call throw, like a locked keychain. */
function memory(seed: Record<string, string> = {}, fail = false): Keyring & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get(service, account) {
      if (fail) throw new Error('locked');
      return store.get(`${service}/${account}`) ?? null;
    },
    set(service, account, value) {
      if (fail) throw new Error('locked');
      store.set(`${service}/${account}`, value);
    },
  };
}

test('the token is read from the strand service', () => {
  const k = memory({ 'strand/gitea-token': 'new', 'sdlc/gitea-token': 'old' });
  assert.equal(getGiteaToken({}, k), 'new');
});

test('with no strand entry the sdlc entry is read, written under strand and left in place', () => {
  const k = memory({ 'sdlc/gitea-token': 'old' });
  assert.equal(getGiteaToken({}, k), 'old');
  assert.equal(k.store.get('strand/gitea-token'), 'old');
  assert.equal(k.store.get('sdlc/gitea-token'), 'old');
});

test('STRAND_GITEA_TOKEN wins, then SDLC_GITEA_TOKEN, before the keychain', () => {
  const k = memory({ 'strand/gitea-token': 'kc' });
  assert.equal(getGiteaToken({ STRAND_GITEA_TOKEN: 'a', SDLC_GITEA_TOKEN: 'b' }, k), 'a');
  assert.equal(getGiteaToken({ SDLC_GITEA_TOKEN: 'b' }, k), 'b');
});

test('no entry, or an unavailable keychain, gives undefined', () => {
  assert.equal(getGiteaToken({}, memory()), undefined);
  assert.equal(getGiteaToken({}, memory({}, true)), undefined);
});

test('a failed copy to strand still returns the old token', () => {
  const k = memory({ 'sdlc/gitea-token': 'old' });
  const ro: Keyring = { get: k.get, set: () => { throw new Error('read only'); } };
  assert.equal(getGiteaToken({}, ro), 'old');
});

test('setGiteaToken writes under strand only', () => {
  const k = memory();
  setGiteaToken('t', k);
  assert.deepEqual([...k.store], [['strand/gitea-token', 't']]);
});
