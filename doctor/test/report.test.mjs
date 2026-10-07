import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tally, renderJson, renderHuman } from '../lib/report.mjs';

// A check the doctor could not run here. Status is 'skip', but the doctor learned nothing.
const unimplemented = { id: 'runtime.node', title: 'node', status: 'skip', unimplemented: true, detail: 'not yet implemented on win32' };
// A check skipped because the tool legitimately does not target this platform.
const unsupported = { id: '-', title: 'platform', status: 'skip', detail: 'mac-only-tool does not support win32' };
const passing = { id: 'files.exists', title: 'file', status: 'pass', detail: 'ok' };
const failing = { id: 'files.exists', title: 'file', status: 'fail', detail: 'missing' };

const tool = (name, checks) => ({ tool: name, kind: 'tool', status: 'skip', checks });
const parse = (results, errors = [], smoke = []) => JSON.parse(renderJson({ toolbelt: '/tb', results, errors, smoke }));

test('tally counts unimplemented as a subset of skip, not a fifth status', () => {
  const counts = tally([tool('a', [unimplemented, unsupported, passing])]);
  assert.equal(counts.skip, 2, 'both skips still counted as skips');
  assert.equal(counts.unimplemented, 1, 'only the no-impl check is a coverage gap');
  assert.equal(counts.pass, 1);
  assert.equal(counts.fail, 0);
});

test('ok is false when checks were skipped for lack of an implementation', () => {
  // The regression this guards: on win32 every check was unimplemented, so the belt reported
  // ok:true with 0 pass and 132 skip. Absence of failure is not evidence of health.
  const out = parse([tool('a', [unimplemented])]);
  assert.equal(out.summary.fail, 0);
  assert.equal(out.ok, false);
  assert.equal(out.inconclusive, true);
});

test('ok stays true when every skip is a supported-platform skip', () => {
  // A darwin-only tool on win32 is correctly not applicable — that must not read as broken,
  // or a mixed-fleet run could never come back clean.
  const out = parse([tool('mac-only-tool', [unsupported]), tool('b', [passing])]);
  assert.equal(out.ok, true);
  assert.equal(out.inconclusive, false);
  assert.equal(out.summary.unimplemented, 0);
});

test('a real failure outranks inconclusive', () => {
  const out = parse([tool('a', [failing, unimplemented])]);
  assert.equal(out.ok, false);
  assert.equal(out.inconclusive, false, 'inconclusive means unverified, not broken');
});

test('manifest errors still force ok:false', () => {
  const out = parse([tool('a', [passing])], [{ file: 'x/toolbelt.json', error: 'bad json' }]);
  assert.equal(out.summary.fail, 1);
  assert.equal(out.ok, false);
});

test('darwin behaviour is unchanged: no unimplemented checks means the old verdict', () => {
  // Every check in the registry has a darwin impl, so counts.unimplemented is always 0 there
  // and `ok` reduces to the previous `fail === 0`.
  assert.equal(parse([tool('a', [passing])]).ok, true);
  assert.equal(parse([tool('a', [failing])]).ok, false);
  assert.equal(parse([tool('a', [passing, unsupported])]).ok, true);
});

test('the human summary names the blind spot instead of implying a clean sweep', () => {
  const out = renderHuman({ toolbelt: '/tb', results: [tool('a', [unimplemented])], errors: [], smoke: [] });
  // renderHuman names the platform this run executed on, not the fixture's.
  assert.match(out, new RegExp(`no ${process.platform} implementation`));
  assert.match(out, /proves nothing/);
  // And says nothing when there is no gap to report.
  const clean = renderHuman({ toolbelt: '/tb', results: [tool('a', [passing])], errors: [], smoke: [] });
  assert.doesNotMatch(clean, /proves nothing/);
});
