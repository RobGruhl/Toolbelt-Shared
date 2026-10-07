/**
 * Shared query logic for both CLI and MCP server.
 * Handles pagination and date filtering.
 *
 * Rate limiting, 429/Retry-After handling, and exponential backoff live in
 * auth.js `makeApiRequest`. Telemetry counters (rateLimitHits, retries,
 * failedCalls, okCalls) are available via lib/telemetry.js — bulk-pull
 * callers can call `formatTelemetry()` or inspect `getTelemetry()` to
 * detect degraded Slack health.
 */

import {
  callSlackApi,
  callEdgeApi,
  resolveUsername,
  getCurrentUser,
  listUserChannels,
  getUserReactions,
  resolveChannel,
  sleep,
} from '../auth.js';
import { getPermalinkBase } from './config.js';

// Default delay between paginated requests (ms)
const DEFAULT_DELAY = 100;

/**
 * Build date filter string for Slack search.
 * @param {string} after - YYYY-MM-DD format
 * @param {string} before - YYYY-MM-DD format
 * @returns {string} Filter string like "after:2024-01-01 before:2024-12-31"
 */
export function buildDateFilter(after, before) {
  const parts = [];
  if (after) parts.push(`after:${after}`);
  if (before) parts.push(`before:${before}`);
  return parts.join(' ');
}

/**
 * Parse Slack message timestamp to Date.
 */
export function parseTimestamp(ts) {
  return new Date(parseFloat(ts) * 1000);
}

/**
 * Format timestamp to readable string.
 */
