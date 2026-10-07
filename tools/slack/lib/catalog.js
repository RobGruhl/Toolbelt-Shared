/**
 * Channel catalog + Table-of-Contents generation.
 *
 * Where the Web API channel-listing endpoints are admin-restricted (Enterprise
 * Grid workspaces commonly return `enterprise_is_restricted` for
 * `conversations.list` / `users.conversations`), there is no way to dump every
 * channel. Instead we sweep the Edge API `channels/search` across a broad
 * keyword set (`DEFAULT_DISCOVERY_QUERIES`) and accumulate results into a
 * persistent catalog. Each run records a `last_seen` timestamp per channel, so
 * the catalog grows over time and tracks when each channel was last observed.
 *
 * NOTE: discovery is keyword-driven, so the catalog is a broad sample, not a
 * guaranteed-complete list. Add `--query` terms to widen coverage.
 */

// Broad keyword sweep. Tuned toward ops/devops/NOC/SRE/AI plus general
// engineering terms for wider coverage. Each term is one Edge API call
// returning up to `count` results. Edit freely for your company's vocabulary.
export const DEFAULT_DISCOVERY_QUERIES = [
  // SRE / reliability
  'sre', 'reliability', 'resilience', 'site-reliability',
  // NOC / incident
  'noc', 'incident', 'outage', 'hugops', 'problem', 'major-incident',
  'war-room', 'sev', 'triage',
  // On-call / paging
  'oncall', 'on-call', 'pagerduty', 'pager', 'escalation', 'alert', 'alerts',
  // Observability / monitoring
  'observability', 'monitoring', 'newrelic', 'new-relic', 'splunk', 'grafana',
  'datadog', 'telemetry', 'logging', 'metrics', 'instrumentation',
  // AIOps / AI / agents
  'aiops', 'ai', 'agent', 'agents', 'mcp', 'claude', 'copilot', 'gpt', 'llm',
  'genai', 'bedrock', 'vertex', 'mlops', 'ml', 'prompt', 'chatbot',
  // DevOps / platform
  'devops', 'platform', 'kubernetes', 'k8s', 'pipeline', 'gateway', 'ingress',
  'vault', 'terraform', 'gitlab', 'github', 'argo', 'deploy', 'release', 'airflow',
  'cicd', 'ci-cd',
  // RCA / postmortem / process
  'rca', 'postmortem', 'root-cause', 'runbook', 'slo', 'error-budget',
  // General engineering breadth
  'engineering', 'eng-standards', 'security', 'network', 'cloud', 'aws', 'gcp',
  'data', 'api', 'service', 'support', 'prod', 'tech',
];

/**
 * Merge a discovery run into an existing catalog, stamping last_seen.
 *
 * @param {object|null} existing - Prior catalog (or null/empty for first run).
 * @param {object[]} discovered - Channels from discoverChannels().
 * @param {object} opts
 * @param {string} opts.at - ISO timestamp for this run.
 * @param {string[]} opts.queries - Queries used this run.
 * @returns {object} updated catalog
 */
export function mergeCatalog(existing, discovered, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const channels = { ...(existing?.channels || {}) };
  let added = 0;
  let updated = 0;

  for (const c of discovered) {
    const prev = channels[c.id];
    if (prev) {
      updated++;
      channels[c.id] = {
        ...prev,
        name: c.name,
        is_private: c.is_private,
        num_members: c.num_members ?? prev.num_members,
        purpose: c.purpose?.value ?? prev.purpose,
        topic: c.topic?.value ?? prev.topic,
        last_seen: at,
        matched_queries: Array.from(
          new Set([...(prev.matched_queries || []), c.matched_query].filter(Boolean))
        ),
      };
    } else {
      added++;
      channels[c.id] = {
        id: c.id,
        name: c.name,
        is_private: c.is_private,
        num_members: c.num_members,
        purpose: c.purpose?.value,
        topic: c.topic?.value,
        first_seen: at,
        last_seen: at,
        matched_queries: c.matched_query ? [c.matched_query] : [],
      };
    }
  }

  const runs = (existing?.metadata?.runs || []).slice(-19); // keep last 20
  runs.push({ at, queries: opts.queries || [], found: discovered.length, added, updated });

  return {
    metadata: {
      lastListedAt: at,
      totalChannels: Object.keys(channels).length,
      lastRunAdded: added,
      lastRunUpdated: updated,
      runs,
    },
    channels,
  };
}

