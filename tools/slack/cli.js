#!/usr/bin/env node

/**
 * slack-cli
 *
 * Reads, searches, exports, and gated writes against your Slack workspace,
 * as yourself. Reuses auth.js for authentication but runs independently of
 * the MCP server (which exposes only the read tools).
 */

import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

import { getAuthCookies, deleteAuthFile, getCurrentUser, sleep, resolveChannel, callSlackApi } from './auth.js';
import { getTelemetry, resetTelemetry, formatTelemetry } from './lib/telemetry.js';
import {
  searchUserMessages,
  searchMentions,
  searchChannelMessages,
  getMyChannels,
  discoverChannels,
  getMyReactions,
  searchMyMessagesWithReactions,
  searchThreadParticipation,
  getThreadReplies,
  getSummaryStats,
} from './lib/queries.js';
import { readFileSync } from 'fs';
import {
  DEFAULT_DISCOVERY_QUERIES,
  mergeCatalog,
  renderChannelToc,
} from './lib/catalog.js';
import {
  exportMessagesToMarkdown,
  exportMessagesToJSON,
  exportMessagesToCSV,
  exportThreadToJSON,
  exportChannelsToMarkdown,
  exportChannelsToJSON,
  exportChannelsToCSV,
  exportReactionsToMarkdown,
  exportReactionsToJSON,
  exportSummaryToMarkdown,
} from './lib/export.js';
import { bulkWarning, enforceOffHours, isSinglePageRead, channelReadExemption } from './lib/safeguards.js';
import { buildPermalink } from './lib/queries.js';
import { getPermalinkBase, getWorkspaceUrl, describeConfig } from './lib/config.js';
import { resolveRecipient, resolveGroupRecipients, confirmOnTty, postMessage } from './lib/send.js';
import {
  DEFAULT_BACKUP_DIR,
  fetchMessage,
  lossyReasons,
  computeNewText,
  renderDiff,
  confirmEditOnTty,
  backupMessage,
  updateMessage,
} from './lib/edit.js';
import { confirmReactOnTty, setReaction } from './lib/react.js';
import {
  validateInviteTarget,
  describeChannel,
  resolveInviteTargets,
  confirmInviteOnTty,
  inviteToChannel,
  explainInviteError,
} from './lib/invite.js';
import {
  validateChannelName,
  checkNameAvailability,
  resolveInvitees,
  confirmCreateOnTty,
  createChannel,
  resolveTeamId,
  setPurpose,
  setTopic,
  inviteMembers,
} from './lib/create-channel.js';
import { downloadFiles, parsePermalink } from './lib/files.js';

const program = new Command();

/**
 * Integer coercion for .option() values.
 *
 * Do NOT pass bare `parseInt` as a commander coercion callback: commander calls
 * it as fn(value, previousValue), so a numeric default becomes parseInt's RADIX.
 * `--delay 500` on an option defaulting to 100 evaluates parseInt('500', 100),
 * and radix 100 is out of range, so the result is NaN. That is dangerous for
 * --delay specifically: setTimeout(fn, NaN) fires immediately, so asking for a
 * gentler rate against a shared production system would remove throttling entirely.
 */
const intArg = (v) => parseInt(v, 10);

// Global state
let cachedAuth = null;

/**
 * Get authenticated credentials.
 */
async function getAuth(opts = {}) {
  if (cachedAuth) return cachedAuth;

  console.error('[slack-cli] Getting authentication...');
  cachedAuth = await getAuthCookies(opts.forceLogin);
  console.error('[slack-cli] Authenticated successfully');
  return cachedAuth;
}

/**
 * Write output to file or stdout.
 */
function writeOutput(content, outputPath) {
  if (outputPath) {
    // Ensure directory exists
    const dir = dirname(outputPath);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(outputPath, content);
    console.error(`[slack-cli] Written to: ${outputPath}`);
  } else {
    // Write to stdout
    process.stdout.write(content);
  }
}

/**
 * Progress callback for CLI.
 */
function makeProgressCallback(label) {
  return (page, count, total) => {
    const totalStr = total ? ` / ${total}` : '';
    console.error(`[${label}] Page ${page}: ${count}${totalStr} items`);
  };
}

// CLI Setup
program
  .name('slack-cli')
  .description(`Read, search, export, and (gated) write to your Slack workspace as yourself.\n\n${bulkWarning()}`)
  .version('0.1.0')
  .option('--force', 'Override the off-hours check on bulk reads (loud; logged)');

// Common options
const addCommonOptions = (cmd) => {
  return cmd
    .option('--after <date>', 'Only include messages after this date (YYYY-MM-DD)')
    .option('--before <date>', 'Only include messages before this date (YYYY-MM-DD)')
    .option('-o, --output <file>', 'Output file path (default: stdout)')
    .option('-f, --format <format>', 'Output format: md, json, csv (default: md)', 'md')
    .option('--max-results <n>', 'Maximum results to fetch', intArg)
    .option('--max-pages <n>', 'Maximum pages to fetch', intArg)
    .option('--delay <ms>', 'Delay between API requests in ms (default: 100)', intArg, 100)
    .option('--verbose', 'Show detailed API logs')
    .option('--dry-run', 'Show what would be fetched without making API calls');
};

