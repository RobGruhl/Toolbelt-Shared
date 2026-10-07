#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  getAuthCookies,
  callSlackApi,
  deleteAuthFile,
  resolveUsername,
  lookupUser,
  resolveChannel,
  getCurrentUser,
  listUserChannels,
} from './auth.js';
import { getPermalinkBase } from './lib/config.js';

// Constants
const SLACK_URL_REGEX = /archives\/([A-Z0-9]+)\/p(\d+)$/;

// Server state
let cachedAuth = null;

/**
 * Ensure we have valid auth (cookies + token).
 */
async function ensureAuth() {
  if (!cachedAuth) {
    console.error('[slack-cli] Getting auth...');
    cachedAuth = await getAuthCookies();
    console.error('[slack-cli] Auth obtained');
  }
  return cachedAuth;
}

/**
 * Refresh auth (called on auth expiration).
 */
async function refreshAuth() {
  console.error('[slack-cli] Refreshing auth...');
  cachedAuth = null;
  deleteAuthFile();
  cachedAuth = await getAuthCookies(true);
  return cachedAuth;
}

/**
 * Execute API call with auth retry.
 */
async function withAuthRetry(fn) {
  try {
    const auth = await ensureAuth();
    return await fn(auth.cookies, auth.token);
  } catch (error) {
    if (error.message === 'AUTH_EXPIRED') {
      const auth = await refreshAuth();
      return await fn(auth.cookies, auth.token);
    }
    throw error;
  }
}

/**
 * Parse a Slack permalink URL to extract channel ID and message timestamp.
 */
function parseSlackUrl(url) {
  const match = url.match(SLACK_URL_REGEX);
  if (!match) {
    throw new Error('Invalid Slack permalink format. Expected: https://<workspace>.slack.com/archives/{channel_id}/p{timestamp}');
  }

  const channelId = match[1];
  const rawTs = match[2];
  const ts = rawTs.slice(0, 10) + '.' + rawTs.slice(10);

  return { channelId, ts };
}

/**
 * Format a Unix timestamp to a readable date string.
 */