// Theme buckets for the quick index. First match wins.
const THEMES = [
  ['SRE / reliability', /(^sre[-_]|[-_]sre([-_]|$)|site-reliability|service-reliability|resilien)/i],
  ['NOC / incident', /(^noc([-_]|$)|noc_|incident-(report|response|manage|updates)|major-incident|war-?room|cyber.*incident)/i],
  ['On-call / paging', /(oncall|on-call|pagerduty|escalat)/i],
  ['Observability / monitoring', /(observ|monitor|newrelic|new-relic|splunk|grafana|datadog|telemetry|instrument|logging|metrics)/i],
  ['AIOps / AI / agents', /(aiops|(^|[-_])ai([-_]|$)|agent|mcp|claude|copilot|genai|bedrock|vertex|mlops|(^|[-_])ml([-_]|$)|prompt|chatbot)/i],
  ['DevOps / platform', /(devops|platform|kubernetes|k8s|pipeline|gateway|ingress|vault|terraform|gitlab|github|argo|airflow)/i],
  ['RCA / postmortem', /(rca|postmortem|post-mortem|root-?cause)/i],
];

function categorize(name) {
  for (const [label, rx] of THEMES) if (rx.test(name)) return label;
  return null;
}

// Ephemeral per-incident channels: name begins with a numeric/INC/CHG id.
function isEphemeral(name) {
  return /^(\d|inc\d|chg\d|sev\d|temp[-_])/i.test(name);
}

/**
 * Render the catalog as a Markdown Table of Contents.
 *
 * @param {object} catalog
 * @returns {string} markdown
 */
export function renderChannelToc(catalog) {
  const all = Object.values(catalog.channels || {}).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );
  const ts = catalog.metadata?.lastListedAt || new Date().toISOString();

  let md = `# Slack — Channel Table of Contents\n\n`;
  md += `> **Last listed:** ${ts}\n`;
  md += `> **Total channels cataloged:** ${all.length}\n\n`;
  md += `Generated by \`node cli.js channel-toc\`. Discovery is keyword-driven `;
  md += `via the Edge API \`channels/search\` (on Enterprise Grid workspaces the Web API `;
  md += `\`conversations.list\`/\`users.conversations\` may be admin-restricted with `;
  md += `\`enterprise_is_restricted\`). This is therefore a broad sample, not a `;
  md += `guaranteed-complete list — re-run with extra \`--query\` terms to widen `;
  md += `coverage. Each channel shows when it was last observed.\n\n`;

  // Thematic quick index (durable, non-ephemeral channels only)
  md += `## Quick index — Ops / SRE / NOC / AI\n\n`;
  for (const [label] of THEMES) {
    const hits = all.filter((c) => !isEphemeral(c.name) && categorize(c.name) === label);
    if (!hits.length) continue;
    md += `### ${label} (${hits.length})\n\n`;
    for (const c of hits) {
      const m = c.num_members ? ` · ${c.num_members}m` : '';
      const p = c.is_private ? ' 🔒' : '';
      md += `- \`#${c.name}\`${p}${m}\n`;
    }
    md += `\n`;
  }

  // The full catalog stays queryable, not rendered: a flat table of every
  // cataloged channel (thousands of rows on a large workspace, mostly
  // resolved-incident ephemera) buries the index and duplicates
  // channel-catalog.json, which sits beside this file.
  md += `## The full catalog (${all.length} channels)\n\n`;
  md += `Not rendered here — query it instead:\n\n`;
  md += `- \`node cli.js find-channels <keyword…>\` — live Edge-API keyword search\n`;
  md += `- \`channel-catalog.json\` (same directory) — every cataloged channel with `;
  md += `\`first_seen\` / \`last_seen\` / \`matched_queries\`, greppable offline\n`;

  return md;
}
