// lifecycle.mjs — the practice the belt applies to tools and must apply to itself: a usage
// log that measures USE (as distinct from witnessed demand), and a cost meter for the surface every session pays for before the first question is asked.
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { discover, resolve } from './manifest.mjs';
import { spawnShellInherit, shellQuote } from './platform.mjs';
import { cacheDir } from './report.mjs';

/** This belt's usage log: under the per-belt cache dir, so two belts on one machine never share one. */
const usageFile = (toolbelt) => path.join(cacheDir(toolbelt), 'usage.log');

/**
 * `toolbelt run <tool> -- <args>`: exec the tool's CLI entrypoint from its own directory and
 * append one line — date, tool, first verb — to a local, gitignored, never-shared log. No
 * arguments beyond the verb are recorded (arguments carry queries, names, and paths).
 */
export async function cmdRun(toolbelt, toolName, rest) {
  const { manifests } = discover(toolbelt);
  const m = toolName && resolve(manifests, toolName);
  if (!m) { console.error(`toolbelt run: no such tool "${toolName ?? ''}". Try: toolbelt list`); return 2; }
  const cli = m.entrypoints?.cli;
  if (!cli) { console.error(`toolbelt run: "${m.name}" has no entrypoints.cli — see ${path.relative(process.cwd(), path.join(m._dir, 'CLAUDE.md'))}`); return 2; }
  const verb = rest.find((a) => !a.startsWith('-')) ?? '-';
  // Entry points are shell-shaped ("poetry run tk", "node cli.js", "python3 tool.py"). A bare
  // script filename ("cli.js") is a common shorthand and has no interpreter, so it runs under node.
  const first = cli.split(/\s+/)[0];
  const command = `${/\.(m|c)?js$/.test(first) && existsSync(path.join(m._dir, first)) ? 'node ' : ''}${cli} ${rest.map(shellQuote).join(' ')}`;
  const code = await spawnShellInherit(command, { cwd: m._dir });
  // Logged after the run, so a command that never started (127) is not counted as use. One
  // line — date, tool, first verb — and nothing else: arguments carry queries, names, and paths.
  if (code !== 127) {
    try {
      const file = usageFile(toolbelt);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${new Date().toISOString().slice(0, 10)}\t${m.name}\t${verb}\n`, { mode: 0o600 });
    } catch { /* the log is a courtesy, never a gate */ }
  }
  return code;
}

/** `toolbelt usage [--days N]`: what this machine actually ran. Local only; nothing leaves. */
export function cmdUsage(toolbelt, { days = 30 } = {}) {
  const USAGE = usageFile(toolbelt);
  if (!existsSync(USAGE)) { console.log(`no usage recorded yet (${USAGE}). \`toolbelt run <tool> -- <verb …>\` records tool + verb + date, nothing else.`); return 0; }
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const counts = new Map();
  let total = 0;
  for (const line of readFileSync(USAGE, 'utf8').split('\n')) {
    const [date, tool, verb] = line.split('\t');
    if (!tool || date < since) continue;
    total++;
    const key = `${tool}\t${verb}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`usage, last ${days} days — ${total} run(s) across ${new Set(rows.map(([k]) => k.split('\t')[0])).size} tool(s)  (${USAGE}, local, never shared)\n`);
  for (const [key, n] of rows.slice(0, 40)) { const [tool, verb] = key.split('\t'); console.log(`  ${String(n).padStart(5)}  ${tool.padEnd(18)} ${verb}`); }
  return 0;
}

const approxTokens = (chars) => Math.round(chars / 4);

/**
 * `toolbelt meter`: the per-session surface an agent pays for before doing anything — the
 * global and repo CLAUDE.md, every skill's front-matter description (injected so the model can
 * route), and the registered MCP servers' tool descriptions (approximated from each manifest's
 * verbs[], since the live descriptions vary per server). Chars/4 is the estimate; the point is
 * the trend and the ranking, not the fourth digit.
 */
export async function cmdMeter(toolbelt) {
  const home = homedir();
  const rows = [];
  const add = (what, file) => { if (existsSync(file)) rows.push({ what, chars: readFileSync(file, 'utf8').length, file }); };
  add('~/.claude/CLAUDE.md (global, every session)', path.join(home, '.claude', 'CLAUDE.md'));
  add(`${path.basename(toolbelt)}/CLAUDE.md (every session in this repo)`, path.join(toolbelt, 'CLAUDE.md'));
  const skillsDir = path.join(home, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir)) {
      const p = path.join(skillsDir, d);
      let target = p;
      try { if (lstatSync(p).isSymbolicLink()) target = path.resolve(path.dirname(p), readlinkSync(p)); } catch { continue; }
      const skill = path.join(target, 'SKILL.md');
      if (!existsSync(skill)) continue;
      const text = readFileSync(skill, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(text);
      const desc = fm ? (/description:\s*([\s\S]*?)(?=\n[a-z-]+:|$)/.exec(fm[1])?.[1] ?? '') : '';
      rows.push({ what: `skill ${d} (description, injected per session)`, chars: desc.length, file: skill, body: text.length });
    }
  }
  const cfgFile = path.join(home, '.claude.json');
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      const { manifests } = discover(toolbelt);
      for (const name of Object.keys(cfg.mcpServers ?? {})) {
        const m = manifests.find((x) => x.mcp?.server_name === name);
        const tools = (m?.verbs ?? []).filter((v) => v.surface === 'mcp' || v.surface === 'both');
        rows.push({ what: `MCP ${name} (${m ? `${tools.length} tool(s) declared` : 'no manifest — orphan?'}; ~120 tokens per tool schema)`, chars: tools.length * 480, file: cfgFile });
      }
    } catch { /* unreadable config: nothing to meter */ }
  }
  rows.sort((a, b) => b.chars - a.chars);
  const total = rows.reduce((n, r) => n + r.chars, 0);
  console.log(`per-session surface — ~${approxTokens(total).toLocaleString()} tokens before the first question (chars/4)\n`);
  for (const r of rows) console.log(`  ${String(approxTokens(r.chars)).padStart(7)}  ${r.what}${r.body ? `  (body ${approxTokens(r.body)} tokens, loaded only when invoked)` : ''}`);
  console.log(`\nTrim from the top: the largest rows are what every session pays before the first question is asked.`);
  return 0;
}