function formatTimestamp(ts) {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Build a permalink from channel ID and timestamp.
 */
function buildPermalink(channelId, ts) {
  if (!channelId || !ts) return null;
  const rawTs = ts.replace('.', '');
  return `${getPermalinkBase()}archives/${channelId}/p${rawTs}`;
}

/**
 * Format a message for display.
 */
function formatMessage(msg) {
  const author = msg.user || msg.bot_id || 'Unknown';
  const time = formatTimestamp(msg.ts);
  const text = msg.text || '[No text content]';

  let formatted = `**${author}** (${time}):\n${text}`;

  if (msg.reactions && msg.reactions.length > 0) {
    const reactionList = msg.reactions.map(r => `:${r.name}: (${r.count})`).join(' ');
    formatted += `\n_Reactions: ${reactionList}_`;
  }

  if (msg.attachments && msg.attachments.length > 0) {
    formatted += `\n_[${msg.attachments.length} attachment(s)]_`;
  }

  if (msg.files && msg.files.length > 0) {
    const fileList = msg.files.map(f => f.name || 'file').join(', ');
    formatted += `\n_Files: ${fileList}_`;
  }

  return formatted;
}

/**
 * Build date filter string for search queries.
 */
function buildDateFilter(after, before) {
  const parts = [];
  if (after) parts.push(`after:${after}`);
  if (before) parts.push(`before:${before}`);
  return parts.join(' ');
}

// Create MCP server
const server = new McpServer({
  name: 'slack',
  version: '0.1.0',
  description: 'Read-only access to your Slack workspace as yourself: read threads, search messages, look up people, list your channels. No write tools exist on this surface.',
});

// Register read_slack_thread tool
server.registerTool(
  'read_slack_thread',
  {
    description:
      'Read a Slack message or thread from a permalink URL. Returns formatted content including: author, timestamp, message text, reactions, attachments, and all thread replies if present.\n\n' +
      'When to use:\n' +
      '- When given a Slack URL to read\n' +
      '- When you need the full context of a discussion\n\n' +
      'Supported URL formats:\n' +
      '- https://<workspace>.slack.com/archives/{channel}/p{timestamp}\n' +
      '- https://<org>.enterprise.slack.com/archives/{channel}/p{timestamp}',
    inputSchema: {
      url: z.string().describe('Slack permalink URL (e.g., https://yourco.slack.com/archives/C.../p1700000000000000)'),
    },
  },
  async ({ url }) => {
    try {
      const { channelId, ts } = parseSlackUrl(url);

      const historyResponse = await withAuthRetry((cookies, token) =>
        callSlackApi('conversations.history', {
          channel: channelId,
          oldest: ts,
          latest: ts,
          inclusive: true,
          limit: 1,
        }, cookies, token)
      );

      if (!historyResponse.messages || historyResponse.messages.length === 0) {
        return {
          content: [{ type: 'text', text: `No message found at ${url}` }],
          isError: true,
        };
      }

      const mainMessage = historyResponse.messages[0];
      let result = `**Message from ${url}**\n\n`;
      result += formatMessage(mainMessage);

      if (mainMessage.reply_count && mainMessage.reply_count > 0) {
        result += `\n\n---\n**Thread Replies (${mainMessage.reply_count}):**\n\n`;

        const repliesResponse = await withAuthRetry((cookies, token) =>
          callSlackApi('conversations.replies', {
            channel: channelId,
            ts: mainMessage.thread_ts || ts,
            limit: 100,
          }, cookies, token)
        );

        if (repliesResponse.messages && repliesResponse.messages.length > 1) {
          repliesResponse.messages.slice(1).forEach(msg => {
            result += formatMessage(msg) + '\n\n';
          });
        }
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading Slack thread: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Register get_channel_messages tool
server.registerTool(
  'get_channel_messages',
  {
    description:
      'Get recent messages from a Slack channel. Returns messages in chronological order (newest first).\n\n' +
      'When to use:\n' +
      '- Getting the latest messages or announcements from a channel\n' +
      '- Browsing recent channel activity\n\n' +
      'Supports both channel names and direct channel IDs (for private channels).',
    inputSchema: {
      channel_name: z.string().describe('Channel name (e.g., "announcements") or channel ID (a C... id; required for most private channels). Do not include the # symbol.'),
      limit: z.number().optional().default(10).describe('Maximum messages to return (default: 10, max: 50)'),
    },
  },
  async ({ channel_name, limit }) => {
    try {
      const auth = await ensureAuth();

      // Use resolveChannel to handle both names and IDs
      const { channelId, channelName } = await resolveChannel(channel_name, auth.cookies, auth.token);

      const messageLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);

      const historyResponse = await withAuthRetry((cookies, token) =>
        callSlackApi('conversations.history', {
          channel: channelId,
          limit: messageLimit,
        }, cookies, token)
      );

      if (!historyResponse.messages || historyResponse.messages.length === 0) {
        return {
          content: [{ type: 'text', text: `No messages found in ${channelName ? '#' + channelName : channelId}` }],
        };
      }

      const displayName = channelName ? `#${channelName}` : channelId;
      let result = `**Recent Messages in ${displayName}**\n`;
      result += `Showing ${historyResponse.messages.length} most recent messages:\n\n`;

      for (const msg of historyResponse.messages) {
        const permalink = buildPermalink(channelId, msg.ts);
        const time = formatTimestamp(msg.ts);
        const author = msg.username || msg.user || 'Unknown';
        const preview = (msg.text || '').substring(0, 200) + (msg.text?.length > 200 ? '...' : '');
        const replyInfo = msg.reply_count ? ` (${msg.reply_count} replies)` : '';

        result += `---\n`;
        result += `**${author}** (${time})${replyInfo}\n`;
        result += `${preview}\n`;
        if (permalink) {
          result += `[View message](${permalink})\n\n`;
        } else {
          result += `\n`;
        }
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error fetching channel messages: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Register search_slack_channel tool
server.registerTool(
  'search_slack_channel',
  {
    description:
      'Search for messages in a Slack channel. Returns matching messages with author, timestamp, preview text, and permalink.\n\n' +
      'When to use:\n' +
      '- Finding discussions about a topic in a channel\n' +
      '- Looking up what someone said about something\n' +
      '- Searching for announcements or updates\n\n' +
      'Supports channel names and channel IDs (for private channels).\n' +
      'Supports date filtering with after/before parameters.\n\n' +
      'Search filters:\n' +
      '- Keywords: Just type words to search\n' +
      '- from:username - Filter by user',
    inputSchema: {
      channel_name: z.string().describe('Channel name (e.g., "announcements") or channel ID (a C... id). Do not include # symbol.'),
      query: z.string().describe('Search keywords. Supports from:username filter.'),
      after: z.string().optional().describe('Only messages after this date (YYYY-MM-DD)'),
      before: z.string().optional().describe('Only messages before this date (YYYY-MM-DD)'),
      limit: z.number().optional().default(10).describe('Maximum results (default: 10, max: 25)'),
      sort: z.enum(['newest', 'relevance']).optional().default('newest').describe('Sort order'),
    },
  },
  async ({ channel_name, query, after, before, limit, sort }) => {
    try {
      const auth = await ensureAuth();

      // Resolve channel
      const { channelId, channelName } = await resolveChannel(channel_name, auth.cookies, auth.token);

      // Resolve from:username if present
      let resolvedQuery = query;
      const quotedMatch = query.match(/from:@?"([^"]+)"/);
      const simpleMatch = query.match(/from:@?([A-Za-z][\w.-]*)/);
      const fromMatch = quotedMatch || simpleMatch;

      if (fromMatch) {
        const username = fromMatch[1];
        const alreadyUsername = /^\d+$/.test(username);
        if (!alreadyUsername) {
          const resolution = await resolveUsername(username, auth.cookies, auth.token);
          if (resolution.error) {
            return {
              content: [{ type: 'text', text: resolution.error }],
              isError: true,
            };
          }
          const fromPattern = quotedMatch ? /from:@?"[^"]+"/ : /from:@?[A-Za-z][\w.-]*/;
          resolvedQuery = query.replace(fromPattern, `from:${resolution.userId}`);
        }
      }

      // Build search query with channel and date filters
      const channelFilter = channelName ? `in:#${channelName}` : `in:<#${channelId}>`;
      const dateFilter = buildDateFilter(after, before);
      const searchQuery = [channelFilter, resolvedQuery, dateFilter].filter(Boolean).join(' ');

      const resultLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 25);
      const sortField = sort === 'relevance' ? 'score' : 'timestamp';

      const searchResponse = await withAuthRetry((cookies, token) =>
        callSlackApi('search.messages', {
          query: searchQuery,
          count: resultLimit,
          sort: sortField,
          sort_dir: 'desc',
        }, cookies, token)
      );

      if (!searchResponse.messages?.matches || searchResponse.messages.matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No results found for "${query}" in ${channelName ? '#' + channelName : channelId}` }],
        };
      }

      const matches = searchResponse.messages.matches;
      const totalCount = searchResponse.messages.total || matches.length;
      const displayName = channelName ? `#${channelName}` : channelId;
      const sortLabel = sort === 'relevance' ? 'relevance' : 'date';

      let result = `**Search Results for "${query}" in ${displayName}**\n`;
      if (after || before) {
        result += `_Date range: ${after || 'beginning'} to ${before || 'now'}_\n`;
      }
      result += `Found ${totalCount} matches (showing ${matches.length}, sorted by ${sortLabel}):\n\n`;

      for (const msg of matches) {
        const permalink = msg.permalink || buildPermalink(msg.channel?.id, msg.ts);
        const time = msg.ts ? formatTimestamp(msg.ts) : 'Unknown time';
        const author = msg.username || msg.user || 'Unknown';
        const preview = (msg.text || '').substring(0, 200) + (msg.text?.length > 200 ? '...' : '');

        result += `---\n`;
        result += `**${author}** (${time})\n`;
        result += `${preview}\n`;
        if (permalink) {
          result += `[View message](${permalink})\n\n`;
        } else {
          result += `\n`;
        }
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching Slack: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Register search_user_messages tool
server.registerTool(
  'search_user_messages',
  {
    description:
      'Search for messages from a specific user across all channels.\n\n' +
      'When to use:\n' +
      '- Finding what a specific person has been posting\n' +
      '- Looking up discussions from a particular user\n\n' +
      'Supports date filtering for performance review data collection.',
    inputSchema: {
      username: z.string().describe('Username or display name'),
      query: z.string().optional().default('').describe('Optional additional search keywords'),
      after: z.string().optional().describe('Only messages after this date (YYYY-MM-DD)'),
      before: z.string().optional().describe('Only messages before this date (YYYY-MM-DD)'),
      limit: z.number().optional().default(10).describe('Maximum results (default: 10, max: 25)'),
      sort: z.enum(['newest', 'relevance']).optional().default('newest').describe('Sort order'),
    },
  },
  async ({ username, query, after, before, limit, sort }) => {
    try {
      const auth = await ensureAuth();

      let fromUser = username;
      let displayName = username;

      const alreadyUsername = /^\d+$/.test(username);
      if (!alreadyUsername) {
        const resolution = await resolveUsername(username, auth.cookies, auth.token);
        if (resolution.error) {
          return {
            content: [{ type: 'text', text: resolution.error }],
            isError: true,
          };
        }
        fromUser = resolution.userId;
        displayName = resolution.displayName;
      }

      // Build search query with date filters
      const dateFilter = buildDateFilter(after, before);
      const searchQuery = [`from:${fromUser}`, query, dateFilter].filter(Boolean).join(' ');

      const resultLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 25);
      const sortField = sort === 'relevance' ? 'score' : 'timestamp';

      const searchResponse = await withAuthRetry((cookies, token) =>
        callSlackApi('search.messages', {
          query: searchQuery,
          count: resultLimit,
          sort: sortField,
          sort_dir: 'desc',
        }, cookies, token)
      );

      if (!searchResponse.messages?.matches || searchResponse.messages.matches.length === 0) {
        const queryPart = query ? ` matching "${query}"` : '';
        const datePart = (after || before) ? ` (${after || 'beginning'} to ${before || 'now'})` : '';
        return {
          content: [{ type: 'text', text: `No messages found from ${displayName}${queryPart}${datePart}` }],
        };
      }

      const matches = searchResponse.messages.matches;
      const totalCount = searchResponse.messages.total || matches.length;
      const sortLabel = sort === 'relevance' ? 'relevance' : 'date';
      const queryPart = query ? ` matching "${query}"` : '';

      let result = `**Messages from ${displayName}${queryPart}**\n`;
      if (after || before) {
        result += `_Date range: ${after || 'beginning'} to ${before || 'now'}_\n`;
      }
      result += `Found ${totalCount} messages (showing ${matches.length}, sorted by ${sortLabel}):\n\n`;

      for (const msg of matches) {
        const permalink = msg.permalink || buildPermalink(msg.channel?.id, msg.ts);
        const time = msg.ts ? formatTimestamp(msg.ts) : 'Unknown time';
        const channelName = msg.channel?.name ? `#${msg.channel.name}` : 'Unknown channel';
        const preview = (msg.text || '').substring(0, 200) + (msg.text?.length > 200 ? '...' : '');

        result += `---\n`;
        result += `**${channelName}** (${time})\n`;
        result += `${preview}\n`;
        if (permalink) {
          result += `[View message](${permalink})\n\n`;
        } else {
          result += `\n`;
        }
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching user messages: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Register lookup_user tool
server.registerTool(
  'lookup_user',
  {
    description:
      'Look up a Slack user by username or display name. Returns profile info and status.\n\n' +
      'When to use:\n' +
      '- Finding if someone is still active\n' +
      '- Checking someone\'s status (vacation, etc.)\n' +
      '- Looking up contact information',
    inputSchema: {
      query: z.string().describe('Username or display name'),
    },
  },
  async ({ query }) => {
    try {
      const auth = await ensureAuth();
      const result = await lookupUser(query, auth.cookies, auth.token);

      if (result.error) {
        return {
          content: [{ type: 'text', text: result.error }],
          isError: true,
        };
      }

      if (result.users) {
        let output = `**Multiple users match "${query}"**\n\n`;
        output += '| Name | Display Name | Username | Title | Status |\n';
        output += '|------|--------------|----------|-------|--------|\n';

        for (const u of result.users) {
          const status = u.deleted ? 'Deactivated' : 'Active';
          output += `| ${u.realName || '-'} | ${u.displayName || '-'} | ${u.username || '-'} | ${u.title || '-'} | ${status} |\n`;
        }

        output += '\nPlease refine your search.';
        return { content: [{ type: 'text', text: output }] };
      }

      const user = result.user;
      const profile = user.profile || {};
      const displayName = profile.display_name || profile.real_name || user.name;
      const isDeactivated = user.deleted === true;

      let output = `**User: ${user.real_name || displayName}**${isDeactivated ? ' (deactivated)' : ''}\n\n`;
      output += '| Field | Value |\n';
      output += '|-------|-------|\n';
      output += `| Display Name | ${profile.display_name || '-'} |\n`;
      output += `| Username | ${user.name || '-'} |\n`;
      output += `| Slack ID | ${user.id || '-'} |\n`;
      output += `| Email | ${profile.email || '-'} |\n`;
      output += `| Title | ${profile.title || '-'} |\n`;
      output += `| Account Status | ${isDeactivated ? '**Deactivated**' : 'Active'} |\n`;

      if (profile.status_text || profile.status_emoji) {
        let statusValue = '';
        if (profile.status_emoji) statusValue += profile.status_emoji + ' ';
        if (profile.status_text) statusValue += profile.status_text;
        if (profile.status_expiration && profile.status_expiration > 0) {
          const expDate = new Date(profile.status_expiration * 1000);
          statusValue += ` (until ${expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
        }
        output += `| Custom Status | ${statusValue.trim() || '-'} |\n`;
      } else {
        output += '| Custom Status | - |\n';
      }

      output += `| Timezone | ${user.tz || profile.tz || '-'} |\n`;

      if (user.id) {
        output += `\n[View in Slack](${getPermalinkBase()}team/${user.id})`;
      }

      return { content: [{ type: 'text', text: output }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error looking up user: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Register list_my_channels tool
server.registerTool(
  'list_my_channels',
  {
    description:
      'List all Slack channels you are a member of, including private channels.\n\n' +
      'When to use:\n' +
      '- Discovering private channel IDs for searching\n' +
      '- Getting an overview of your channel membership',
    inputSchema: {
      types: z.enum(['all', 'public', 'private']).optional().default('all').describe('Channel types to list'),
      limit: z.number().optional().default(100).describe('Maximum channels to return'),
    },
  },
  async ({ types, limit }) => {
    try {
      const auth = await ensureAuth();

      const typeMap = {
        all: 'public_channel,private_channel',
        public: 'public_channel',
        private: 'private_channel',
      };

      const channels = await listUserChannels(auth.cookies, auth.token, {
        types: typeMap[types],
      });

      const limitedChannels = channels.slice(0, limit);

      let result = `**Your Channels**\n`;
      result += `Total: ${channels.length} channels (showing ${limitedChannels.length})\n\n`;

      const publicChannels = limitedChannels.filter(c => !c.is_private);
      const privateChannels = limitedChannels.filter(c => c.is_private);

      if (publicChannels.length > 0) {
        result += `## Public Channels (${publicChannels.length})\n\n`;
        result += '| Channel | ID | Members |\n';
        result += '|---------|----|---------|\n';
        for (const ch of publicChannels) {
          result += `| #${ch.name} | ${ch.id} | ${ch.num_members || '-'} |\n`;
        }
        result += '\n';
      }

      if (privateChannels.length > 0) {
        result += `## Private Channels (${privateChannels.length})\n\n`;
        result += '| Channel | ID | Members |\n';
        result += '|---------|----|---------|\n';
        for (const ch of privateChannels) {
          result += `| #${ch.name} | ${ch.id} | ${ch.num_members || '-'} |\n`;
        }
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error listing channels: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Register search_mentions tool
server.registerTool(
  'search_mentions',
  {
    description:
      'Search for messages that @mention you across all channels.\n\n' +
      'When to use:\n' +
      '- Finding where you were mentioned\n' +
      '- Performance review data collection',
    inputSchema: {
      query: z.string().optional().describe('Optional additional search keywords'),
      after: z.string().optional().describe('Only messages after this date (YYYY-MM-DD)'),
      before: z.string().optional().describe('Only messages before this date (YYYY-MM-DD)'),
      limit: z.number().optional().default(10).describe('Maximum results (default: 10, max: 25)'),
    },
  },
  async ({ query, after, before, limit }) => {
    try {
      const auth = await ensureAuth();

      // Get current user's Slack ID
      const currentUser = await getCurrentUser(auth.cookies, auth.token);

      // Build search query for mentions
      const mentionQuery = `<@${currentUser.slackId}>`;
      const dateFilter = buildDateFilter(after, before);
      const searchQuery = [mentionQuery, query, dateFilter].filter(Boolean).join(' ');

      const resultLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 25);

      const searchResponse = await withAuthRetry((cookies, token) =>
        callSlackApi('search.messages', {
          query: searchQuery,
          count: resultLimit,
          sort: 'timestamp',
          sort_dir: 'desc',
        }, cookies, token)
      );

      if (!searchResponse.messages?.matches || searchResponse.messages.matches.length === 0) {
        const datePart = (after || before) ? ` (${after || 'beginning'} to ${before || 'now'})` : '';
        return {
          content: [{ type: 'text', text: `No @mentions found${datePart}` }],
        };
      }

      const matches = searchResponse.messages.matches;
      const totalCount = searchResponse.messages.total || matches.length;

      let result = `**@Mentions of You**\n`;
      if (after || before) {
        result += `_Date range: ${after || 'beginning'} to ${before || 'now'}_\n`;
      }
      result += `Found ${totalCount} mentions (showing ${matches.length}):\n\n`;

      for (const msg of matches) {
        const permalink = msg.permalink || buildPermalink(msg.channel?.id, msg.ts);
        const time = msg.ts ? formatTimestamp(msg.ts) : 'Unknown time';
        const channelName = msg.channel?.name ? `#${msg.channel.name}` : 'Unknown channel';
        const author = msg.username || msg.user || 'Unknown';
        const preview = (msg.text || '').substring(0, 200) + (msg.text?.length > 200 ? '...' : '');

        result += `---\n`;
        result += `**${channelName}** - ${author} (${time})\n`;
        result += `${preview}\n`;
        if (permalink) {
          result += `[View message](${permalink})\n\n`;
        } else {
          result += `\n`;
        }
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching mentions: ${error.message}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[slack-cli] MCP server started');
}

main().catch(error => {
  console.error('[slack-cli] Fatal error:', error);
  process.exit(1);
});
