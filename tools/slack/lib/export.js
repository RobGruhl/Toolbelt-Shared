/**
 * Output formatters for CLI export.
 * Supports markdown, JSON, and CSV formats.
 */

import { buildPermalink, formatTimestamp } from './queries.js';

/**
 * Escape CSV field value.
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Escape quotes by doubling them, wrap in quotes if contains comma/quote/newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format reactions as a string.
 */
function formatReactions(reactions) {
  if (!reactions || reactions.length === 0) return '';
  return reactions.map(r => `:${r.name}: (${r.count})`).join(' ');
}

/**
 * Export messages to markdown format.
 *
 * @param {Array} messages - Array of Slack messages
 * @param {object} opts - Options
 * @param {string} opts.title - Document title
 * @param {string} opts.subtitle - Subtitle/description
 * @param {number} opts.total - Total count (may differ from messages.length)
 * @param {boolean} opts.includePermalinks - Include message permalinks
 * @param {boolean} opts.groupByChannel - Group messages by channel
 * @param {boolean} opts.groupByDate - Group messages by date
 */
export function exportMessagesToMarkdown(messages, opts = {}) {
  const {
    title = 'Slack Messages',
    subtitle = '',
    total,
    includePermalinks = true,
    groupByChannel = false,
    groupByDate = false,
  } = opts;

  let output = `# ${title}\n\n`;

  if (subtitle) {
    output += `${subtitle}\n\n`;
  }

  const displayTotal = total !== undefined ? total : messages.length;
  output += `**Total messages**: ${displayTotal}`;
  if (messages.length < displayTotal) {
    output += ` (showing ${messages.length})`;
  }
  output += '\n\n';

  if (groupByChannel) {
    // Group by channel
    const byChannel = new Map();
    for (const msg of messages) {
      const channelName = msg.channel?.name || 'unknown';
      if (!byChannel.has(channelName)) {
        byChannel.set(channelName, []);
      }
      byChannel.get(channelName).push(msg);
    }

    // Sort channels by message count (descending)
    const sortedChannels = [...byChannel.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [channelName, channelMsgs] of sortedChannels) {
      output += `## #${channelName} (${channelMsgs.length} messages)\n\n`;
      for (const msg of channelMsgs) {
        output += formatMessageMarkdown(msg, { includePermalinks, includeChannel: false });
      }
    }
  } else if (groupByDate) {
    // Group by date
    const byDate = new Map();
    for (const msg of messages) {
      const date = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }) : 'Unknown date';

      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date).push(msg);
    }

    for (const [date, dateMsgs] of byDate) {
      output += `## ${date} (${dateMsgs.length} messages)\n\n`;
      for (const msg of dateMsgs) {
        output += formatMessageMarkdown(msg, { includePermalinks, includeChannel: true });
      }
    }
  } else {
    // No grouping
    output += '---\n\n';
    for (const msg of messages) {
      output += formatMessageMarkdown(msg, { includePermalinks, includeChannel: true });
    }
  }

  return output;
}

/**
 * Format a single message as markdown.
 */
function formatMessageMarkdown(msg, opts = {}) {
  const { includePermalinks = true, includeChannel = true } = opts;

  const time = msg.ts ? formatTimestamp(msg.ts) : 'Unknown time';
  const author = msg.username || msg.user || 'Unknown';
  const channelName = msg.channel?.name;
  const channelId = msg.channel?.id;
  const text = msg.text || '[No text content]';
  const permalink = msg.permalink || buildPermalink(channelId, msg.ts);
  const reactions = formatReactions(msg.reactions);

  let output = '';

  // Header line
  if (includeChannel && channelName) {
    output += `### #${channelName}\n`;
  }

  output += `**${author}** (${time})\n\n`;
  output += `${text}\n`;

  if (reactions) {
    output += `\n_Reactions: ${reactions}_\n`;
  }

  if (msg.attachments && msg.attachments.length > 0) {
    output += `\n_[${msg.attachments.length} attachment(s)]_\n`;
  }

  if (msg.files && msg.files.length > 0) {
    const fileList = msg.files.map(f => f.name || 'file').join(', ');
    output += `\n_Files: ${fileList}_\n`;
  }

  if (includePermalinks && permalink) {
    output += `\n[View message](${permalink})\n`;
  }

  output += '\n---\n\n';
  return output;
}

/**
 * Normalize one raw Slack message into the documented JSON export shape.
 *
 * Works for both source shapes this tool sees: search.messages matches
 * (which carry their own channel object and permalink) and raw
 * conversations.replies messages (which carry neither — `ctx` supplies the
 * channel context and the permalink is synthesized, with `?thread_ts=` for
 * replies). Keys with undefined values (e.g. `subtype`, `reactions` when
 * absent) are dropped by JSON.stringify, so search-sourced output is
 * unchanged by the fallbacks.
 *
 * @param {object} msg - Raw Slack message
 * @param {object} ctx - { channelId, channelName } fallbacks for raw replies
 */