export function formatTimestamp(ts) {
  const date = parseTimestamp(ts);
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
 * Build a Slack permalink from channel ID and timestamp.
 * When `threadTs` names a different parent (i.e. the message is a thread
 * reply), the permalink carries `?thread_ts=<parent>&cid=<channel>` — the
 * same form Slack itself returns for replies.
 */
export function buildPermalink(channelId, ts, threadTs) {
  if (!channelId || !ts) return null;
  const rawTs = ts.replace('.', '');
  const base = `${getPermalinkBase()}archives/${channelId}/p${rawTs}`;
  return threadTs && threadTs !== ts
    ? `${base}?thread_ts=${threadTs}&cid=${channelId}`
    : base;
}

/**
 * Search messages with pagination.
 * Automatically fetches all pages up to maxPages.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Query options
 * @param {string} opts.query - Search query string
 * @param {string} opts.after - Date filter (YYYY-MM-DD)
 * @param {string} opts.before - Date filter (YYYY-MM-DD)
 * @param {string} opts.sort - 'timestamp' or 'score'
 * @param {number} opts.maxResults - Maximum total results (default: unlimited)
 * @param {number} opts.maxPages - Maximum pages to fetch (default: unlimited)
 * @param {number} opts.delay - Delay between requests in ms (default: 100)
 * @param {boolean} opts.verbose - Log API calls
 * @param {function} opts.onProgress - Progress callback(page, totalSoFar)
 * @returns {Promise<{messages: Array, total: number, pagesSearched: number}>}
 */
export async function searchMessages(auth, opts = {}) {
  const {
    query,
    after,
    before,
    sort = 'timestamp',
    maxResults = Infinity,
    maxPages = Infinity,
    delay = DEFAULT_DELAY,
    verbose = false,
    onProgress,
  } = opts;

  // Build full query with date filters
  const dateFilter = buildDateFilter(after, before);
  const fullQuery = [query, dateFilter].filter(Boolean).join(' ');

  const allMessages = [];
  let page = 1;
  let totalResults = 0;

  while (page <= maxPages && allMessages.length < maxResults) {
    const response = await callSlackApi('search.messages', {
      query: fullQuery,
      sort,
      sort_dir: 'desc',
      count: 100,
      page,
    }, auth.cookies, auth.token, { verbose });

    const matches = response.messages?.matches || [];
    totalResults = response.messages?.total || 0;

    if (matches.length === 0) {
      break;
    }

    allMessages.push(...matches);

    if (onProgress) {
      onProgress(page, allMessages.length, totalResults);
    }

    if (verbose) {
      console.error(`[API] search.messages - page ${page} - ${matches.length} results - total: ${totalResults}`);
    }

    // Check if we have all results
    if (allMessages.length >= totalResults) {
      break;
    }

    page++;

    // Delay before next request
    if (page <= maxPages && allMessages.length < maxResults && delay > 0) {
      await sleep(delay);
    }
  }

  // Trim to maxResults if needed
  const trimmedMessages = allMessages.slice(0, maxResults);

  return {
    messages: trimmedMessages,
    total: totalResults,
    pagesSearched: page,
  };
}

/**
 * Search for messages from a specific user.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.username - Username or display name
 * @param {string} opts.query - Additional search keywords
 * @param {string} opts.after - Date filter
 * @param {string} opts.before - Date filter
 * @param {number} opts.maxResults - Max results
 * @param {boolean} opts.verbose - Verbose logging
 * @param {function} opts.onProgress - Progress callback
 */
export async function searchUserMessages(auth, opts = {}) {
  const { username, query = '', ...restOpts } = opts;

  // Resolve a display name to the account's username, which is what `from:`
  // takes. An all-digit input is passed through as-is (some companies
  // provision usernames as employee numbers).
  let fromUser = username;
  let displayName = username;

  const looksLikeUsername = /^\d+$/.test(username);
  if (!looksLikeUsername) {
    const resolution = await resolveUsername(username, auth.cookies, auth.token);
    if (resolution.error) {
      throw new Error(resolution.error);
    }
    fromUser = resolution.userId;
    displayName = resolution.displayName;
  }

  // Build search query
  const fromQuery = `from:${fromUser}`;
  const fullQuery = query ? `${fromQuery} ${query}` : fromQuery;

  const result = await searchMessages(auth, {
    query: fullQuery,
    ...restOpts,
  });

  return {
    ...result,
    user: { username: fromUser, displayName },
  };
}

/**
 * Search for @mentions of a user.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.slackId - Slack user ID (U...) to search for mentions of
 * @param {string} opts.username - Alternative: resolve this username to get slackId
 * @param {string} opts.query - Additional search keywords
 * @param {string} opts.after - Date filter
 * @param {string} opts.before - Date filter
 */
export async function searchMentions(auth, opts = {}) {
  let { slackId, username, query = '', ...restOpts } = opts;

  // If no slackId provided, get current user or resolve username
  if (!slackId) {
    if (username) {
      const resolution = await resolveUsername(username, auth.cookies, auth.token);
      if (resolution.error) {
        throw new Error(resolution.error);
      }
      slackId = resolution.slackId;
    } else {
      const currentUser = await getCurrentUser(auth.cookies, auth.token);
      slackId = currentUser.slackId;
    }
  }

  // Search for @mentions using <@UXXXXX> format
  const mentionQuery = `<@${slackId}>`;
  const fullQuery = query ? `${mentionQuery} ${query}` : mentionQuery;

  const result = await searchMessages(auth, {
    query: fullQuery,
    ...restOpts,
  });

  return {
    ...result,
    mentionedUser: slackId,
  };
}

/**
 * Search messages in a specific channel.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.channel - Channel name or ID
 * @param {string} opts.query - Search keywords
 * @param {string} opts.after - Date filter
 * @param {string} opts.before - Date filter
 */
export async function searchChannelMessages(auth, opts = {}) {
  const { channel, query = '', resolved, ...restOpts } = opts;

  // Resolve channel name/ID (a caller that already resolved it — e.g. to
  // decide the off-hours exemption — passes `resolved` and saves the lookup)
  const { channelId, channelName } = resolved ?? await resolveChannel(channel, auth.cookies, auth.token);

  // Build search query with in: filter
  // Note: in: filter uses channel name, not ID, but we can use channel ID directly in some cases
  const inFilter = channelName ? `in:#${channelName}` : `in:<#${channelId}>`;
  const fullQuery = query ? `${inFilter} ${query}` : inFilter;

  const result = await searchMessages(auth, {
    query: fullQuery,
    ...restOpts,
  });

  return {
    ...result,
    channel: { id: channelId, name: channelName },
  };
}

/**
 * Get channel history (recent messages without search).
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.channel - Channel name or ID
 * @param {number} opts.limit - Max messages to return
 * @param {string} opts.oldest - Start timestamp
 * @param {string} opts.latest - End timestamp
 */
export async function getChannelHistory(auth, opts = {}) {
  const { channel, limit = 100, oldest, latest } = opts;

  // Resolve channel
  const { channelId, channelName } = await resolveChannel(channel, auth.cookies, auth.token);

  const params = {
    channel: channelId,
    limit: Math.min(limit, 1000),
  };

  if (oldest) params.oldest = oldest;
  if (latest) params.latest = latest;

  const response = await callSlackApi('conversations.history', params, auth.cookies, auth.token);

  return {
    messages: response.messages || [],
    channel: { id: channelId, name: channelName },
    hasMore: response.has_more || false,
  };
}

/**
 * Fetch a full thread (parent + all replies) via conversations.replies
 * with cursor pagination. Messages arrive oldest→newest with the parent
 * first, so no re-sort is needed. The API repeats the parent message at
 * the top of EVERY cursor page, so results are deduped by ts. `limit` is advisory — Slack may return more messages per
 * page than asked; the loop trusts only has_more/next_cursor.
 *
 * Returns raw API message objects (normalization lives in lib/export.js,
 * like every other query here). `total` is the thread's true size as Slack
 * reports it: the parent's reply_count + 1.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.channel - Channel name or ID
 * @param {string} opts.threadTs - Parent message timestamp
 * @param {number} opts.limit - Messages per page (default: 200, advisory)
 * @param {number} opts.delay - Delay between pages in ms (default: 300)
 * @param {number} opts.maxPages - Maximum pages to fetch
 * @param {boolean} opts.verbose - Log API calls
 * @param {function} opts.onProgress - Progress callback(page, totalSoFar)
 * @returns {Promise<{messages: Array, channel: {id, name}, total: number}>}
 */
export async function getThreadReplies(auth, opts = {}) {
  const {
    channel,
    threadTs,
    limit = 200,
    delay = 300,
    maxPages = Infinity,
    verbose = false,
    onProgress,
  } = opts;

  const { channelId, channelName } = await resolveChannel(channel, auth.cookies, auth.token);

  const seen = new Set();
  const messages = [];
  let cursor = null;
  let page = 1;

  do {
    const params = { channel: channelId, ts: threadTs, limit };
    if (cursor) params.cursor = cursor;

    const response = await callSlackApi('conversations.replies', params, auth.cookies, auth.token, { verbose });

    for (const m of response.messages || []) {
      if (seen.has(m.ts)) continue; // parent repeats on every page
      seen.add(m.ts);
      messages.push(m);
    }

    if (verbose) {
      console.error(`[API] conversations.replies - page ${page} - ${messages.length} messages so far`);
    }

    if (onProgress) {
      onProgress(page, messages.length);
    }

    cursor = response.has_more ? (response.response_metadata?.next_cursor || null) : null;
    page++;

    if (cursor && page <= maxPages && delay > 0) {
      await sleep(delay);
    }
  } while (cursor && page <= maxPages);

  const parent = messages[0];
  const total = parent ? (parent.reply_count || 0) + 1 : messages.length;

  return {
    messages,
    channel: { id: channelId, name: channelName },
    total,
  };
}

/**
 * Get all channels the user is a member of.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.types - Channel types ('all', 'public', 'private', 'dm', 'mpim')
 */
export async function getMyChannels(auth, opts = {}) {
  const { types = 'all' } = opts;

  // Map user-friendly type names to Slack API types
  const typeMap = {
    all: 'public_channel,private_channel',
    public: 'public_channel',
    private: 'private_channel',
    dm: 'im',
    mpim: 'mpim',
  };

  const apiTypes = typeMap[types] || types;

  const channels = await listUserChannels(auth.cookies, auth.token, { types: apiTypes });

  // Sort by name
  channels.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return {
    channels,
    total: channels.length,
  };
}

/**
 * Discover channels by keyword via the Edge API (`channels/search`).
 *
 * On Enterprise Grid workspaces the Web API channel-listing endpoints
 * (`conversations.list`, `users.conversations`) may be admin-restricted
 * (`enterprise_is_restricted`) for the browser (xoxc) token, in which case
 * `getMyChannels` cannot work. The Edge API `channels/search` service is not
 * subject to that control and supports keyword search, so discovery there is
 * query-driven rather than a full dump.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts
 * @param {string[]} opts.queries - Keyword queries to search (one call each).
 * @param {number} opts.count - Max results per query (default 50).
 * @returns {Promise<{channels: object[], total: number, queries: string[], errors: object[]}>}
 */
export async function discoverChannels(auth, opts = {}) {
  const { queries = [], count = 50 } = opts;
  if (!queries.length) {
    throw new Error('discoverChannels requires at least one query keyword');
  }

  const byId = new Map();
  const errors = [];

  for (const query of queries) {
    try {
      const r = await callEdgeApi(
        'channels/search',
        { query, count },
        auth.cookies,
        auth.token
      );
      const results = r.results || r.channels || [];
      for (const c of results) {
        if (byId.has(c.id)) continue;
        byId.set(c.id, {
          id: c.id,
          name: c.name,
          is_private: !!c.is_private,
          is_archived: !!c.is_archived,
          // Edge results expose member_count; normalise to num_members so the
          // existing channel exporters render members consistently.
          num_members: c.member_count ?? c.num_members,
          purpose:
            typeof c.purpose === 'string' ? { value: c.purpose } : c.purpose,
          topic: typeof c.topic === 'string' ? { value: c.topic } : c.topic,
          created: c.created,
          matched_query: query,
        });
      }
    } catch (err) {
      errors.push({ query, error: err.message });
    }
  }

  const channels = [...byId.values()].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );

  return { channels, total: channels.length, queries, errors };
}

