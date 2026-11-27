import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickForge, type Forge } from '../src/core/forge.ts';

const stub = (name: Forge['name']): Forge => ({
  name,
  findPullForBranch: async () => undefined,
  ciState: async () => 'none',
  createPull: async () => {
    throw new Error('unused');
  },
});

test('pickForge chooses by host', () => {
  const gitea = stub('Gitea');
  const github = stub('GitHub');
  const o = { giteaUrl: 'https://git.example.com', gitea, github };
  assert.equal(pickForge('github.com', o), github);
  assert.equal(pickForge('GIT.example.com'.toLowerCase(), o), gitea);
  assert.equal(pickForge(undefined, o), gitea, 'an unknown host keeps the Gitea behaviour');
  assert.equal(pickForge('review.example.org', o), undefined);
  assert.equal(pickForge('github.com', { giteaUrl: o.giteaUrl, gitea }), undefined);
});

test('pickForge matches the Gitea host whatever the case of the configured URL', () => {
  const gitea = stub('Gitea');
  assert.equal(pickForge('git.example.com', { giteaUrl: 'https://GIT.Example.com:3000/', gitea }), gitea);
  assert.equal(pickForge('git.example.com', { gitea }), gitea, 'no Gitea URL: a given Gitea client answers for any host but github.com');
  assert.equal(pickForge('git.example.com', {}), undefined);
});
