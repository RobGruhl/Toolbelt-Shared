// derived.mjs — one shape for every artifact the belt derives from its manifests: a block
// between two HTML-comment markers, rendered by code, written by `--write`, drift-checked by
// `--check` (wire it into your pre-commit or integrity check). A statement that must stay true
// belongs in a check or a derived artifact — this is the derived-artifact half.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function markers(key, hint) {
  return {
    begin: `<!-- ${key}:begin — derived from toolbelt.json manifests; ${hint} -->`,
    end: `<!-- ${key}:end -->`,
  };
}

/** Slice bounds of the marker block, or null when absent. A begin without an end is corruption — throw. */
export function locate(text, { begin, end }) {
  const b = text.indexOf(begin);
  if (b === -1) return null;
  const e = text.indexOf(end, b + begin.length);
  if (e === -1) throw new Error(`"${begin.slice(5, 30)}…" has a begin marker but no end marker`);
  return { begin: b, end: e + end.length };
}

export function current(text, m) {
  const found = locate(text, m);
  return found ? text.slice(found.begin, found.end) : null;
}

export function wrap(body, { begin, end }) {
  return `${begin}\n${body}\n${end}`;
}

/** Replace the block in `text`; when there is none yet, append it (with `preamble` first if the file is new). */
export function replace(text, block, m) {
  const found = locate(text, m);
  if (found) return text.slice(0, found.begin) + block + text.slice(found.end);
  return text.endsWith('\n') || text === '' ? `${text}${block}\n` : `${text}\n${block}\n`;
}

/** Line-level drift summary; the examples keep a failing check diagnosable from the doctor line alone. */
export function diff(have, want, what = 'derived block') {
  if (have === want) return { drifted: false, summary: `${what} matches the manifests` };
  if (have === null) return { drifted: true, summary: `${what} is missing (no markers)` };
  const haveSet = new Set(have.split('\n'));
  const wantSet = new Set(want.split('\n'));
  const missing = [...wantSet].filter((l) => !haveSet.has(l));
  const stale = [...haveSet].filter((l) => !wantSet.has(l));
  const clip = (l) => (l.length > 100 ? `${l.slice(0, 97)}…` : l);
  const examples = [...missing.slice(0, 3).map((l) => `  + ${clip(l)}`), ...stale.slice(0, 3).map((l) => `  - ${clip(l)}`)];
  return {
    drifted: true,
    summary: `${what} drifts from the manifests (+${missing.length} line(s) to add, -${stale.length} stale)${examples.length ? `\n${examples.join('\n')}` : ''}`,
  };
}

/**
 * The whole `--write | --check | print` dance for one artifact. `render()` returns the block body;
 * `preamble` is the hand-written head of a file that does not exist yet.
 * Returns a process exit code.
 */
export function runDerived({ file, m, render, preamble = '', values, what, regenerate }) {
  const block = wrap(render(), m);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (values.check) {
    const { drifted, summary } = diff(current(text, m), block, what);
    console.log(`${what}: ${summary}`);
    if (drifted) console.log(`regenerate: ${regenerate}`);
    return drifted ? 1 : 0;
  }
  if (values.write) {
    const base = text || preamble;
    const next = replace(base, block, m);
    if (next === text) {
      console.log(`${what} already current.`);
    } else {
      writeFileSync(file, next);
      console.log(`${what} rewritten from the manifests.`);
    }
    return 0;
  }
  console.log(block);
  return 0;
}