// my-messages command
addCommonOptions(
  program
    .command('my-messages')
    .description('Export your messages to a file')
)
  .option('--query <keywords>', 'Additional search keywords')
  .option('--group-by-channel', 'Group messages by channel')
  .option('--group-by-date', 'Group messages by date')
  .action(async (opts) => {
    try {
      enforceOffHours(program.opts().force);

      if (opts.dryRun) {
        console.error('[dry-run] Would fetch messages from you');
        console.error(`[dry-run] Date range: ${opts.after || 'beginning'} to ${opts.before || 'now'}`);
        console.error(`[dry-run] Format: ${opts.format}`);
        console.error(`[dry-run] Output: ${opts.output || 'stdout'}`);
        return;
      }

      const auth = await getAuth();
      const currentUser = await getCurrentUser(auth.cookies, auth.token);

      console.error(`[slack-cli] Fetching messages for @${currentUser.userId}...`);

      const result = await searchUserMessages(auth, {
        username: currentUser.userId,
        query: opts.query,
        after: opts.after,
        before: opts.before,
        maxResults: opts.maxResults,
        maxPages: opts.maxPages,
        delay: opts.delay,
        verbose: opts.verbose,
        onProgress: makeProgressCallback('my-messages'),
      });

      console.error(`[slack-cli] Found ${result.total} total messages, fetched ${result.messages.length}`);

      // Export
      let output;
      const exportOpts = {
        title: `Messages from ${result.user.displayName}`,
        subtitle: opts.after || opts.before
          ? `Date range: ${opts.after || 'beginning'} to ${opts.before || 'present'}`
          : '',
        total: result.total,
        groupByChannel: opts.groupByChannel,
        groupByDate: opts.groupByDate,
      };

      switch (opts.format) {
        case 'json':
          output = exportMessagesToJSON(result.messages, exportOpts);
          break;
        case 'csv':
          output = exportMessagesToCSV(result.messages, exportOpts);
          break;
        default:
          output = exportMessagesToMarkdown(result.messages, exportOpts);
      }

      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// list-channels command
program
  .command('list-channels')
  .description('List all channels you are a member of (including private)')
  .option('-o, --output <file>', 'Output file path')
  .option('-f, --format <format>', 'Output format: md, json, csv (default: md)', 'md')
  .option('--types <types>', 'Channel types: all, public, private (default: all)', 'all')
  .action(async (opts) => {
    try {
      const auth = await getAuth();

      console.error('[slack-cli] Fetching your channels...');

      const result = await getMyChannels(auth, { types: opts.types });

      console.error(`[slack-cli] Found ${result.total} channels`);

      // Export
      let output;
      switch (opts.format) {
        case 'json':
          output = exportChannelsToJSON(result.channels);
          break;
        case 'csv':
          output = exportChannelsToCSV(result.channels);
          break;
        default:
          output = exportChannelsToMarkdown(result.channels);
      }

      writeOutput(output, opts.output);
    } catch (error) {
      if (/enterprise_is_restricted/.test(error.message)) {
        console.error(
          '[slack-cli] Error: channel listing is admin-restricted on this Enterprise Grid workspace ' +
          "(conversations.list → 'enterprise_is_restricted').\n" +
          '[slack-cli] Use keyword discovery instead:\n' +
          '[slack-cli]   node cli.js find-channels sre noc ai      # search by keyword(s)\n' +
          '[slack-cli]   node cli.js channel-toc                   # build/refresh the channel catalog'
        );
      } else {
        console.error(`[slack-cli] Error: ${error.message}`);
      }
      process.exit(1);
    }
  });

// find-channels command — keyword discovery via Edge API (works where
// conversations.list is admin-restricted, as it often is on Enterprise Grid)
program
  .command('find-channels [queries...]')
  .description('Discover channels by keyword via the Edge API (the fallback when conversations.list is restricted)')
  .option('-o, --output <file>', 'Output file path')
  .option('-f, --format <format>', 'Output format: md, json, csv (default: md)', 'md')
  .option('-c, --count <n>', 'Max results per query (default: 50)', '50')
  .action(async (queries, opts) => {
    try {
      if (!queries || queries.length === 0) {
        console.error('[slack-cli] Provide one or more keywords, e.g.: find-channels sre noc ai');
        process.exit(1);
      }
      const auth = await getAuth();
      console.error(`[slack-cli] Searching channels for: ${queries.join(', ')}`);
      const result = await discoverChannels(auth, {
        queries,
        count: parseInt(opts.count, 10) || 50,
      });
      console.error(`[slack-cli] Found ${result.total} unique channels`);
      if (result.errors.length) {
        console.error(`[slack-cli] ${result.errors.length} query error(s): ${result.errors.map(e => e.query).join(', ')}`);
      }
      let output;
      switch (opts.format) {
        case 'json': output = exportChannelsToJSON(result.channels); break;
        case 'csv': output = exportChannelsToCSV(result.channels); break;
        default: output = exportChannelsToMarkdown(result.channels, { title: `Channels matching: ${queries.join(', ')}` });
      }
      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// channel-toc command — sweep a broad keyword set, merge into a persistent
// timestamped catalog, and (re)generate CHANNELS.md
program
  .command('channel-toc')
  .description('Build/refresh the channel Table of Contents (CHANNELS.md + channel-catalog.json) with last-seen timestamps')
  .option('-c, --count <n>', 'Max results per query (default: 50)', '50')
  .option('--query <kw>', 'Extra keyword to add to the default sweep (repeatable)', (v, acc) => { acc.push(v); return acc; }, [])
  .option('--catalog <file>', 'Catalog JSON path (default: channel-catalog.json)', 'channel-catalog.json')
  .option('--toc <file>', 'ToC Markdown path (default: CHANNELS.md)', 'CHANNELS.md')
  .action(async (opts) => {
    try {
      const auth = await getAuth();
      const queries = [...DEFAULT_DISCOVERY_QUERIES, ...opts.query];
      console.error(`[slack-cli] Sweeping ${queries.length} keyword queries via Edge API...`);
      const result = await discoverChannels(auth, {
        queries,
        count: parseInt(opts.count, 10) || 50,
      });
      console.error(`[slack-cli] Discovered ${result.total} unique channels (${result.errors.length} query error(s))`);

      // Load existing catalog if present (preserves first_seen + history)
      let existing = null;
      if (existsSync(opts.catalog)) {
        try { existing = JSON.parse(readFileSync(opts.catalog, 'utf8')); } catch { /* start fresh */ }
      }
      const at = new Date().toISOString();
      const catalog = mergeCatalog(existing, result.channels, { at, queries });

      writeFileSync(opts.catalog, JSON.stringify(catalog, null, 2));
      writeFileSync(opts.toc, renderChannelToc(catalog));
      console.error(
        `[slack-cli] Catalog: ${catalog.metadata.totalChannels} channels ` +
        `(+${catalog.metadata.lastRunAdded} new this run) → ${opts.catalog}`
      );
      console.error(`[slack-cli] ToC written → ${opts.toc} (last listed ${at})`);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// channel command
addCommonOptions(
  program
    .command('channel <channel>')
    .description('Export messages from a specific channel (by name or ID)')
)
  .option('--query <keywords>', 'Search keywords')
  .action(async (channel, opts) => {
    try {
      // Off-hours gate. A single page (--max-pages 1, or --max-results <= 100) of
      // a private channel you are a member of is exempt — that takes one
      // conversations.info read to establish, so the decision for that shape
      // is made after auth, below. Every other shape is gated here, before any
      // network call.
      const singlePage = isSinglePageRead(opts);
      if (!singlePage) enforceOffHours(program.opts().force);

      if (opts.dryRun) {
        console.error(`[dry-run] Would fetch messages from channel: ${channel}`);
        console.error(`[dry-run] Date range: ${opts.after || 'beginning'} to ${opts.before || 'now'}`);
        if (singlePage) console.error('[dry-run] Single-page read: off-hours gate waived only if the channel is private and you are a member');
        return;
      }

      const auth = await getAuth();

      let resolved;
      if (singlePage) {
        resolved = await resolveChannel(channel, auth.cookies, auth.token);
        const { exempt, reason } = await channelReadExemption(opts, resolved.channelId, auth.cookies, auth.token);
        if (exempt) {
          console.error(`[safeguard] Off-hours gate waived: ${reason}`);
        } else {
          enforceOffHours(program.opts().force);
        }
      }

      console.error(`[slack-cli] Fetching messages from ${channel}...`);

      const result = await searchChannelMessages(auth, {
        channel,
        resolved,
        query: opts.query,
        after: opts.after,
        before: opts.before,
        maxResults: opts.maxResults,
        maxPages: opts.maxPages,
        delay: opts.delay,
        verbose: opts.verbose,
        onProgress: makeProgressCallback('channel'),
      });

      const channelDisplay = result.channel.name ? `#${result.channel.name}` : result.channel.id;
      console.error(`[slack-cli] Found ${result.total} messages in ${channelDisplay}`);

      // Export
      let output;
      const exportOpts = {
        title: `Messages from ${channelDisplay}`,
        subtitle: opts.after || opts.before
          ? `Date range: ${opts.after || 'beginning'} to ${opts.before || 'present'}`
          : '',
        total: result.total,
      };

      switch (opts.format) {
        case 'json':
          output = exportMessagesToJSON(result.messages, exportOpts);
          break;
        case 'csv':
          output = exportMessagesToCSV(result.messages, exportOpts);
          break;
        default:
          output = exportMessagesToMarkdown(result.messages, exportOpts);
      }

      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// mentions command
addCommonOptions(
  program
    .command('mentions')
    .description('Export messages that @mention you')
)
  .option('--query <keywords>', 'Additional search keywords')
  .action(async (opts) => {
    try {
      enforceOffHours(program.opts().force);

      if (opts.dryRun) {
        console.error('[dry-run] Would fetch @mentions of you');
        console.error(`[dry-run] Date range: ${opts.after || 'beginning'} to ${opts.before || 'now'}`);
        return;
      }

      const auth = await getAuth();

      console.error('[slack-cli] Fetching @mentions...');

      const result = await searchMentions(auth, {
        query: opts.query,
        after: opts.after,
        before: opts.before,
        maxResults: opts.maxResults,
        maxPages: opts.maxPages,
        delay: opts.delay,
        verbose: opts.verbose,
        onProgress: makeProgressCallback('mentions'),
      });

      console.error(`[slack-cli] Found ${result.total} mentions`);

      // Export
      let output;
      const exportOpts = {
        title: 'Messages Mentioning You',
        subtitle: opts.after || opts.before
          ? `Date range: ${opts.after || 'beginning'} to ${opts.before || 'present'}`
          : '',
        total: result.total,
        groupByChannel: true,
      };

      switch (opts.format) {
        case 'json':
          output = exportMessagesToJSON(result.messages, exportOpts);
          break;
        case 'csv':
          output = exportMessagesToCSV(result.messages, exportOpts);
          break;
        default:
          output = exportMessagesToMarkdown(result.messages, exportOpts);
      }

      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// reactions command
program
  .command('reactions')
  .description('Export messages you have reacted to')
  .option('-o, --output <file>', 'Output file path')
  .option('-f, --format <format>', 'Output format: md, json (default: md)', 'md')
  .option('--max-results <n>', 'Maximum results', intArg)
  .option('--verbose', 'Show detailed logs')
  .action(async (opts) => {
    try {
      enforceOffHours(program.opts().force);

      const auth = await getAuth();

      console.error('[slack-cli] Fetching your reactions...');

      const result = await getMyReactions(auth, {
        maxResults: opts.maxResults,
        verbose: opts.verbose,
        onProgress: makeProgressCallback('reactions'),
      });

      console.error(`[slack-cli] Found ${result.total} reactions`);

      // Export
      let output;
      switch (opts.format) {
        case 'json':
          output = exportReactionsToJSON(result.items);
          break;
        default:
          output = exportReactionsToMarkdown(result.items);
      }

      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// threads command
addCommonOptions(
  program
    .command('threads')
    .description('Export threads you participated in (replied to)')
)
  .action(async (opts) => {
    try {
      enforceOffHours(program.opts().force);

      if (opts.dryRun) {
        console.error('[dry-run] Would fetch threads you participated in');
        console.error(`[dry-run] Date range: ${opts.after || 'beginning'} to ${opts.before || 'now'}`);
        return;
      }

      const auth = await getAuth();

      console.error('[slack-cli] Fetching thread participation...');

      const result = await searchThreadParticipation(auth, {
        after: opts.after,
        before: opts.before,
        maxResults: opts.maxResults,
        maxPages: opts.maxPages,
        delay: opts.delay,
        verbose: opts.verbose,
        onProgress: makeProgressCallback('threads'),
      });

      console.error(`[slack-cli] Found ${result.total} thread replies (from ${result.originalTotal} total messages)`);

      // Export
      let output;
      const exportOpts = {
        title: 'Thread Participation',
        subtitle: `You replied in ${result.total} threads` +
          (opts.after || opts.before ? `\nDate range: ${opts.after || 'beginning'} to ${opts.before || 'present'}` : ''),
        total: result.total,
        groupByChannel: true,
      };

      switch (opts.format) {
        case 'json':
          output = exportMessagesToJSON(result.messages, exportOpts);
          break;
        case 'csv':
          output = exportMessagesToCSV(result.messages, exportOpts);
          break;
        default:
          output = exportMessagesToMarkdown(result.messages, exportOpts);
      }

      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// year-review command
program
  .command('year-review')
  .description('Full year export organized by month')
  .option('--year <year>', 'Year to export (default: previous year)', intArg)
  .option('--output-dir <dir>', 'Output directory (default: ./slack-review-YEAR/)')
  .option('-f, --format <format>', 'Output format: md, json (default: md)', 'md')
  .option('--delay <ms>', 'Delay between API requests', intArg, 200)
  .option('--verbose', 'Show detailed logs')
  .action(async (opts) => {
    try {
      enforceOffHours(program.opts().force);

      const auth = await getAuth();
      const currentUser = await getCurrentUser(auth.cookies, auth.token);

      // Default to previous year
      const year = opts.year || new Date().getFullYear() - 1;
      const outputDir = opts.outputDir || `./slack-review-${year}`;

      console.error(`[slack-cli] Starting year review for ${year}`);
      console.error(`[slack-cli] Output directory: ${outputDir}`);

      // Create output directory
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ];

      const ext = opts.format === 'json' ? 'json' : 'md';

      // Export channels first
      console.error('\n[slack-cli] Exporting channel list...');
      const channelsResult = await getMyChannels(auth, { types: 'all' });
      const channelsOutput = opts.format === 'json'
        ? exportChannelsToJSON(channelsResult.channels)
        : exportChannelsToMarkdown(channelsResult.channels);
      writeFileSync(join(outputDir, `channels.${ext}`), channelsOutput);

      // Export summary stats for full year
      console.error('\n[slack-cli] Calculating yearly summary...');
      const yearStats = await getSummaryStats(auth, {
        after: `${year}-01-01`,
        before: `${year + 1}-01-01`,
        verbose: opts.verbose,
      });
      const summaryOutput = exportSummaryToMarkdown(yearStats, {
        title: `Slack Activity Summary - ${year}`,
      });
      writeFileSync(join(outputDir, `summary.${ext}`), summaryOutput);

      // Export month by month
      for (let month = 0; month < 12; month++) {
        const monthNum = String(month + 1).padStart(2, '0');
        const monthName = months[month];
        const nextMonth = month === 11 ? 1 : month + 2;
        const nextYear = month === 11 ? year + 1 : year;
        const nextMonthNum = String(nextMonth).padStart(2, '0');

        const after = `${year}-${monthNum}-01`;
        const before = `${nextYear}-${nextMonthNum}-01`;

        console.error(`\n[slack-cli] Processing ${monthName} ${year}...`);

        // My messages for the month
        const messagesResult = await searchUserMessages(auth, {
          username: currentUser.userId,
          after,
          before,
          delay: opts.delay,
          verbose: opts.verbose,
          onProgress: makeProgressCallback(`${monthName} messages`),
        });

        if (messagesResult.messages.length > 0) {
          const msgOutput = opts.format === 'json'
            ? exportMessagesToJSON(messagesResult.messages, {
                title: `Messages - ${monthName} ${year}`,
                dateRange: { after, before },
                user: currentUser,
              })
            : exportMessagesToMarkdown(messagesResult.messages, {
                title: `My Messages - ${monthName} ${year}`,
                total: messagesResult.total,
                groupByChannel: true,
              });
          writeFileSync(join(outputDir, `${monthNum}-${monthName.toLowerCase()}-messages.${ext}`), msgOutput);
          console.error(`  - ${messagesResult.total} messages exported`);
        } else {
          console.error(`  - No messages found`);
        }

        // Mentions for the month
        const mentionsResult = await searchMentions(auth, {
          after,
          before,
          delay: opts.delay,
          verbose: opts.verbose,
        });

        if (mentionsResult.messages.length > 0) {
          const mentionsOutput = opts.format === 'json'
            ? exportMessagesToJSON(mentionsResult.messages, {
                title: `Mentions - ${monthName} ${year}`,
                dateRange: { after, before },
              })
            : exportMessagesToMarkdown(mentionsResult.messages, {
                title: `@Mentions - ${monthName} ${year}`,
                total: mentionsResult.total,
                groupByChannel: true,
              });
          writeFileSync(join(outputDir, `${monthNum}-${monthName.toLowerCase()}-mentions.${ext}`), mentionsOutput);
          console.error(`  - ${mentionsResult.total} mentions exported`);
        } else {
          console.error(`  - No mentions found`);
        }

        // Small delay between months to be nice to API
        await sleep(500);
      }

      console.error(`\n[slack-cli] Year review complete!`);
      console.error(`[slack-cli] Files written to: ${outputDir}/`);

    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// probe command — cheap Slack health check for bulk-pull callers
program
  .command('probe [channel]')
  .description('Pre-flight health check: fetch 1 message from a small channel. Exits 0 if Slack is reachable and not rate-limited, 1 otherwise.')
  .option('--timeout <ms>', 'Fail if probe takes longer than this (default: 10000)', intArg, 10000)
  .action(async (channel, opts) => {
    const probeChannel = channel || 'general';
    const started = Date.now();
    resetTelemetry();

    const timeoutHandle = setTimeout(() => {
      console.error(JSON.stringify({ ok: false, error: 'timeout', latencyMs: opts.timeout, probeChannel }));
      process.exit(1);
    }, opts.timeout);

    try {
      const auth = await getAuth();
      const { channelId, channelName } = await resolveChannel(probeChannel, auth.cookies, auth.token);
      const response = await callSlackApi(
        'conversations.history',
        { channel: channelId, limit: 1 },
        auth.cookies,
        auth.token,
      );
      clearTimeout(timeoutHandle);

      const telemetry = getTelemetry();
      const result = {
        ok: true,
        latencyMs: Date.now() - started,
        probeChannel: channelName || probeChannel,
        messagesReturned: (response.messages || []).length,
        rateLimited: telemetry.rateLimitHits > 0,
        telemetry,
      };
      console.log(JSON.stringify(result));
      process.exit(0);
    } catch (error) {
      clearTimeout(timeoutHandle);
      const telemetry = getTelemetry();
      const result = {
        ok: false,
        error: error.message,
        latencyMs: Date.now() - started,
        probeChannel,
        rateLimited: telemetry.rateLimitHits > 0,
        telemetry,
      };
      console.error(JSON.stringify(result));
      process.exit(1);
    }
  });

// download command — read-only GET of file attachment(s) from a Slack
// message. Resolves the file's private URL via files.info (by file id) or
// conversations.history (by channel + ts), then fetches the bytes with the
// same xoxc token + cookie auth the read paths use. No message is posted and
// nothing is mutated, so this is NOT gated like `send` and does not consult
// the business-hours --force flag (it's a single targeted GET, not a bulk sweep).
program
  .command('download [channel]')
  .description('Download file attachment(s) from a Slack message (read-only GET). '
    + 'Give --file-id for a direct fetch, or a channel + --ts to pull all files on a message, '
    + 'or --url with a message/file permalink.')
  .option('--file-id <id>', 'Slack file id (F…) — fetched directly via files.info')
  .option('--ts <ts>', 'Message timestamp (requires a channel arg)')
  .option('--url <permalink>', 'Message or file permalink (alternative to --file-id / channel+--ts)')
  .option('-o, --output <dir>', 'Output directory (default: current dir)', '.')
  .action(async (channel, opts) => {
    try {
      // Require exactly one resolution mode: --file-id, or channel + --ts, or --url.
      const hasFileId = !!opts.fileId;
      const hasChannelTs = !!(channel && opts.ts);
      const hasUrl = !!opts.url;
      const modes = [hasFileId, hasChannelTs, hasUrl].filter(Boolean).length;
      if (modes !== 1) {
        console.error('[download] Provide exactly one of: --file-id, a channel with --ts, or --url');
        if (channel && !opts.ts) console.error('[download] (a channel arg also needs --ts)');
        process.exit(1);
      }

      const auth = await getAuth();
      console.error('[download] Resolving file(s)...');

      const results = await downloadFiles(auth, {
        fileId: opts.fileId,
        channel,
        ts: opts.ts,
        url: opts.url,
        output: opts.output,
      });

      for (const r of results) {
        console.error(`[download] Wrote ${r.name} (${r.size} bytes${r.mimetype ? `, ${r.mimetype}` : ''}) → ${r.path}`);
      }
      console.log(JSON.stringify({ ok: true, files: results }, null, 2));
    } catch (error) {
      console.error(`[download] Error: ${error.message}`);
      process.exit(1);
    }
  });

// thread command — pinpoint fetch of ONE thread (parent + all replies) via
// conversations.replies with cursor pagination. Read-only and single-target,
// so like `download` it is NOT business-hours gated (the MCP's
// read_slack_thread does the equivalent today). Bulk LOOPS over threads must
// be gated by the calling script, with a slower --delay (conversations.replies
// is a low-tier rate-limited method; auth.js honors 429 Retry-After).
program
  .command('thread <target> [ts]')
  .description('Fetch one thread (parent first, then replies, chronological). '
    + 'Give a permalink (reply permalinks resolve to their parent thread), '
    + 'or a channel (name or C… id) plus the parent thread_ts.')
  .option('-f, --format <format>', 'Output format: json (default), md (alias: markdown)', 'json')
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('--delay <ms>', 'Delay between paginated requests in ms (default: 300)', intArg, 300)
  .option('--max-pages <n>', 'Maximum pages to fetch', intArg)
  .option('--verbose', 'Show detailed API logs')
  .action(async (target, ts, opts) => {
    try {
      let channel, threadTs;
      if (ts) {
        channel = target;
        threadTs = ts;
      } else {
        const parsed = parsePermalink(target);
        if (!parsed || !parsed.channel) {
          console.error('[thread] Provide a message permalink, or: thread <channel> <thread_ts>');
          process.exit(1);
        }
        channel = parsed.channel;
        // A reply permalink carries ?thread_ts=<parent>; prefer it so any
        // message link inside a thread resolves to the whole thread.
        const qs = target.match(/[?&]thread_ts=(\d+\.\d+)/);
        threadTs = qs ? qs[1] : parsed.ts;
      }

      const auth = await getAuth();
      console.error(`[thread] Fetching thread ${threadTs} from ${channel}...`);

      const result = await getThreadReplies(auth, {
        channel,
        threadTs,
        delay: opts.delay,
        maxPages: opts.maxPages,
        verbose: opts.verbose,
        onProgress: makeProgressCallback('thread'),
      });

      console.error(`[thread] Fetched ${result.messages.length} of ${result.total} messages `
        + `(parent reply_count ${Math.max(result.total - 1, 0)})`);

      let output;
      switch (opts.format) {
        case 'md':
        case 'markdown':
          output = exportMessagesToMarkdown(
            // Raw replies carry no channel object or permalink — decorate so
            // the markdown formatter renders channel headers and links.
            result.messages.map(m => ({
              ...m,
              channel: result.channel,
              permalink: buildPermalink(result.channel.id, m.ts, m.thread_ts),
            })),
            {
              title: `Thread ${threadTs} in ${result.channel.name ? '#' + result.channel.name : result.channel.id}`,
              total: result.total,
            },
          );
          break;
        default:
          output = exportThreadToJSON(result.messages, {
            channelId: result.channel.id,
            channelName: result.channel.name,
            threadTs,
            total: result.total,
          });
      }

      writeOutput(output, opts.output);
    } catch (error) {
      console.error(`[thread] Error: ${error.message}`);
      process.exit(1);
    }
  });

// telemetry-footer helper: any command can call this on exit to emit a one-liner
function emitTelemetryFooter() {
  const t = getTelemetry();
  if (t.okCalls + t.failedCalls + t.retries === 0) return;
  console.error(`[slack-cli] telemetry: ${formatTelemetry()}`);
}
process.on('exit', emitTelemetryFooter);

// send command — the message write path (create-channel below is the
// stricter, no-bypass one). The rule is check
// before sending: by default a human types "send" at /dev/tty; --yes
// skips the prompt, for callers that have already shown the user the
// --dry-run preview and gotten explicit approval. The MCP server
// stays read-only.
program
  .command('send <recipient...>')
  .description('Send a Slack message as you — DM a person (@name, U… ID), post to a channel (#name, C… ID), or open a group DM by naming 2+ people. Prompts for confirmation at the terminal; use --dry-run to stage/preview, or --yes to skip the prompt after the user has approved the send.')
  .option('--text <message>', 'Message text')
  .option('--file <path>', 'Read message text from a file (e.g. a standup .md)')
  .option('--thread <ts>', 'Reply in a thread (parent message ts)')
  .option('--dry-run', 'Resolve the recipient and show the full preview, but never prompt or send')
  .option('--yes', 'Skip the confirmation prompt — only after the user has seen the preview and explicitly approved')
  .action(async (recipients, opts) => {
    try {
      if (!!opts.text === !!opts.file) {
        console.error('[send] Provide exactly one of --text or --file');
        process.exit(1);
      }
      const text = (opts.text ?? readFileSync(opts.file, 'utf8')).trim();
      if (!text) {
        console.error('[send] Message is empty');
        process.exit(1);
      }

      const auth = await getAuth();
      // One recipient → DM/channel as before; 2+ → multi-person group DM (mpim).
      const target = recipients.length > 1
        ? await resolveGroupRecipients(recipients, auth.cookies, auth.token)
        : await resolveRecipient(recipients[0], auth.cookies, auth.token);

      // Preview — everything a human needs to judge the send
      console.error('');
      console.error('── send preview ─────────────────────────────────');
      if (target.kind === 'group') {
        console.error(`To:      group DM (${target.members.length} people)`);
        for (const m of target.members) {
          console.error(`           • ${m.label}${m.realName ? ` (${m.realName})` : ''}` +
            `${m.isBot ? '  <-- WARNING: bot' : ''}${m.deleted ? '  <-- WARNING: DEACTIVATED' : ''}`);
        }
        console.error(`Conv:    ${target.channelId} (group)`);
      } else {
        console.error(`To:      ${target.label}${target.realName ? ` (${target.realName})` : ''}`);
        console.error(`Conv:    ${target.channelId} (${target.kind})`);
      }
      if (target.kind === 'dm') {
        console.error(`Bot:     ${target.isBot}${target.isBot ? '  <-- WARNING: recipient is a bot' : ''}`);
      }
      if (target.deleted) console.error('WARNING: recipient account is DEACTIVATED');
      if (opts.thread) console.error(`Thread:  ${opts.thread}`);
      console.error(`Length:  ${text.length} chars`);
      console.error('─────────────────────────────────────────────────');
      console.error(text);
      console.error('─────────────────────────────────────────────────');

      if (opts.dryRun) {
        console.error('[send] Dry run — nothing sent. Deliver with --yes once the user approves, or re-run without --dry-run at a terminal.');
        process.exit(0);
      }

      if (!opts.yes) {
        const confirmed = await confirmOnTty(target.label);
        if (confirmed === null) {
          console.error('[send] No interactive terminal. Check with the user first, then re-run with --yes —');
          console.error('[send] or have them run this command themselves (in Claude Code, prefix it with `!`).');
          process.exit(2);
        }
        if (!confirmed) {
          console.error('[send] Aborted — nothing sent.');
          process.exit(1);
        }
      }

      const result = await postMessage(target.channelId, text, opts.thread, auth.cookies, auth.token);
      console.log(JSON.stringify({
        ok: true,
        channel: result.channel,
        ts: result.ts,
        permalink: buildPermalink(result.channel, result.ts),
      }, null, 2));
    } catch (error) {
      console.error(`[send] Error: ${error.message}`);
      if (error.suggestions) {
        console.error(`[send] Did you mean: ${error.suggestions.join(', ')}`);
      }
      process.exit(1);
    }
  });

// edit command — chat.update on one of your own messages. Sits between `send`
// and `create-channel` on the strictness ladder: an edit is reversible in
// content (you can put the old text back) but not in record — Slack marks the
// message edited forever, and the prior wording leaves the conversation. Per
// SENSIBILITIES #2 that earns the send-tier gate plus three replace-specific
// guards: never edit blind (fetch + diff first), back the original up to disk
// before mutating (#7), and refuse by default when files/attachments/custom
// blocks would be dropped. CLI-only; never on the MCP surface.
program
  .command('edit <channel> <ts>')
  .description('Edit one of your own posted messages (chat.update). Shows a diff of what changes '
    + 'and backs the original up first. Prefer --append or --sub over a wholesale --text; '
    + 'use --dry-run to preview, or --yes to skip the prompt after the user has approved.')
  .option('--text <message>', 'Replace the whole message with this text')
  .option('--file <path>', 'Replace the whole message with the contents of a file')
  .option('--append <text>', 'Keep the message and add this on a new line — the safest mode')
  .option('--append-file <path>', 'Keep the message and append a file\'s contents')
  .option('--sub <find>', 'Replace an exact substring (must match once, unless --all)')
  .option('--with <replacement>', 'What --sub replaces the match with (use "" to delete it)')
  .option('--all', 'Let --sub replace every occurrence instead of insisting on a unique match')
  .option('--allow-lossy', 'Proceed even though files/attachments/custom blocks would be dropped')
  .option('--backup-dir <path>', 'Where to write the pre-edit backup', DEFAULT_BACKUP_DIR)
  .option('--no-backup', 'Skip the pre-edit backup file')
  .option('--dry-run', 'Fetch the message and show the diff, but never prompt or update')
  .option('--yes', 'Skip the confirmation prompt — only after the user has seen the diff and approved')
  .action(async (channel, ts, opts) => {
    try {
      // Exactly one mode. Being strict here is the point: a caller who passed
      // both --text and --append meant one of them, and guessing which would
      // be guessing at a destructive edit.
      const modes = ['text', 'file', 'append', 'appendFile', 'sub'].filter((k) => opts[k] !== undefined);
      if (modes.length !== 1) {
        console.error('[edit] Provide exactly one of --text, --file, --append, --append-file, or --sub'
          + (modes.length > 1 ? ` (got ${modes.length})` : ''));
        process.exit(1);
      }
      if (opts.with !== undefined && opts.sub === undefined) {
        console.error('[edit] --with only means something alongside --sub');
        process.exit(1);
      }

      const auth = await getAuth();
      const { channelId, channelName } = await resolveChannel(channel, auth.cookies, auth.token);
      const label = channelName ? `#${channelName}` : channelId;

      const message = await fetchMessage(channelId, ts, auth.cookies, auth.token);
      if (!message) {
        console.error(`[edit] No message at ts ${ts} in ${label} — check the permalink's p-number `
          + '(1786726124146599 → 1786726124.146599), and that you can read the channel.');
        process.exit(1);
      }

      const me = await getCurrentUser(auth.cookies, auth.token);
      if (message.user !== me.slackId) {
        console.error(`[edit] That message is by ${message.user || message.bot_id || 'someone else'}, not you (${me.slackId}).`);
        console.error('[edit] Slack only allows editing your own messages. Nothing to do here.');
        process.exit(1);
      }

      const current = message.text ?? '';
      const { text: newText, mode, describe } = computeNewText(current, {
        replace: opts.text !== undefined
          ? opts.text
          : (opts.file !== undefined ? readFileSync(opts.file, 'utf8').replace(/\n+$/, '') : undefined),
        append: opts.append !== undefined
          ? opts.append
          : (opts.appendFile !== undefined ? readFileSync(opts.appendFile, 'utf8').replace(/\n+$/, '') : undefined),
        sub: opts.sub,
        with: opts.with,
        all: opts.all,
      });

      if (newText === current) {
        console.error('[edit] The message already reads exactly like that — nothing to change.');
        console.log(JSON.stringify({ ok: true, unchanged: true, channel: channelId, ts }, null, 2));
        process.exit(0);
      }

      const lossy = lossyReasons(message);

      console.error('');
      console.error('── edit preview ─────────────────────────────────');
      console.error(`Channel: ${label} (${channelId})`);
      console.error(`Message: ${ts}`);
      console.error(`         ${buildPermalink(channelId, ts)}`);
      console.error(`Mode:    ${mode} — ${describe}`);
      if (message.edited) console.error(`Note:    already edited before (${message.edited.ts})`);
      if (message.thread_ts && message.thread_ts !== ts) console.error(`Note:    this is a reply in thread ${message.thread_ts}`);
      console.error(`Length:  ${current.length} → ${newText.length} chars`);
      for (const reason of lossy) console.error(`LOSSY:   ${reason}`);
      console.error('─────────────────────────────────────────────────');
      console.error(renderDiff(current, newText));
      console.error('─────────────────────────────────────────────────');

      if (lossy.length && !opts.allowLossy) {
        console.error('[edit] Refusing: chat.update rebuilds the message from text, so the above would');
        console.error('[edit] be lost and cannot be restored by editing back. Re-run with --allow-lossy');
        console.error('[edit] if that is genuinely what you want, or post a follow-up message instead.');
        process.exit(1);
      }

      if (opts.dryRun) {
        console.error('[edit] Dry run — nothing changed. Re-run with --yes once the user approves.');
        process.exit(0);
      }

      if (!opts.yes) {
        const confirmed = await confirmEditOnTty(`Apply this edit to ${label} ${ts} as you`);
        if (confirmed === null) {
          console.error('[edit] No interactive terminal. Show the user this diff, then re-run with --yes —');
          console.error('[edit] or have them run this command themselves (in Claude Code, prefix it with `!`).');
          process.exit(2);
        }
        if (!confirmed) {
          console.error('[edit] Aborted — nothing changed.');
          process.exit(1);
        }
      }

      // Backup before the mutation, not after: if chat.update succeeds and the
      // process then dies, the old text must already be on disk.
      const backup = opts.backup === false ? null : backupMessage(opts.backupDir, channelId, message, newText);
      if (opts.backup !== false && !backup) {
        console.error('[edit] WARNING: could not write the pre-edit backup — proceeding, but the old');
        console.error('[edit] text will only exist in Slack\'s own edit history.');
      }

      const result = await updateMessage(channelId, ts, newText, auth.cookies, auth.token);
      console.error(`EDIT_AUDIT ${new Date().toISOString()} ${mode} ${buildPermalink(channelId, ts)}`
        + ` ${current.length}->${newText.length} chars${backup ? ` backup=${backup}` : ' backup=none'}`);
      console.log(JSON.stringify({
        ok: true,
        channel: result.channel || channelId,
        ts: result.ts || ts,
        mode,
        charsBefore: current.length,
        charsAfter: newText.length,
        backup,
        permalink: buildPermalink(channelId, ts),
      }, null, 2));
    } catch (error) {
      console.error(`[edit] Error: ${error.message}`);
      process.exit(1);
    }
  });

// react command — the lightest write path in this tool. A reaction is
// reversible in one call (--remove undoes it), touches a single message,
// and notifies nobody but the message author, so per SENSIBILITIES #2 it
// takes the send-tier gate: preview, TTY confirm, --yes honored after
// the user has approved. CLI-only; never exposed on the MCP surface.
program
  .command('react <channel> <ts>')
  .description('Add an emoji reaction to a message as you (reversible — --remove undoes it). '
    + 'Prompts for confirmation at the terminal; use --dry-run to preview, '
    + 'or --yes to skip the prompt after the user has approved.')
  .option('--emoji <name>', 'Emoji name, with or without colons', 'done')
  .option('--remove', 'Remove the reaction instead of adding it')
  .option('--dry-run', 'Resolve the target and show the preview, but never prompt or react')
  .option('--yes', 'Skip the confirmation prompt — only after the user has approved')
  .action(async (channel, ts, opts) => {
    try {
      const name = opts.emoji.replace(/^:+|:+$/g, '');
      if (!name) {
        console.error('[react] Empty emoji name');
        process.exit(1);
      }
      const auth = await getAuth();
      const { channelId, channelName } = await resolveChannel(channel, auth.cookies, auth.token);
      const label = channelName ? `#${channelName}` : channelId;
      const action = opts.remove ? 'remove' : 'add';

      console.error('');
      console.error('── react preview ────────────────────────────────');
      console.error(`Channel: ${label} (${channelId})`);
      console.error(`Message: ${ts}`);
      console.error(`         ${buildPermalink(channelId, ts)}`);
      console.error(`Action:  ${action} :${name}:`);
      console.error('─────────────────────────────────────────────────');

      if (opts.dryRun) {
        console.error('[react] Dry run — nothing changed. Re-run with --yes once the user approves.');
        process.exit(0);
      }

      if (!opts.yes) {
        const confirmed = await confirmReactOnTty(`${action === 'remove' ? 'Remove' : 'Add'} :${name}: on ${label} ${ts}`);
        if (confirmed === null) {
          console.error('[react] No interactive terminal. Check with the user first, then re-run with --yes —');
          console.error('[react] or have them run this command themselves (in Claude Code, prefix it with `!`).');
          process.exit(2);
        }
        if (!confirmed) {
          console.error('[react] Aborted — nothing changed.');
          process.exit(1);
        }
      }

      const result = await setReaction(channelId, ts, name, !!opts.remove, auth.cookies, auth.token);
      console.error(`REACT_AUDIT ${new Date().toISOString()} ${action} :${name}: ${buildPermalink(channelId, ts)}`
        + (result.alreadyThere ? ' (already in desired state)' : ''));
      console.log(JSON.stringify({
        ok: true,
        channel: channelId,
        ts,
        emoji: name,
        removed: !!opts.remove,
        alreadyThere: result.alreadyThere,
        permalink: buildPermalink(channelId, ts),
      }, null, 2));
    } catch (error) {
      console.error(`[react] Error: ${error.message}`);
      process.exit(1);
    }
  });

// invite command — add people to an EXISTING channel. Before this verb,
// conversations.invite was reachable only as post-create decoration inside
// create-channel, so "add the new collaborator to the users channel" was a
// manual click. Per SENSIBILITIES #2 the gate matches the blast radius, which
// puts it at the send tier (preview → TTY confirm, or --yes after the user
// approved) rather than create-channel's no-bypass tier: an invite has an
// undo in Slack, a channel name never does.
//
// What an invite carries that a send does not is DISCLOSURE — joining a
// private channel hands over the whole history, and removal does not un-read
// it. So the preview leads with privacy (UNKNOWN is treated as private) and
// shows every invitee's email, since a name resolve alone cannot tell two
// same-named coworkers apart. CLI-only; never exposed on the MCP surface.
program
  .command('invite <channel> <people...>')
  .description('Add one or more people to an existing channel as you. '
    + 'Prompts for confirmation at the terminal; use --dry-run to preview, '
    + 'or --yes to skip the prompt after the user has approved.')
  .option('--dry-run', 'Resolve the channel and people and show the preview, but never prompt or invite')
  .option('--yes', 'Skip the confirmation prompt — only after the user has approved')
  .action(async (channel, people, opts) => {
    try {
      const target = validateInviteTarget(channel);
      const auth = await getAuth();
      const { channelId, channelName } = await resolveChannel(target, auth.cookies, auth.token);
      const meta = await describeChannel(channelId, auth.cookies, auth.token);
      const label = channelName || meta.name ? `#${channelName || meta.name}` : channelId;
      const members = await resolveInviteTargets(people, auth.cookies, auth.token);

      const privacy = !meta.checked ? 'UNKNOWN (treated as private)' : meta.isPrivate ? 'PRIVATE' : 'public';

      console.error('');
      console.error('── invite preview ───────────────────────────────');
      console.error(`Channel: ${label} (${channelId})`);
      console.error(`Privacy: ${privacy}`
        + (meta.numMembers != null ? ` — ${meta.numMembers} members today` : ''));
      if (meta.isArchived) console.error('         ⚠ ARCHIVED — the invite will fail until it is unarchived');
      console.error(`Adding:  ${members.length} ${members.length === 1 ? 'person' : 'people'}`);
      for (const m of members) {
        const flags = [m.isBot ? 'BOT' : null, m.deleted ? 'DEACTIVATED' : null].filter(Boolean);
        console.error(`  • ${m.label}  ${m.realName || ''}`.trimEnd());
        console.error(`    ${m.email || '(no email on profile)'}`
          + (m.title ? ` — ${m.title}` : '')
          + (flags.length ? `  [${flags.join(', ')}]` : ''));
      }
      if (meta.isPrivate || !meta.checked) {
        console.error('');
        console.error('⚠ This channel is private: everyone added gets its ENTIRE message history.');
        console.error('  Removing them later does not un-read it. Confirm the emails above are the');
        console.error('  right people before proceeding.');
      }
      console.error('─────────────────────────────────────────────────');

      if (opts.dryRun) {
        console.error('[invite] Dry run — nobody added. Re-run with --yes once the user approves.');
        process.exit(0);
      }

      if (!opts.yes) {
        const confirmed = await confirmInviteOnTty(
          `Add ${members.map((m) => m.label).join(', ')} to ${privacy === 'public' ? '' : 'the private channel '}${label} as you?`
        );
        if (confirmed === null) {
          console.error('[invite] No interactive terminal. Check with the user first, then re-run with --yes —');
          console.error('[invite] or have them run this command themselves (in Claude Code, prefix it with `!`).');
          process.exit(2);
        }
        if (!confirmed) {
          console.error('[invite] Aborted — nobody added.');
          process.exit(1);
        }
      }

      const results = await inviteToChannel(channelId, members, auth.cookies, auth.token);
      const added = results.filter((r) => r.ok && !r.alreadyThere);
      const already = results.filter((r) => r.ok && r.alreadyThere);
      const failed = results.filter((r) => !r.ok);

      for (const r of results) {
        const state = r.ok ? (r.alreadyThere ? 'already-member' : 'added') : `FAILED:${r.error}`;
        console.error(`INVITE_AUDIT ${new Date().toISOString()} ${state} ${r.slackId} ${r.email || r.label} → ${label} (${channelId})`);
      }
      for (const r of failed) {
        const hint = explainInviteError(r.error);
        console.error(`[invite] ${r.label} not added: ${r.error}${hint ? ` — ${hint}` : ''}`);
      }

      // Partial success is reported, never rolled back: un-inviting the ones
      // that worked because a later one failed would be a second mutation
      // nobody asked for.
      console.log(JSON.stringify({
        ok: failed.length === 0,
        channel: channelId,
        channelName: channelName || meta.name || null,
        isPrivate: meta.isPrivate,
        privacyChecked: meta.checked,
        added: added.map((r) => r.slackId),
        alreadyMembers: already.map((r) => r.slackId),
        failed: failed.map((r) => ({ user: r.slackId, email: r.email, error: r.error })),
      }, null, 2));
      if (failed.length) process.exit(1);
    } catch (error) {
      console.error(`[invite] Error: ${error.message}`);
      if (error.suggestions?.length) {
        console.error(`[invite] Did you mean: ${error.suggestions.join(', ')}`);
      }
      process.exit(1);
    }
  });

// create-channel command — the most strictly gated write path in this tool.
// A channel is an IRREVERSIBLE, workspace-visible mutation: Slack has no
// delete, only archive, and the name stays taken forever. Per SENSIBILITIES
// #2 that means a real TTY gate with NO bypass flag — there is deliberately
// no --yes here, unlike `send`. The confirmation is name-echo, so a reflexive
// "yes" cannot create the wrong channel. An agent's path forward is --dry-run
// to stage the exact command, then hand it to the user to run themselves.
// Never exposed on the MCP surface.
program
  .command('create-channel <name>')
  .description('Create a Slack channel as you (IRREVERSIBLE — Slack has no delete). '
    + 'Requires typing the channel name at an interactive terminal; there is no --yes flag. '
    + 'Use --dry-run to preview and stage the command for a human to run.')
  .option('--private', 'Create a private channel instead of a public one')
  .option('--purpose <text>', "Set the channel's purpose after creation")
  .option('--topic <text>', "Set the channel's topic after creation")
  .option('--invite <people...>', 'Invite people after creation (@name, U… ID, or bare name)')
  .option('--team <id>', 'Grid workspace (T…) to create in — needed only when you belong to more than one')
  .option('--dry-run', 'Validate the name, resolve invitees, show the full preview — never prompt or create')
  .action(async (name, opts) => {
    try {
      // Validate BEFORE auth so a bad name costs nothing and never opens Chrome.
      const { name: channelName, normalized, original } = validateChannelName(name);
      // Slack caps purpose and topic at 250 chars, and they are set AFTER the
      // create — an oversized one fails as too_long and leaves a bare channel
      // behind. Reject up front, while nothing exists.
      for (const [flag, value] of [['--purpose', opts.purpose], ['--topic', opts.topic]]) {
        if (value && value.length > 250) {
          throw new Error(`${flag} is ${value.length} chars; Slack's limit is 250`);
        }
      }

      const auth = await getAuth();

      // Advisory collision check, workspace resolution, and invitee
      // resolution, all while nothing exists yet. Grid's org-level API needs
      // a team_id on create or it fails as cannot_create_channel.
      const availability = await checkNameAvailability(channelName, auth.cookies, auth.token);
      const teamId = await resolveTeamId(auth.cookies, auth.token, opts.team);
      const invitees = opts.invite?.length
        ? await resolveInvitees(opts.invite, auth.cookies, auth.token)
        : [];

      // Preview — everything a human needs to judge an irreversible create.
      console.error('');
      console.error('── create-channel preview ───────────────────────');
      console.error(`Name:    #${channelName}${normalized ? `  (normalized from "${original}")` : ''}`);
      console.error(`Type:    ${opts.private ? 'PRIVATE' : 'public'}`);
      console.error(`Where:   ${teamId ? `workspace ${teamId}` : 'this workspace (not Grid — no team id needed)'}`);
      console.error(`Purpose: ${opts.purpose || '(none)'}`);
      console.error(`Topic:   ${opts.topic || '(none)'}`);
      if (invitees.length) {
        console.error(`Invite:  ${invitees.length} people`);
        for (const m of invitees) {
          console.error(`           • ${m.label}${m.realName ? ` (${m.realName})` : ''}` +
            `${m.isBot ? '  <-- WARNING: bot' : ''}${m.deleted ? '  <-- WARNING: DEACTIVATED' : ''}`);
        }
      } else {
        console.error('Invite:  (nobody — you will be the only member)');
      }
      if (availability.exact) {
        const e = availability.exact;
        console.error(`WARNING: #${e.name} ALREADY EXISTS (${e.id}` +
          `${e.is_private ? ', private' : ''}${e.is_archived ? ', archived' : ''}` +
          `${e.num_members != null ? `, ${e.num_members} members` : ''}) — the create will fail as name_taken`);
      } else if (availability.checked) {
        console.error('Name:    no exact match in Edge search (advisory only — keyword search does');
        console.error('         not see every private channel; Slack decides on create)');
      } else {
        console.error('Name:    availability check did not run (Edge search failed) — unverified');
      }
      if (availability.similar.length) {
        console.error(`Similar: ${availability.similar.map((c) => `#${c.name}`).join(', ')}`);
        console.error('         (consider using one of these instead of creating another)');
      }
      console.error('─────────────────────────────────────────────────');
      console.error('IRREVERSIBLE: Slack cannot delete a channel. The most anyone can do');
      console.error('later is archive it, and the name stays permanently taken.');
      console.error('─────────────────────────────────────────────────');

      if (opts.dryRun) {
        console.error('[create-channel] Dry run — nothing created.');
        console.error('[create-channel] There is no --yes for this verb. To create it, a person must run');
        console.error('[create-channel] this at a terminal and type the channel name:');
        const staged = ['node cli.js create-channel', channelName,
          opts.private ? '--private' : null,
          opts.purpose ? `--purpose ${JSON.stringify(opts.purpose)}` : null,
          opts.topic ? `--topic ${JSON.stringify(opts.topic)}` : null,
          opts.invite?.length ? `--invite ${opts.invite.map((i) => JSON.stringify(i)).join(' ')}` : null,
        ].filter(Boolean).join(' ');
        console.error(`[create-channel]   ${staged}`);
        console.error('[create-channel] (run it in a regular terminal window — Claude Code\'s `!` prefix');
        console.error('[create-channel]  pipes output and has no interactive TTY, so the prompt cannot fire)');
        process.exit(0);
      }

      // The gate. No flag reaches past this — an agent cannot answer /dev/tty.
      const confirmed = await confirmCreateOnTty(channelName, !!opts.private);
      if (confirmed === null) {
        console.error('[create-channel] No interactive terminal — nothing created.');
        console.error('[create-channel] This verb has NO --yes flag: creating a channel is irreversible,');
        console.error('[create-channel] so the person who owns the workspace types the name themselves.');
        console.error('[create-channel] Re-run with --dry-run to stage the command, then have the user run it');
        console.error('[create-channel] in a regular terminal window (not Claude Code\'s `!` — that has no TTY).');
        process.exit(2);
      }
      if (!confirmed) {
        console.error('[create-channel] Aborted — nothing created. (Name must match exactly.)');
        process.exit(1);
      }

      const channel = await createChannel(channelName, !!opts.private, auth.cookies, auth.token, teamId);
      console.error(`[create-channel] AUDIT created #${channel.name} (${channel.id}) ` +
        `${opts.private ? 'private' : 'public'} at ${new Date().toISOString()}`);

      // Everything below decorates a channel that already exists. A failure
      // here is partial success, not a reason to bail — there is nothing to
      // roll back to, so report per-step and keep going.
      const warnings = [];
      if (opts.purpose) {
        try {
          await setPurpose(channel.id, opts.purpose, auth.cookies, auth.token);
        } catch (e) { warnings.push(`purpose not set: ${e.message}`); }
      }
      if (opts.topic) {
        try {
          await setTopic(channel.id, opts.topic, auth.cookies, auth.token);
        } catch (e) { warnings.push(`topic not set: ${e.message}`); }
      }
      let invited = [];
      if (invitees.length) {
        try {
          await inviteMembers(channel.id, invitees.map((m) => m.slackId), auth.cookies, auth.token);
          invited = invitees.map((m) => m.label);
          console.error(`[create-channel] AUDIT invited ${invited.length} to ${channel.id}: ${invited.join(', ')}`);
        } catch (e) {
          warnings.push(`invites failed (channel still created): ${e.message}`);
        }
      }
      for (const w of warnings) console.error(`[create-channel] WARNING: ${w}`);

      console.log(JSON.stringify({
        ok: true,
        channel: { id: channel.id, name: channel.name, is_private: !!channel.is_private },
        invited,
        warnings,
        url: `${getPermalinkBase()}archives/${channel.id}`,
      }, null, 2));
      // Exit explicitly (like send does): the /dev/tty confirm leaves a
      // pending character-device read in the threadpool that destroy()
      // cannot cancel on macOS, and it would hold the process open until
      // the operator presses another key.
      process.exit(0);
    } catch (error) {
      console.error(`[create-channel] Error: ${error.message}`);
      if (error.suggestions) {
        console.error(`[create-channel] Did you mean: ${error.suggestions.join(', ')}`);
      }
      process.exit(1);
    }
  });

// login command (force re-authentication)
program
  .command('login')
  .description('Force re-authentication with Slack')
  .action(async () => {
    try {
      console.error('[slack-cli] Clearing existing auth...');
      deleteAuthFile();

      console.error('[slack-cli] Opening browser for login...');
      await getAuth({ forceLogin: true });

      console.error('[slack-cli] Login successful!');
    } catch (error) {
      console.error(`[slack-cli] Login failed: ${error.message}`);
      process.exit(1);
    }
  });

// whoami command — also the quickest "is this configured?" check: the
// workspace line prints before any network or browser, and a missing
// configuration stops here with the env var and file named.
program
  .command('whoami')
  .description('Show the configured workspace and the currently authenticated user')
  .action(async () => {
    try {
      getWorkspaceUrl(); // a missing configuration stops here, with the fix named
      const cfg = describeConfig();
      console.log(`Workspace: ${cfg.workspace} (from ${cfg.source})`);
      const auth = await getAuth();
      const user = await getCurrentUser(auth.cookies, auth.token);

      console.log(`Username: ${user.userId}`);
      console.log(`Slack ID: ${user.slackId}`);
      console.log(`Team: ${user.team}`);
      console.log(`Team ID: ${user.teamId}`);
      if (user.enterpriseId) console.log(`Enterprise ID: ${user.enterpriseId}`);
    } catch (error) {
      console.error(`[slack-cli] Error: ${error.message}`);
      process.exit(1);
    }
  });

// Parse and run
program.parse();