export function mapMessageToExport(msg, ctx = {}) {
  const channelId = msg.channel?.id ?? ctx.channelId;
  return {
    ts: msg.ts,
    datetime: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : null,
    user: msg.user || msg.username,
    channel: msg.channel?.name ?? ctx.channelName,
    channelId,
    text: msg.text,
    permalink: msg.permalink || buildPermalink(channelId, msg.ts, msg.thread_ts),
    reactions: msg.reactions,
    threadTs: msg.thread_ts,
    replyCount: msg.reply_count,
    subtype: msg.subtype,
    attachments: msg.attachments?.length || 0,
    files: msg.files?.map(f => f.name) || [],
  };
}

/**
 * Export messages to JSON format.
 */
export function exportMessagesToJSON(messages, opts = {}) {
  const {
    title,
    total,
    dateRange,
    user,
    pretty = true,
  } = opts;

  const output = {
    metadata: {
      title,
      exportedAt: new Date().toISOString(),
      total: total || messages.length,
      count: messages.length,
      dateRange,
      user,
    },
    messages: messages.map(msg => mapMessageToExport(msg)),
  };

  return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Export one thread (parent + replies) to JSON format.
 *
 * The metadata block deliberately differs from exportMessagesToJSON's:
 * `fetchedAt` and snake-case `thread_ts` are the shared contract with the
 * downstream harvest tooling. `metadata.total` (parent reply_count + 1 as
 * Slack reports it) vs `metadata.count` (messages actually fetched) is the
 * truncation signal downstream guards compare.
 */
export function exportThreadToJSON(messages, opts = {}) {
  const { channelId, channelName, threadTs, total, pretty = true } = opts;

  const output = {
    metadata: {
      channel: channelName,
      channelId,
      thread_ts: threadTs,
      total: total ?? messages.length,
      count: messages.length,
      fetchedAt: new Date().toISOString(),
    },
    messages: messages.map(msg => mapMessageToExport(msg, { channelId, channelName })),
  };

  return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Export messages to CSV format.
 */
export function exportMessagesToCSV(messages, opts = {}) {
  const headers = [
    'datetime',
    'channel',
    'user',
    'text',
    'permalink',
    'reactions',
    'thread_ts',
    'reply_count',
    'attachments',
    'files',
  ];

  let output = headers.join(',') + '\n';

  for (const msg of messages) {
    const row = [
      msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
      msg.channel?.name || '',
      msg.user || msg.username || '',
      msg.text || '',
      msg.permalink || buildPermalink(msg.channel?.id, msg.ts) || '',
      formatReactions(msg.reactions),
      msg.thread_ts || '',
      msg.reply_count || '',
      msg.attachments?.length || 0,
      msg.files?.map(f => f.name).join('; ') || '',
    ];

    output += row.map(escapeCSV).join(',') + '\n';
  }

  return output;
}

/**
 * Export channels to markdown format.
 */
export function exportChannelsToMarkdown(channels, opts = {}) {
  const { title = 'My Channels' } = opts;

  let output = `# ${title}\n\n`;
  output += `**Total channels**: ${channels.length}\n\n`;

  // Separate public and private
  const publicChannels = channels.filter(c => !c.is_private);
  const privateChannels = channels.filter(c => c.is_private);

  if (publicChannels.length > 0) {
    output += `## Public Channels (${publicChannels.length})\n\n`;
    output += '| Channel | ID | Members | Purpose |\n';
    output += '|---------|----|---------|---------|\n';
    for (const ch of publicChannels) {
      const purpose = (ch.purpose?.value || '').substring(0, 50) + (ch.purpose?.value?.length > 50 ? '...' : '');
      output += `| #${ch.name} | ${ch.id} | ${ch.num_members || '-'} | ${purpose} |\n`;
    }
    output += '\n';
  }

  if (privateChannels.length > 0) {
    output += `## Private Channels (${privateChannels.length})\n\n`;
    output += '| Channel | ID | Members | Purpose |\n';
    output += '|---------|----|---------|---------|\n';
    for (const ch of privateChannels) {
      const purpose = (ch.purpose?.value || '').substring(0, 50) + (ch.purpose?.value?.length > 50 ? '...' : '');
      output += `| #${ch.name} | ${ch.id} | ${ch.num_members || '-'} | ${purpose} |\n`;
    }
    output += '\n';
  }

  return output;
}

/**
 * Export channels to JSON format.
 */
export function exportChannelsToJSON(channels, opts = {}) {
  const { pretty = true } = opts;

  const output = {
    metadata: {
      exportedAt: new Date().toISOString(),
      total: channels.length,
    },
    channels: channels.map(ch => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.is_private,
      isArchived: ch.is_archived,
      members: ch.num_members,
      purpose: ch.purpose?.value,
      topic: ch.topic?.value,
      created: ch.created ? new Date(ch.created * 1000).toISOString() : null,
    })),
  };

  return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Export channels to CSV format.
 */
export function exportChannelsToCSV(channels) {
  const headers = ['name', 'id', 'is_private', 'members', 'purpose', 'topic', 'created'];
  let output = headers.join(',') + '\n';

  for (const ch of channels) {
    const row = [
      ch.name,
      ch.id,
      ch.is_private ? 'true' : 'false',
      ch.num_members || '',
      ch.purpose?.value || '',
      ch.topic?.value || '',
      ch.created ? new Date(ch.created * 1000).toISOString() : '',
    ];
    output += row.map(escapeCSV).join(',') + '\n';
  }

  return output;
}

/**
 * Export reactions to markdown format.
 */
export function exportReactionsToMarkdown(items, opts = {}) {
  const { title = 'My Reactions' } = opts;

  let output = `# ${title}\n\n`;
  output += `**Total items**: ${items.length}\n\n`;

  for (const item of items) {
    if (item.type === 'message' && item.message) {
      const msg = item.message;
      const channel = item.channel?.name || 'unknown';
      const time = msg.ts ? formatTimestamp(msg.ts) : 'Unknown time';
      const author = msg.user || 'Unknown';
      const text = (msg.text || '').substring(0, 200) + (msg.text?.length > 200 ? '...' : '');
      const permalink = msg.permalink || buildPermalink(item.channel?.id, msg.ts);

      output += `### #${channel}\n`;
      output += `**${author}** (${time})\n\n`;
      output += `${text}\n`;

      // Show which reactions you added
      const myReactions = item.reactions || [];
      if (myReactions.length > 0) {
        output += `\n_Your reactions: ${myReactions.map(r => `:${r}:`).join(' ')}_\n`;
      }

      if (permalink) {
        output += `\n[View message](${permalink})\n`;
      }

      output += '\n---\n\n';
    }
  }

  return output;
}

/**
 * Export reactions to JSON format.
 */
export function exportReactionsToJSON(items, opts = {}) {
  const { pretty = true } = opts;

  const output = {
    metadata: {
      exportedAt: new Date().toISOString(),
      total: items.length,
    },
    reactions: items.map(item => ({
      type: item.type,
      channel: item.channel?.name,
      channelId: item.channel?.id,
      message: item.message ? {
        ts: item.message.ts,
        datetime: item.message.ts ? new Date(parseFloat(item.message.ts) * 1000).toISOString() : null,
        user: item.message.user,
        text: item.message.text,
        permalink: item.message.permalink || buildPermalink(item.channel?.id, item.message.ts),
      } : null,
      yourReactions: item.reactions,
    })),
  };

  return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Export summary statistics to markdown.
 */
export function exportSummaryToMarkdown(stats, opts = {}) {
  const { title = 'Slack Activity Summary' } = opts;

  let output = `# ${title}\n\n`;

  if (stats.user) {
    output += `**User**: ${stats.user.userId}\n\n`;
  }

  if (stats.dateRange) {
    const { after, before } = stats.dateRange;
    if (after || before) {
      output += `**Date Range**: ${after || 'beginning'} to ${before || 'present'}\n\n`;
    }
  }

  output += `## Summary\n\n`;
  output += `| Metric | Count |\n`;
  output += `|--------|-------|\n`;
  output += `| Messages sent | ${stats.messagesSent || 0} |\n`;
  output += `| Mentions received | ${stats.mentionsReceived || 0} |\n`;
  output += `| Channels active in | ${stats.channelsActive || 0} |\n`;

  return output;
}

/**
 * Generic export function that dispatches to the correct formatter.
 */
export function exportData(type, data, format, opts = {}) {
  const formatters = {
    messages: {
      md: exportMessagesToMarkdown,
      json: exportMessagesToJSON,
      csv: exportMessagesToCSV,
    },
    channels: {
      md: exportChannelsToMarkdown,
      json: exportChannelsToJSON,
      csv: exportChannelsToCSV,
    },
    reactions: {
      md: exportReactionsToMarkdown,
      json: exportReactionsToJSON,
    },
    summary: {
      md: exportSummaryToMarkdown,
    },
  };

  const typeFormatters = formatters[type];
  if (!typeFormatters) {
    throw new Error(`Unknown export type: ${type}`);
  }

  const formatter = typeFormatters[format];
  if (!formatter) {
    throw new Error(`Format "${format}" not supported for type "${type}". Supported: ${Object.keys(typeFormatters).join(', ')}`);
  }

  return formatter(data, opts);
}
