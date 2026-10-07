import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, validate, resolve, find } from '../lib/manifest.mjs';

const TOOLBELT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const RISK = { read_only: true, destructive: false, idempotent: true, open_world: false, worst_case: 'none' };
function fixtureBelt(entries) {
  const root = mkdtempSync(path.join(tmpdir(), 'tb-belt-'));
  for (const m of entries) {
    const dir = path.join(root, `${m.kind}s`, m.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'toolbelt.json'), JSON.stringify({ description: 'd', platforms: ['darwin'], origin: {}, risk: RISK, ...m }));
  }
  return root;
}

test('discover finds this belt\'s manifests without errors (an empty belt is a valid belt)', () => {
  const { manifests, errors } = discover(TOOLBELT);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  for (const m of manifests) {
    assert.ok(m._dir, 'manifest carries its directory');
    assert.ok(['tool', 'connector', 'skill'].includes(m.kind));
  }
});

test('discover tolerates missing tools/ connectors/ skills/ directories', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'tb-empty-'));
  const { manifests, errors } = discover(empty);
  assert.deepEqual(manifests, []);
  assert.deepEqual(errors, []);
  rmSync(empty, { recursive: true, force: true });
});

test('validate catches missing fields', () => {
  assert.ok(validate({}).length > 0);
  assert.ok(validate({ name: 'x', kind: 'tool', description: 'd', platforms: ['darwin'] }).some((p) => p.includes('origin')));
  assert.ok(validate({ name: 'x', kind: 'bogus', description: 'd', platforms: ['darwin'], origin: {} }).some((p) => p.includes('kind')));
});

test('validate enforces name/dir agreement', () => {
  const m = { name: 'foo', kind: 'tool', description: 'd', platforms: ['darwin'], origin: {}, risk: { read_only: true, destructive: false, idempotent: true, open_world: false, worst_case: 'none' } };
  assert.ok(validate(m, 'bar').some((p) => p.includes('directory')));
  assert.equal(validate(m, 'foo').length, 0);
});

test('validate constrains aliases', () => {
  const base = { name: 'foo', kind: 'tool', description: 'd', platforms: ['darwin'], origin: {}, risk: { read_only: true, destructive: false, idempotent: true, open_world: false, worst_case: 'none' } };
  assert.equal(validate({ ...base, aliases: ['f', 'foo-tool'] }, 'foo').length, 0);
  assert.equal(validate({ ...base, aliases: [] }, 'foo').length, 0);
  assert.ok(validate({ ...base, aliases: 'f' }, 'foo').some((p) => p.includes('aliases')));
  assert.ok(validate({ ...base, aliases: [''] }, 'foo').some((p) => p.includes('aliases')));
  assert.ok(validate({ ...base, aliases: [3] }, 'foo').some((p) => p.includes('aliases')));
  // repeating the canonical name is redundant, and a sign of a copy-paste error
  assert.ok(validate({ ...base, aliases: ['foo'] }, 'foo').some((p) => p.includes('canonical')));
});

test('resolve prefers canonical names, then falls back to aliases', () => {
  const ms = [
    { name: 'alpha', aliases: ['a'] },
    { name: 'beta' },
    { name: 'gamma', aliases: ['beta-ish', 'g'] },
  ];
  assert.equal(resolve(ms, 'alpha').name, 'alpha');
  assert.equal(resolve(ms, 'a').name, 'alpha');
  assert.equal(resolve(ms, 'g').name, 'gamma');
  assert.equal(resolve(ms, 'beta').name, 'beta');
  assert.equal(resolve(ms, 'nope'), null);
  // a canonical name must beat any alias, whatever the manifest order
  assert.equal(resolve([{ name: 'x', aliases: ['y'] }, { name: 'y' }], 'y').name, 'y');
});

test('discover flags aliases that shadow or duplicate, and sorts tools before connectors before skills', () => {
  const root = fixtureBelt([
    { name: 'zeta', kind: 'tool', aliases: ['z'] },
    { name: 'alpha', kind: 'tool' },
    { name: 'hub', kind: 'connector' },
    { name: 'router', kind: 'skill', risk: undefined },
  ]);
  const { manifests, errors } = discover(root);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.deepEqual(manifests.map((m) => m.name), ['alpha', 'zeta', 'hub', 'router']);
  assert.equal(resolve(manifests, 'z').name, 'zeta');
  assert.equal(find(root, 'z').name, 'zeta');

  const shadow = fixtureBelt([{ name: 'a', kind: 'tool', aliases: ['b'] }, { name: 'b', kind: 'tool' }]);
  assert.ok(discover(shadow).errors.some((e) => e.error.includes('collides')));
  const dup = fixtureBelt([{ name: 'a', kind: 'tool', aliases: ['x'] }, { name: 'b', kind: 'tool', aliases: ['x'] }]);
  assert.ok(discover(dup).errors.some((e) => e.error.includes('already claimed')));
  for (const r of [root, shadow, dup]) rmSync(r, { recursive: true, force: true });
});

