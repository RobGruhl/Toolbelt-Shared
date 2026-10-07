/**
 * Workspace configuration — the only place company-specific wiring lives.
 *
 * Everything that differs between one company's Slack and another's is read
 * here, lazily, on first use: the workspace URL, the Enterprise Grid id, the
 * cache paths, and the off-hours window. Nothing in this module touches the
 * network, and nothing imports it at a time that would make `--help` or the
 * unit tests need a configured workspace.
 *
 * Resolution order for every setting: environment variable, then the config
 * file, then the documented default. The config file is
 * `~/.config/slack-cli/config.json` and must be mode 600 — it is refused
 * (not silently read) when group- or world-readable, because the same file
 * is where a future setting with a secret would land and the habit has to be
 * right from the first field.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

export const LOG_PREFIX = '[slack-cli]';

export const CONFIG_FILE = join(homedir(), '.config', 'slack-cli', 'config.json');

/** Cached browser session: cookies + xoxc token + the workspace they belong to. Mode 600. */
export const AUTH_FILE = join(homedir(), '.slack-cli-auth.json');

/** Dedicated Chrome profile for the SSO session. `SLACK_CLI_PROFILE` overrides. */
export const PROFILE_DIR = process.env.SLACK_CLI_PROFILE || join(homedir(), '.slack-cli');

export const DEFAULT_BUSINESS_HOURS = '06-18';

const ENV = {
  workspaceUrl: 'SLACK_WORKSPACE_URL',
  enterpriseId: 'SLACK_ENTERPRISE_ID',
  permalinkUrl: 'SLACK_PERMALINK_URL',
  businessHours: 'SLACK_BUSINESS_HOURS',
  businessTz: 'SLACK_BUSINESS_TZ',
};

const FILE_KEYS = {
  workspaceUrl: 'workspace_url',
  enterpriseId: 'enterprise_id',
  permalinkUrl: 'permalink_url',
  businessHours: 'business_hours',
  businessTz: 'business_tz',
};

let fileCache; // undefined = not read yet; null = absent

/**
 * Read the config file once. Absent is fine (env may carry everything); a
 * loose-permission or unparseable file is an error the caller should show.
 */
export function readConfigFile() {
  if (fileCache !== undefined) return fileCache;
  if (!existsSync(CONFIG_FILE)) {
    fileCache = null;
    return fileCache;
  }
  const mode = statSync(CONFIG_FILE).mode & 0o077;
  if (mode !== 0) {
    throw new ConfigError(
      `${CONFIG_FILE} is group/world readable; refusing to read it.\n` +
      `Fix: chmod 600 ${CONFIG_FILE}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON (${e.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${CONFIG_FILE} must hold a JSON object, e.g. {"workspace_url": "https://yourco.slack.com/"}`);
  }
  fileCache = parsed;
  return fileCache;
}

/** For tests: forget the cached file so a changed environment is re-read. */
export function resetConfigCache() {
  fileCache = undefined;
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.isConfigError = true;
  }
}

function setting(key) {
  const env = process.env[ENV[key]];
  if (env !== undefined && env.trim() !== '') return env.trim();
  const file = readConfigFile();
  const v = file?.[FILE_KEYS[key]];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return undefined;
}

/**
 * Normalize a workspace URL to `https://<host>/` with exactly one trailing
 * slash. Accepts a bare host. Refuses anything that is not a slack.com host,
 * because a typo here would send the session cookies somewhere else.
 */
export function normalizeWorkspaceUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new ConfigError('workspace URL is empty');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new ConfigError(`"${input}" is not a URL`);
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError(`workspace URL must be https:// (got ${url.protocol})`);
  }
  if (!/\.slack\.com$/i.test(url.hostname)) {
    throw new ConfigError(`workspace URL host must end in .slack.com (got ${url.hostname})`);
  }
  return `https://${url.hostname.toLowerCase()}/`;
}

/**
 * The workspace URL every API call and login goes through. Required.
 *
 * Throws a ConfigError that names the env var and the config file when it is
 * absent — callers print `error.message` and exit 1, no stack trace.
 */
export function getWorkspaceUrl() {
  const raw = setting('workspaceUrl');
  if (!raw) {
    throw new ConfigError(
      'No Slack workspace configured.\n' +
      `Set ${ENV.workspaceUrl} (e.g. https://yourco.slack.com/ or https://grid-yourco.enterprise.slack.com/)\n` +
      `or write ${CONFIG_FILE} (chmod 600) as {"workspace_url": "https://yourco.slack.com/"}.`
    );
  }
  return normalizeWorkspaceUrl(raw);
}

/** `https://<workspace>/api/` */
export function getApiBase() {
  return `${getWorkspaceUrl()}api/`;
}

/**
 * The host permalinks are built on. Defaults to the workspace URL. On
 * Enterprise Grid the API goes through the org host
 * (`grid-yourco.enterprise.slack.com`) while the links people share use the
 * workspace host (`yourco.slack.com`); set `SLACK_PERMALINK_URL` /
 * `permalink_url` when those differ and you want links in the familiar form.
 */
export function getPermalinkBase() {
  const raw = setting('permalinkUrl');
  return raw ? normalizeWorkspaceUrl(raw) : getWorkspaceUrl();
}

/**
 * Explicitly configured Edge API cache id (the `E…` org id on Enterprise
 * Grid). Optional: when unset, auth.js falls back to the id `auth.test`
 * reported at login. Returns undefined when neither env nor file has it.
 */
export function getConfiguredEnterpriseId() {
  const raw = setting('enterpriseId');
  if (!raw) return undefined;
  if (!/^[ET][A-Z0-9]{6,}$/i.test(raw)) {
    throw new ConfigError(`${ENV.enterpriseId} "${raw}" is not a Slack org/team id (E… or T…)`);
  }
  return raw.toUpperCase();
}

/**
 * Off-hours window for bulk reads: `{ startHour, endHour, timeZone }`.
 *
 * `SLACK_BUSINESS_HOURS` is "HH-HH" in 24-hour local time of `timeZone`
 * (default "06-18": 6am to 6pm). `SLACK_BUSINESS_TZ` is an IANA zone
 * (default: this machine's zone). Monday-Friday is fixed.
 */
export function getBusinessHours() {
  const hoursRaw = setting('businessHours') || DEFAULT_BUSINESS_HOURS;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(hoursRaw);
  if (!m) {
    throw new ConfigError(`${ENV.businessHours} must look like "06-18" (got "${hoursRaw}")`);
  }
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour >= endHour) {
    throw new ConfigError(`${ENV.businessHours} "${hoursRaw}" must be start<end within 00-24`);
  }
  const timeZone = setting('businessTz') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ConfigError(`${ENV.businessTz} "${timeZone}" is not an IANA time zone (e.g. America/Los_Angeles, Europe/London)`);
  }
  return { startHour, endHour, timeZone };
}

/** One-line summary for `whoami`, diagnostics, and the doctor. Never prints a secret. */
export function describeConfig() {
  let workspace;
  try {
    workspace = getWorkspaceUrl();
  } catch (e) {
    workspace = `(unset: ${e.message.split('\n')[0]})`;
  }
  const source = process.env[ENV.workspaceUrl] ? `env ${ENV.workspaceUrl}` : existsSync(CONFIG_FILE) ? CONFIG_FILE : 'none';
  return { workspace, source, authFile: AUTH_FILE, profileDir: PROFILE_DIR };
}