/**
 * Get messages the user has reacted to.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {number} opts.maxResults - Max results
 * @param {boolean} opts.verbose - Verbose logging
 */
export async function getMyReactions(auth, opts = {}) {
  const { maxResults = Infinity, verbose = false, onProgress } = opts;

  const allItems = [];
  let cursor = null;
  let page = 1;

  do {
    const response = await getUserReactions(auth.cookies, auth.token, {
      limit: 100,
      cursor,
    });

    const items = response.items || [];
    allItems.push(...items);

    if (verbose) {
      console.error(`[API] reactions.list - page ${page} - ${items.length} items`);
    }

    if (onProgress) {
      onProgress(page, allItems.length);
    }

    cursor = response.response_metadata?.next_cursor || null;
    page++;

    if (allItems.length >= maxResults) {
      break;
    }
  } while (cursor);

  return {
    items: allItems.slice(0, maxResults),
    total: allItems.length,
  };
}

/**
 * Search for user's messages that have reactions.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 */
export async function searchMyMessagesWithReactions(auth, opts = {}) {
  const { username, ...restOpts } = opts;

  // Get user info
  let fromUser;
  if (username) {
    const resolution = await resolveUsername(username, auth.cookies, auth.token);
    if (resolution.error) throw new Error(resolution.error);
    fromUser = resolution.userId;
  } else {
    const currentUser = await getCurrentUser(auth.cookies, auth.token);
    fromUser = currentUser.userId;
  }

  // Search for messages with reactions
  const query = `from:${fromUser} has:reaction`;

  return searchMessages(auth, {
    query,
    ...restOpts,
  });
}