test('validate enforces the origin provenance block', () => {
  const base = { name: 'foo', kind: 'tool', description: 'd', platforms: ['darwin'], risk: { read_only: true, destructive: false, idempotent: true, open_world: false, worst_case: 'none' } };
  // origin block required; an empty object is the valid form for code authored here
  assert.ok(validate({ ...base }, 'foo').some((p) => p.includes('origin')));
  assert.ok(validate({ ...base, origin: 'https://x/y.git' }, 'foo').some((p) => p.includes('origin')));
  assert.equal(validate({ ...base, origin: {} }, 'foo').length, 0);
  // vendored code: repo + snapshot commit
  assert.equal(validate({ ...base, origin: { repo: 'https://x/y.git', vendored_commit: 'abc', vendored_at: '2026-06-04' } }, 'foo').length, 0);
  // a snapshot commit with nothing to compare against is a mistake
  assert.ok(validate({ ...base, origin: { vendored_commit: 'abc' } }, 'foo').some((p) => p.includes('vendored_commit')));
  // unknown keys are rejected (no sync machinery hides here)
  assert.ok(validate({ ...base, origin: { repo: 'r', sync: 'publish-down' } }, 'foo').some((p) => p.includes('not a recognised key')));
  // the legacy block is rejected outright — Toolbelt stands alone
  assert.ok(validate({ ...base, origin: {}, upstream: { owned_by: 'toolbelt', sync: 'none' } }, 'foo').some((p) => p.includes('legacy')));
});

test('validate enforces the 2.0 fields: principal, verb tiers, risk, systems', () => {
  const base = { name: 'foo', kind: 'tool', description: 'd', platforms: ['darwin'], origin: {}, risk: { read_only: true, destructive: false, idempotent: true, open_world: false, worst_case: 'none' } };
  // risk is required on tools and connectors, not skills
  assert.ok(validate({ ...base, risk: undefined }).some((p) => p.includes('risk')));
  assert.equal(validate({ ...base, kind: 'skill', risk: undefined }).length, 0);
  // principal: required when auth exists; service needs its exception
  assert.ok(validate({ ...base, auth: { flow: 'x' } }).some((p) => p.includes('auth.principal')));
  assert.ok(validate({ ...base, auth: { principal: 'service', flow: 'x' } }).some((p) => p.includes('principal_exception')));
  assert.equal(validate({ ...base, auth: { principal: 'user', flow: 'x', caches: [{ path: '~/x', class: 'derived', store: 'file' }] } }).length, 0);
  assert.ok(validate({ ...base, auth: { principal: 'user', caches: [{ path: '~/x', class: 'weird' }] } }).some((p) => p.includes('class')));
  // verbs: tiers, gates, ungated writes need a note, read_only must agree
  assert.equal(validate({ ...base, verbs: [{ name: 'q', tier: 'read' }] }).length, 0);
  assert.ok(validate({ ...base, verbs: [{ name: 'w', tier: 'write-gated' }] }).some((p) => p.includes('gate')));
  assert.ok(validate({ ...base, verbs: [{ name: 'w', tier: 'write' }] }).some((p) => p.includes('note')));
  assert.ok(validate({ ...base, verbs: [{ name: 'w', tier: 'write-gated', gate: 'tty' }] }).some((p) => p.includes('read_only')));
  assert.equal(validate({ ...base, risk: { ...base.risk, read_only: false }, verbs: [{ name: 'w', tier: 'write-gated', gate: 'tty' }] }).length, 0);
  assert.ok(validate({ ...base, verbs: [{ name: 'q', tier: 'read', gate: 'tty' }] }).some((p) => p.includes('only applies')));
  assert.ok(validate({ ...base, verbs: [{ name: 'q', tier: 'read' }, { name: 'q', tier: 'read' }] }).some((p) => p.includes('twice')));
  // systems
  assert.ok(validate({ ...base, systems: [{ name: 'X' }] }).some((p) => p.includes('read')));
  assert.equal(validate({ ...base, systems: [{ name: 'X', read: 'x q', preferred: true }] }).length, 0);
});
