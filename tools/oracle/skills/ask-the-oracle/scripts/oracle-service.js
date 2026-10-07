/**
 * Ask the Oracle - Service Layer
 *
 * Business logic for deep code analysis consultations.
 * Separated from CLI presentation for testability and reuse.
 */

import { readFile, writeFile, mkdir, readdir, unlink, appendFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { registry } from './providers/registry.js';
import { RepomixWrapper } from './repomix-wrapper.js';
import { CostCalculator } from './cost-calculator.js';
import { ConfigValidator } from './config-validator.js';

// ============================================================================
// Error Codes & Exit Codes
// ============================================================================

const EXIT_CODES = {
  CONFIG_NOT_FOUND:    2,
  CONFIG_INVALID:      2,
  CONFIG_PARSE_ERROR:  2,
  NO_PROVIDER:         2,
  VALIDATION_ERROR:    3,
  COST_LIMIT_EXCEEDED: 3,
  CONTEXT_TOO_LARGE:   3,
  PROVIDER_ERROR:      4,
  TIMEOUT:             5,
  REMOTE_FAILED:       6,
  REMOTE_CANCELLED:    6,
  CONFIRMATION_REQUIRED: 7,
  DECLINED:            8, // a human at /dev/tty answered anything but yes; nothing sent
};

// ============================================================================
// Where local state lives (SENSIBILITIES #7, #11)
// ============================================================================
//
// Everything the tool writes on its own behalf — consultation history, request manifests,
// packed source artifacts, the audit log — lives under the tool's own data/ directory
// (gitignored by the belt's root .gitignore as tools/*/data/), never in the analyzed
// project's tree and never in a world-readable /tmp. ORACLE_DATA_DIR overrides it (tests).

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function dataDir() {
  return process.env.ORACLE_DATA_DIR ? resolve(process.env.ORACLE_DATA_DIR) : join(TOOL_ROOT, 'data');
}

function artifactsDir() {
  return join(dataDir(), 'artifacts');
}

function auditLogPath() {
  return join(dataDir(), 'audit.log');
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Audit line on every paid call and every remote mutation (SENSIBILITIES #7): appended to
 * data/audit.log and mirrored to stderr, so "what did the agent submit last Tuesday" is one
 * grep. A provider call that fails (401, 429, network) gets its own `verb=submit-failed` /
 * `verb=cancel-failed` line carrying the same fields plus the error, so an attempt that was
 * never billed is still on the record. Never the question text, the packed context, or the key.
 */
/** The first line of a provider error: enough to grep, never the body of a response. */
function firstLine(msg) {
  return String(msg || '').split('\n')[0].slice(0, 200);
}

async function audit(verb, fields) {
  const stamp = new Date().toISOString();
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  const line = `${stamp} verb=${verb} ${body}`;
  process.stderr.write(`[oracle audit] ${line}\n`);
  try {
    await ensureDir(dataDir());
    await appendFile(auditLogPath(), line + '\n', { mode: 0o600 });
  } catch {
    // the stderr copy already landed; a read-only data dir must not block the call
  }
}

// ============================================================================
// Code-level defaults (SENSIBILITIES #3)
// ============================================================================
//
// The per-request cost ceiling and the warn threshold exist even when .oraclerc omits them,
// so nothing expensive happens by accident. A .oraclerc that sets a higher limit is honored —
// this is private spend, and the override is a deliberate edit, not a flag.

const DEFAULT_LIMITS = Object.freeze({ maxCostPerRequest: 10.0, warnCostThreshold: 5.0 });

const DEFAULT_CONFIG = Object.freeze({
  defaultProvider: 'openai',
  providers: {
    openai: {
      apiKey: '$OPENAI_API_KEY',
      model: 'gpt-5.5-pro',
      maxWaitMinutes: 120,
      enabled: true,
    },
  },
  repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
  limits: { ...DEFAULT_LIMITS },
  ui: { showProgressIndicator: true, saveHistory: true },
});

class OracleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OracleError';
    this.code = code;
    this.details = details;
    this.exitCode = EXIT_CODES[code] || 1;
  }
}

// ============================================================================
// JSON Envelope Helpers
// ============================================================================

function buildEnvelope(command, data) {
  return { schemaVersion: 1, ok: true, command, data };
}

function buildErrorEnvelope(command, error) {
  if (error instanceof OracleError) {
    return {
      schemaVersion: 1,
      ok: false,
      command,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  return {
    schemaVersion: 1,
    ok: false,
    command,
    error: {
      code: 'UNKNOWN',
      message: error.message || String(error),
      details: {},
    },
  };
}

// ============================================================================
// Comment Stripping
// ============================================================================

/**
 * Strip // and # line comments from JSON text while respecting string boundaries.
 * Handles: "https://..." safely, multiline, trailing commas left as-is.
 */
function stripJsonComments(text) {
  let result = '';
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // String literal — copy verbatim until closing quote
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const sc = text[i];
        result += sc;
        i++;
        if (sc === '\\') {
          // Escaped character — copy next char too
          if (i < len) {
            result += text[i];
            i++;
          }
        } else if (sc === '"') {
          break;
        }
      }
      continue;
    }

    // "//" line comment
    if (ch === '/' && i + 1 < len && text[i + 1] === '/') {
      // Skip to end of line
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // "#" line comment (only when not inside a string — already handled above)
    if (ch === '#') {
      // Skip to end of line
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// ============================================================================
// Sensitive File Patterns
// ============================================================================

const SENSITIVE_PATTERNS = [
  /\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /id_rsa/, /id_ed25519/, /\.secret/, /credentials/i,
];

// ============================================================================
// Oracle Service
// ============================================================================

class Oracle {
  constructor(configPath = '.oraclerc') {
    this.configPath = configPath;
    this.config = null;
    this.provider = null;
    this.configSource = null; // 'file' | 'defaults'
  }

  async init() {
    this.config = await this.loadConfig();
    this.config.limits = { ...DEFAULT_LIMITS, ...(this.config.limits || {}) };

    try {
      ConfigValidator.validate(this.config);
    } catch (err) {
      throw new OracleError('CONFIG_INVALID', err.message);
    }

    this.provider = registry.getDefault(this.config);

    if (!this.provider) {
      throw new OracleError(
        'NO_PROVIDER',
        'No Oracle providers configured. Please set up .oraclerc with your API keys.\n' +
        'See .oraclerc.example for template.'
      );
    }

    return this;
  }

  async loadConfig() {
    const configPath = resolve(process.cwd(), this.configPath);

    // No .oraclerc in the analyzed project: run on the built-in defaults (OpenAI gpt-5.5-pro,
    // key from $OPENAI_API_KEY or the Keychain, $10 ceiling) and say so. A .oraclerc is a
    // per-project override, not a prerequisite.
    if (!existsSync(configPath)) {
      this.configSource = 'defaults';
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    this.configSource = 'file';

    const content = await readFile(configPath, 'utf-8');
    const stripped = stripJsonComments(content);

    try {
      return JSON.parse(stripped);
    } catch (err) {
      throw new OracleError(
        'CONFIG_PARSE_ERROR',
        `Failed to parse .oraclerc: ${err.message}\nFile: ${configPath}`
      );
    }
  }

  getWarnings() {
    const warnings = ConfigValidator.getWarnings(this.config, { provider: this.provider });
    if (this.configSource === 'defaults') {
      warnings.unshift(`No .oraclerc in ${process.cwd()} — running on built-in defaults (${DEFAULT_CONFIG.providers.openai.model}, $${DEFAULT_LIMITS.maxCostPerRequest.toFixed(2)} per-request ceiling). See .oraclerc.example to override.`);
    }
    return warnings;
  }

  /** Fresh artifact path under data/artifacts/ (never /tmp). */
  async _newArtifactPath() {
    await ensureDir(artifactsDir());
    return join(artifactsDir(), `oracle-context-${Date.now()}.xml`);
  }

  checkSensitiveFiles(files) {
    return files.filter(f =>
      SENSITIVE_PATTERNS.some(pattern => pattern.test(f.path))
    );
  }

  /**
   * Read and concatenate extra-context files. Returns { text, tokenCount, files }.
   */
  async _readExtraContext(extraContext = []) {
    if (!extraContext || extraContext.length === 0) {
      return { text: '', tokenCount: 0, files: [] };
    }

    const sections = [];
    const files = [];
    let totalChars = 0;

    for (const filePath of extraContext) {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        throw new OracleError('VALIDATION_ERROR', `Extra-context file not found: ${filePath}`);
      }
      const content = await readFile(resolved, 'utf-8');
      const name = basename(resolved);
      sections.push(`<!-- Extra context: ${name} -->\n${content}`);
      files.push({ path: resolved, tokens: Math.ceil(content.length / 4) });
      totalChars += content.length;
    }

    const text = sections.join('\n\n');
    const tokenCount = Math.ceil(totalChars / 4);
    return { text, tokenCount, files };
  }

  /**
   * Pack files and estimate cost (no submission).
   * Returns artifactPath and contextHash for reuse by submit().
   *
   * @param {Object} opts
   * @param {string[]} opts.patterns - Glob patterns for file selection
   * @param {string} [opts.sourceDir] - Directory to pack from (default: cwd)
   * @param {string[]} [opts.extraContext] - Extra context file paths to prepend
   */
  async estimate({ patterns, sourceDir, extraContext }) {
    const hasPatterns = patterns && patterns.length > 0;
    const hasExtraContext = extraContext && extraContext.length > 0;

    if (!hasPatterns && !hasExtraContext) {
      throw new OracleError('VALIDATION_ERROR', 'No file patterns or extra-context specified. Usage: oracle.js estimate <patterns>');
    }

    // Read extra-context files
    const extra = await this._readExtraContext(extraContext);

    // Pack code files (skip repomix if only extra-context)
    const repomix = new RepomixWrapper(this.config.repomix);
    let packed;
    const artifactPath = await this._newArtifactPath();
    if (hasPatterns) {
      packed = await repomix.packAndRead(patterns, sourceDir || process.cwd(), { output: artifactPath });
    } else {
      packed = { context: '', metadata: { tokenCount: 0, fileCount: 0, files: [], outputPath: null } };
    }

    // Combine: extra-context prepended before code
    const combinedContext = extra.text
      ? (packed.context ? `${extra.text}\n\n${packed.context}` : extra.text)
      : packed.context;
    const combinedTokens = packed.metadata.tokenCount + extra.tokenCount;
    const combinedFiles = [...extra.files, ...(packed.metadata.files || [])];
    const combinedFileCount = (packed.metadata.fileCount || 0) + extra.files.length;

    const estimate = CostCalculator.estimateCost(
      this.provider, combinedTokens
    );

    const limitCheck = CostCalculator.checkLimits(
      estimate.estimatedCost, this.config.limits
    );

    const sensitive = this.checkSensitiveFiles(combinedFiles);

    const tokenCheck = CostCalculator.checkTokenLimits(this.provider, combinedTokens);

    // Compute a content hash for cache validation
    const contextHash = createHash('sha256').update(combinedContext).digest('hex').slice(0, 16);

    // Write combined context to artifact file
    const outputPath = packed.metadata.outputPath || artifactPath;
    if (combinedContext !== packed.context) {
      await writeFile(outputPath, combinedContext, { mode: 0o600 });
    }

    // Write sidecar manifest alongside artifact
    const sidecarPath = outputPath.replace(/\.xml$/, '.manifest.json');
    const sidecar = {
      contextHash,
      tokenCount: combinedTokens,
      fileCount: combinedFileCount,
      files: combinedFiles,
      extraContext: extraContext || [],
      sourceDir: sourceDir || null,
      provider: {
        name: this.provider.getName(),
        model: this.provider.getModelName(),
      },
      created: new Date().toISOString(),
    };
    await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), { mode: 0o600 }).catch(() => {});

    // Fire-and-forget cleanup of stale artifacts
    this.cleanupStaleArtifacts().catch(() => {});

    return {
      fileCount: combinedFileCount,
      tokenCount: combinedTokens,
      files: combinedFiles,
      estimate,
      limitCheck,
      tokenCheck,
      sensitiveFiles: sensitive,
      provider: {
        name: this.provider.getName(),
        displayName: this.provider.getDisplayName(),
        model: this.provider.getModelName()
      },
      artifactPath: outputPath,
      sidecarPath,
      contextHash
    };
  }

  /**
   * Pack (or reuse artifact), check limits, and submit question.
   * Returns immediately with requestId.
   *
   * @param {Object} opts
   * @param {string[]} opts.patterns - Glob patterns for file selection
   * @param {string} opts.question - Question to ask the oracle
   * @param {string} [opts.artifactPath] - Pre-packed artifact from estimate()
   * @param {string} [opts.contextHash] - Hash to validate cached artifact
   * @param {string} [opts.continueFrom] - Previous request ID for multi-turn conversation
   * @param {string} [opts.sourceDir] - Directory to pack from (default: cwd)
   * @param {string[]} [opts.extraContext] - Extra context file paths to prepend
   */
  async submit({ patterns, question, artifactPath, contextHash, continueFrom, sourceDir, extraContext }) {
    // When continuing a conversation, skip packing — just send the question
    if (continueFrom) {
      return this._submitContinuation(continueFrom, question, patterns, sourceDir);
    }

    const hasPatterns = patterns && patterns.length > 0;
    const hasExtraContext = extraContext && extraContext.length > 0;

    if (!hasPatterns && !hasExtraContext) {
      throw new OracleError('VALIDATION_ERROR', 'No file patterns or extra-context specified');
    }
    if (!question) {
      throw new OracleError('VALIDATION_ERROR', 'No question specified (use -- to separate patterns from question)');
    }

    const repomix = new RepomixWrapper(this.config.repomix);
    let packed;

    // Try to reuse cached artifact from estimate using sidecar manifest
    if (artifactPath && contextHash) {
      try {
        const sidecarPath = artifactPath.replace(/\.xml$/, '.manifest.json');
        const sidecarContent = await readFile(sidecarPath, 'utf-8').catch(() => null);

        if (sidecarContent) {
          const sidecar = JSON.parse(sidecarContent);
          if (sidecar.contextHash === contextHash) {
            const context = await readFile(artifactPath, 'utf-8');
            const verifyHash = createHash('sha256').update(context).digest('hex').slice(0, 16);
            if (verifyHash === contextHash) {
              // Full reuse — no Repomix call at all
              packed = {
                context,
                metadata: {
                  tokenCount: sidecar.tokenCount,
                  fileCount: sidecar.fileCount,
                  files: sidecar.files,
                  outputPath: artifactPath,
                },
              };
            }
          }
        }

        // Sidecar missing/invalid — fall back to hash-only validation
        if (!packed) {
          const context = await readFile(artifactPath, 'utf-8');
          const verifyHash = createHash('sha256').update(context).digest('hex').slice(0, 16);
          if (verifyHash === contextHash) {
            packed = {
              context,
              metadata: {
                tokenCount: Math.ceil(context.length / 4),
                fileCount: 0,
                files: [],
                outputPath: artifactPath,
              },
            };
          }
        }
      } catch {
        // Fall through to full pack
      }
    }

    if (!packed) {
      // Fresh pack with extra-context composition
      const extra = await this._readExtraContext(extraContext);

      const freshArtifact = await this._newArtifactPath();
      let repomixPacked;
      if (hasPatterns) {
        repomixPacked = await repomix.packAndRead(patterns, sourceDir || process.cwd(), { output: freshArtifact });
      } else {
        repomixPacked = { context: '', metadata: { tokenCount: 0, fileCount: 0, files: [], outputPath: null } };
      }

      const combinedContext = extra.text
        ? (repomixPacked.context ? `${extra.text}\n\n${repomixPacked.context}` : extra.text)
        : repomixPacked.context;

      packed = {
        context: combinedContext,
        metadata: {
          tokenCount: repomixPacked.metadata.tokenCount + extra.tokenCount,
          fileCount: (repomixPacked.metadata.fileCount || 0) + extra.files.length,
          files: [...extra.files, ...(repomixPacked.metadata.files || [])],
          outputPath: repomixPacked.metadata.outputPath || freshArtifact,
        },
      };
    }

    if (packed.metadata.fileCount === 0 && !packed.context) {
      throw new OracleError('VALIDATION_ERROR', 'No files matched the specified patterns');
    }

    const tokenCheck = CostCalculator.checkTokenLimits(this.provider, packed.metadata.tokenCount);
    if (!tokenCheck.withinLimit) {
      throw new OracleError('CONTEXT_TOO_LARGE', tokenCheck.message, {
        inputTokens: packed.metadata.tokenCount,
        maxContext: tokenCheck.maxContext,
      });
    }

    const estimate = CostCalculator.estimateCost(
      this.provider, packed.metadata.tokenCount
    );

    const limitCheck = CostCalculator.checkLimits(
      estimate.estimatedCost, this.config.limits
    );

    if (!limitCheck.withinLimit) {
      throw new OracleError(
        'COST_LIMIT_EXCEEDED',
        `Cost limit exceeded: ${limitCheck.message}`,
        { estimatedCost: estimate.estimatedCost, limit: this.config.limits?.maxCostPerRequest }
      );
    }

    const sensitive = this.checkSensitiveFiles(packed.metadata.files || []);

    const auditFields = {
      provider: this.provider.getName(),
      model: this.provider.getModelName(),
      est_cost: Number(estimate.estimatedCost.toFixed(4)),
      pack_tokens: packed.metadata.tokenCount,
      files: packed.metadata.fileCount,
      sensitive: sensitive.length,
      cwd: process.cwd(),
    };

    let response;
    try {
      response = await this.provider.submit(
        packed.context, question,
        { temperature: this.config.providers[this.provider.getName()]?.temperature }
      );
    } catch (err) {
      await audit('submit-failed', { ...auditFields, error: firstLine(err.message) });
      throw new OracleError('PROVIDER_ERROR', err.message);
    }

    await audit('submit', { ...auditFields, request: response.id });

    const historyFile = await this.saveToHistory(response, {
      question, patterns, packedMetadata: packed.metadata
    }, true);

    await this.saveManifest(response.id, {
      providerName: this.provider.getName(),
      model: this.provider.getModelName(),
      question,
      patterns,
      artifactPath: packed.metadata.outputPath,
      submittedAt: new Date().toISOString(),
      estimatedCost: estimate.estimatedCost,
    });

    return {
      requestId: response.id,
      historyFile,
      estimate,
      limitCheck,
      sensitiveFiles: sensitive,
      packed: { fileCount: packed.metadata.fileCount, tokenCount: packed.metadata.tokenCount },
      provider: {
        name: this.provider.getName(),
        displayName: this.provider.getDisplayName(),
        model: this.provider.getModelName()
      }
    };
  }

  /**
   * Continue a conversation by chaining to a previous response.
   * Optionally packs new files if patterns are provided (hybrid mode).
   */
  async _submitContinuation(continueFrom, question, patterns = [], sourceDir = null) {
    if (!question) {
      throw new OracleError('VALIDATION_ERROR', 'No question specified for continuation');
    }

    // Resolve the provider that handled the original request
    const provider = await this._resolveProvider(continueFrom);
    const parentManifest = await this.loadManifest(continueFrom);

    // If patterns provided, pack fresh files to include alongside the continuation
    let context = '';
    let packedMetadata = { fileCount: 0, tokenCount: 0, files: [] };
    if (patterns.length > 0) {
      const repomix = new RepomixWrapper(this.config.repomix);
      const packed = await repomix.packAndRead(patterns, sourceDir || process.cwd(), { output: await this._newArtifactPath() });
      context = packed.context;
      packedMetadata = packed.metadata;
    }

    const auditFields = {
      provider: provider.getName(),
      model: provider.getModelName(),
      est_cost: null,
      pack_tokens: packedMetadata.tokenCount || 0,
      files: packedMetadata.fileCount || 0,
      continue_from: continueFrom,
      cwd: process.cwd(),
    };

    let response;
    try {
      response = await provider.submit(
        context, question,
        {
          previousResponseId: continueFrom,
          temperature: this.config.providers[provider.getName()]?.temperature,
        }
      );
    } catch (err) {
      await audit('submit-failed', { ...auditFields, error: firstLine(err.message) });
      throw new OracleError('PROVIDER_ERROR', err.message);
    }

    await audit('submit', { ...auditFields, request: response.id });

    // Use provided patterns, or inherit from parent
    const effectivePatterns = patterns.length > 0 ? patterns : (parentManifest?.patterns || []);

    const historyFile = await this.saveToHistory(response, {
      question, patterns: effectivePatterns,
      packedMetadata
    }, true);

    await this.saveManifest(response.id, {
      providerName: provider.getName(),
      model: provider.getModelName(),
      question,
      patterns: effectivePatterns,
      submittedAt: new Date().toISOString(),
      continueFrom,
    });

    return {
      requestId: response.id,
      historyFile,
      continueFrom,
      estimate: null,
      limitCheck: { withinLimit: true, exceeded: false, warning: false, message: '' },
      sensitiveFiles: [],
      packed: { fileCount: packedMetadata.fileCount || 0, tokenCount: packedMetadata.tokenCount || 0 },
      provider: {
        name: provider.getName(),
        displayName: provider.getDisplayName(),
        model: provider.getModelName()
      }
    };
  }

  /**
   * Resolve provider for a request — uses manifest if available, falls back to default.
   */
  async _resolveProvider(requestId) {
    const manifest = await this.loadManifest(requestId);
    if (manifest?.providerName) {
      const provider = registry.getByName(this.config, manifest.providerName);
      if (provider) return provider;
    }
    return this.provider;
  }

  /**
   * Check status of a submitted request (single poll)
   */
  async status(requestId) {
    if (!requestId) {
      throw new OracleError('VALIDATION_ERROR', 'No request ID specified. Usage: oracle.js status <requestId>');
    }
    try {
      const provider = await this._resolveProvider(requestId);
      return await provider.retrieve(requestId);
    } catch (err) {
      if (err instanceof OracleError) throw err;
      throw new OracleError('PROVIDER_ERROR', err.message);
    }
  }

  /**
   * Retrieve a response (same as status, but updates history if has output)
   */
  async retrieve(requestId) {
    if (!requestId) {
      throw new OracleError('VALIDATION_ERROR', 'No request ID specified. Usage: oracle.js retrieve <requestId>');
    }

    let response;
    try {
      const provider = await this._resolveProvider(requestId);
      response = await provider.retrieve(requestId);
    } catch (err) {
      if (err instanceof OracleError) throw err;
      throw new OracleError('PROVIDER_ERROR', err.message);
    }

    // Save history for any response that has output (completed or incomplete/truncated)
    if (response.output) {
      // Pull question/patterns from manifest so markdown gets a real title
      const manifest = await this.loadManifest(requestId);
      await this.saveToHistory(response, {
        question: manifest?.question || '',
        patterns: manifest?.patterns || [],
        packedMetadata: { fileCount: 0, tokenCount: 0 }
      });
      await this.updateManifestStatus(requestId, response.status);
    }

    return response;
  }

  /**
   * Cancel a running request
   */
  async cancel(requestId) {
    if (!requestId) {
      throw new OracleError('VALIDATION_ERROR', 'No request ID specified. Usage: oracle.js cancel <requestId>');
    }
    let provider = null;
    try {
      provider = await this._resolveProvider(requestId);
      const result = await provider.cancel(requestId);
      await audit('cancel', { provider: provider.getName(), request: requestId, ok: result });
      await this.updateManifestStatus(requestId, 'cancelled');
      return result;
    } catch (err) {
      await audit('cancel-failed', { provider: provider?.getName(), request: requestId, error: firstLine(err.message) });
      if (err instanceof OracleError) throw err;
      throw new OracleError('PROVIDER_ERROR', err.message);
    }
  }

  /**
   * Poll until completion. Calls onStatus callback for progress updates.
   *
   * @param {string} requestId
   * @param {Object} opts
   * @param {Function} [opts.onStatus] - Progress callback
   * @param {boolean} [opts.cancelOnTimeout=false] - If true, cancel on timeout and throw. Default: detach gracefully.
   *   Ignored when a request manifest exists with an estimated cost above the warn threshold
   *   (prevents accidental cancellation of expensive in-flight requests).
   * @param {number} [opts._pollIntervalMs] - Override poll interval (test-only)
   */
  async waitForCompletion(requestId, { onStatus, cancelOnTimeout = false, _pollIntervalMs } = {}) {
    const maxWaitMinutes = this.config.providers[this.provider.getName()]?.maxWaitMinutes || 120;
    const maxWaitMs = maxWaitMinutes * 60 * 1000;
    const pollInterval = _pollIntervalMs ?? 3000;
    const startTime = Date.now();
    let backoffMs = 0;
    let retryCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, pollInterval + backoffMs));

      let response;
      try {
        response = await this.provider.poll(requestId);
        backoffMs = 0;
        retryCount = 0;
      } catch (error) {
        if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
          retryCount++;
          backoffMs = Math.min(30000, 1000 * Math.pow(2, retryCount));
          if (onStatus) onStatus({ status: 'rate_limited', backoffMs, elapsed: Date.now() - startTime });
          continue;
        }
        throw new OracleError('PROVIDER_ERROR', error.message);
      }

      const elapsed = Date.now() - startTime;
      if (onStatus) onStatus({ status: response.status, elapsed });

      if (response.status === 'completed') {
        response.metadata.elapsed = elapsed;
        await this.updateManifestStatus(requestId, 'completed');
        return response;
      } else if (response.status === 'incomplete') {
        response.metadata.elapsed = elapsed;
        await this.updateManifestStatus(requestId, 'incomplete');
        return response;
      } else if (response.status === 'failed') {
        await this.updateManifestStatus(requestId, 'failed');
        throw new OracleError('REMOTE_FAILED', `Oracle failed: ${response.error || 'Unknown error'}`);
      } else if (response.status === 'cancelled') {
        await this.updateManifestStatus(requestId, 'cancelled');
        throw new OracleError('REMOTE_CANCELLED', 'Request cancelled');
      }
    }

    // Timeout — default is to detach (request keeps running server-side)
    if (cancelOnTimeout) {
      // Safety: refuse to cancel if estimated cost is above warn threshold
      const manifest = await this.loadManifest(requestId);
      const warnThreshold = this.config.limits?.warnCostThreshold || 5;
      if (manifest?.estimatedCost && manifest.estimatedCost >= warnThreshold) {
        // Too expensive to cancel — detach instead
        if (onStatus) onStatus({ status: 'detach_override', elapsed: Date.now() - startTime,
          reason: `Estimated cost $${manifest.estimatedCost.toFixed(2)} exceeds warn threshold $${warnThreshold.toFixed(2)} — detaching instead of cancelling` });
      } else {
        await this.provider.cancel(requestId).catch(() => {});
        await this.updateManifestStatus(requestId, 'cancelled');
        throw new OracleError('TIMEOUT', `Oracle request timeout after ${maxWaitMinutes} minutes`);
      }
    }

    // Default: detach gracefully
    return {
      id: requestId,
      status: 'detached',
      output: '',
      usage: {},
      cost: 0,
      metadata: {
        provider: this.provider.getName(),
        model: this.provider.getModelName(),
        elapsed: Date.now() - startTime,
      },
    };
  }

  /**
   * Save consultation to history. Returns history file path.
   */
  async saveToHistory(response, metadata, partial = false) {
    if (!this.config.ui?.saveHistory) return null;

    const historyDir = this._getHistoryDir();

    try {
      await ensureDir(historyDir);
    } catch {
      return null;
    }

    const historyFile = join(historyDir, `oracle-${response.id}.json`);

    // Merge with existing entry to preserve question/patterns from submit
    let existing = {};
    try {
      existing = JSON.parse(await readFile(historyFile, 'utf8'));
    } catch {
      // No existing file — start fresh
    }

    const entry = {
      timestamp: existing.timestamp || new Date().toISOString(),
      question: metadata.question || existing.question || '',
      patterns: metadata.patterns?.length ? metadata.patterns : (existing.patterns || []),
      packedFiles: metadata.packedMetadata.fileCount || existing.packedFiles || 0,
      inputTokens: response.usage?.inputTokens || existing.inputTokens || 0,
      provider: response.metadata?.provider || existing.provider || 'unknown',
      model: response.metadata?.model || existing.model || 'unknown',
      cost: response.cost || existing.cost || 0,
      elapsed: response.metadata?.elapsed || existing.elapsed || 0,
      requestId: response.id,
      status: partial ? (response.status || 'queued') : (response.status || 'completed'),
      response: response.output || existing.response || '',
      usage: response.usage?.totalTokens ? response.usage : (existing.usage || {})
    };

    try {
      await writeFile(historyFile, JSON.stringify(entry, null, 2), { mode: 0o600 });
    } catch {
      return null;
    }

    // Generate readable markdown alongside JSON when we have a response
    if (entry.response) {
      try {
        await this._writeHistoryMarkdown(historyDir, entry);
      } catch {
        // Non-fatal — JSON is the primary artifact
      }
    }

    return historyFile;
  }

  /**
   * Write a readable markdown file alongside the JSON history entry.
   */
  async _writeHistoryMarkdown(historyDir, entry) {
    const ts = new Date(entry.timestamp);
    const dateStr = ts.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    // Build a date-prefixed slug from the question
    const datePrefix = ts.toISOString().slice(0, 10); // YYYY-MM-DD
    const questionSlug = this._slugify(entry.question) || entry.requestId;
    const slug = `${datePrefix}-${questionSlug}`;

    // Build file manifest from patterns
    const home = process.env.HOME || '';
    const cwd = process.cwd();
    const shortenPath = (p) => {
      if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
      if (home && p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
      return p;
    };

    const lines = [
      `# Oracle: ${this._titleize(questionSlug)}`,
      '',
      `**Date:** ${dateStr} at ${timeStr}  `,
      `**Request ID:** \`${entry.requestId}\`  `,
      `**Model:** ${entry.model}  `,
      `**Status:** ${entry.status}  `,
      `**Cost:** $${(entry.cost || 0).toFixed(2)}  `,
      `**Tokens:** ${(entry.usage?.inputTokens || 0).toLocaleString()} input, ` +
        `${(entry.usage?.outputTokens || 0).toLocaleString()} output, ` +
        `${(entry.usage?.reasoningTokens || 0).toLocaleString()} reasoning`,
      '',
    ];

    // File manifest
    const patterns = entry.patterns || [];
    if (patterns.length > 0) {
      lines.push(`**Files sent** (${patterns.length}):`, '');
      for (const p of patterns) {
        lines.push(`- \`${shortenPath(p)}\``);
      }
      lines.push('');
    }

    lines.push(
      '---',
      '',
      '## Question',
      '',
      entry.question || '(not recorded)',
      '',
      '---',
      '',
      '## Response',
      '',
      entry.response || '(empty)',
    );

    const mdPath = join(historyDir, `${slug}.md`);
    await writeFile(mdPath, lines.join('\n'), { mode: 0o600 });
  }

  /**
   * Turn a question string into a filesystem-safe slug.
   */
  _slugify(text) {
    if (!text) return '';
    // Strip common preamble noise, then take first meaningful fragment
    const cleaned = text
      .replace(/^(FOLLOW-UP REQUEST|CONTINUATION REQUEST)\s*[-—]\s*/i, '')
      .replace(/^this is a\s+/i, '');
    // Take first line or first 60 chars, then break at last whole word
    let fragment = cleaned.split('\n')[0].slice(0, 60);
    const lastSpace = fragment.lastIndexOf(' ');
    if (lastSpace > 20) fragment = fragment.slice(0, lastSpace);
    return fragment
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Turn a slug back into a readable title.
   */
  _titleize(slug) {
    return slug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ============================================================================
  // Request Manifests
  // ============================================================================

  /**
   * data/history/ by default. ui.historyPath in .oraclerc relocates it (resolved against the
   * cwd, so a project can keep its own consultations next to its code if it wants to).
   */
  _getHistoryDir() {
    const configured = this.config?.ui?.historyPath;
    return configured ? resolve(process.cwd(), configured) : join(dataDir(), 'history');
  }

  async saveManifest(requestId, { providerName, model, question, patterns, artifactPath, submittedAt, estimatedCost }) {
    const historyDir = this._getHistoryDir();
    try {
      await ensureDir(historyDir);
    } catch {
      return null;
    }

    const manifest = {
      requestId,
      providerName,
      model,
      question,
      patterns,
      artifactPath,
      submittedAt,
      estimatedCost: estimatedCost || null,
      status: 'in_progress',
    };

    const manifestPath = join(historyDir, `manifest-${requestId}.json`);
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    } catch {
      return null;
    }
    return manifestPath;
  }

  async loadManifest(requestId) {
    const manifestPath = join(this._getHistoryDir(), `manifest-${requestId}.json`);
    try {
      const content = await readFile(manifestPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async updateManifestStatus(requestId, status) {
    const manifest = await this.loadManifest(requestId);
    if (!manifest) return;
    manifest.status = status;
    const manifestPath = join(this._getHistoryDir(), `manifest-${requestId}.json`);
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // non-critical
    }
  }

  async listManifests({ limit = 20 } = {}) {
    const historyDir = this._getHistoryDir();
    try {
      const files = await readdir(historyDir);
      const manifests = [];
      for (const file of files) {
        if (!file.startsWith('manifest-') || !file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(historyDir, file), 'utf-8');
          manifests.push(JSON.parse(content));
        } catch {
          // skip corrupt manifests
        }
      }
      manifests.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
      return manifests.slice(0, limit);
    } catch {
      return [];
    }
  }

  // ============================================================================
  // Artifact Cleanup
  // ============================================================================

  async cleanupStaleArtifacts(maxAgeHours = 24) {
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    let cleaned = 0;
    const dir = artifactsDir();
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.startsWith('oracle-context-')) continue;
        const fullPath = join(dir, file);
        try {
          const stat = statSync(fullPath);
          if (stat.mtimeMs < cutoff) {
            await unlink(fullPath);
            cleaned++;
          }
        } catch {
          // skip files we can't stat/delete
        }
      }
    } catch {
      // no artifacts dir yet — nothing to clean
    }
    return cleaned;
  }
}

export {
  Oracle,
  OracleError,
  EXIT_CODES,
  DEFAULT_LIMITS,
  DEFAULT_CONFIG,
  SENSITIVE_PATTERNS,
  dataDir,
  artifactsDir,
  auditLogPath,
  audit,
  stripJsonComments,
  buildEnvelope,
  buildErrorEnvelope,
};