/**
 * Search for thread replies by a user.
 * Finds messages where the user replied in a thread.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 */
export async function searchThreadParticipation(auth, opts = {}) {
  const { username, ...restOpts } = opts;

  // Get user info
  let fromUser;
  if (username) {
    const resolution = await resolveUsername(username, auth.cookies, auth.token);
    if (resolution.error) throw new Error(resolution.error);
    fromUser = resolution.userId;
  } else {
    const currentUser = await getCurrentUser(auth.cookies, auth.token);
    fromUser = currentUser.userId;
  }

  // Search for messages from user that are in threads
  // Unfortunately Slack doesn't have a direct "is:thread_reply" filter,
  // but we can search for user's messages and filter client-side
  const result = await searchMessages(auth, {
    query: `from:${fromUser}`,
    ...restOpts,
  });

  // Filter to only thread replies (messages where thread_ts exists and differs from ts)
  const threadReplies = result.messages.filter(msg => {
    return msg.thread_ts && msg.thread_ts !== msg.ts;
  });

  return {
    messages: threadReplies,
    total: threadReplies.length,
    originalTotal: result.total,
  };
}

/**
 * Get summary statistics for a date range.
 *
 * @param {object} auth - { cookies, token }
 * @param {object} opts - Options
 * @param {string} opts.after - Start date
 * @param {string} opts.before - End date
 */
export async function getSummaryStats(auth, opts = {}) {
  const { after, before, verbose, onProgress } = opts;

  // Get current user info
  const currentUser = await getCurrentUser(auth.cookies, auth.token);

  // Get message count
  const messagesResult = await searchUserMessages(auth, {
    username: currentUser.userId,
    after,
    before,
    maxResults: 1, // Just need total count
    verbose,
  });

  // Get mentions count
  const mentionsResult = await searchMentions(auth, {
    slackId: currentUser.slackId,
    after,
    before,
    maxResults: 1,
    verbose,
  });

  // Get channels
  const channelsResult = await getMyChannels(auth, { types: 'all' });

  return {
    user: currentUser,
    messagesSent: messagesResult.total,
    mentionsReceived: mentionsResult.total,
    channelsActive: channelsResult.total,
    dateRange: { after, before },
  };
}
