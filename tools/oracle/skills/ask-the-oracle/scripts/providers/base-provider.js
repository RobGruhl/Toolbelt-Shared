/**
 * Base Provider Interface
 *
 * All Oracle providers (OpenAI, Google, Anthropic) must implement this interface.
 * This enables unified interaction regardless of the underlying model API.
 */

import { execFileSync } from 'child_process';

/**
 * macOS Keychain lookup, presence-or-value, never on argv: `security` prints the password
 * to stdout, which we capture and hand straight to the SDK. Returns null off-darwin, when
 * the item is missing, or when the Keychain refuses (locked, denied).
 */
export function readKeychain(service) {
  if (process.platform !== 'darwin' || !service) return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).toString('utf8').trim();
    return out || null;
  } catch {
    return null;
  }
}

export class BaseProvider {
  constructor(config) {
    this.config = config;
  }

  // ============================================================================
  // Identity & Metadata
  // ============================================================================

  /**
   * Get the unique identifier for this provider
   * @returns {string} e.g., 'openai', 'google', 'anthropic'
   */
  getName() {
    throw new Error('getName() must be implemented by subclass');
  }

  /**
   * Get the human-readable display name
   * @returns {string} e.g., 'OpenAI GPT-5.4 Pro'
   */
  getDisplayName() {
    throw new Error('getDisplayName() must be implemented by subclass');
  }

  /**
   * Get the specific model being used
   * @returns {string} e.g., 'gpt-5.5-pro', 'gemini-2.0-pro'
   */
  getModelName() {
    throw new Error('getModelName() must be implemented by subclass');
  }

  // ============================================================================
  // Capabilities
  // ============================================================================

  /**
   * Check if this provider supports background/async long-running requests
   * @returns {boolean}
   */
  supportsBackgroundMode() {
    return false;
  }

  /**
   * Get maximum context window size in tokens
   * @returns {number}
   */
  getMaxContextTokens() {
    throw new Error('getMaxContextTokens() must be implemented by subclass');
  }

  /**
   * Get maximum output tokens
   * @returns {number}
   */
  getMaxOutputTokens() {
    throw new Error('getMaxOutputTokens() must be implemented by subclass');
  }

  /**
   * Get pricing information for display purposes
   * @returns {{ input: number, output: number, reasoning: number }} Cost per 1M tokens in USD
   */
  getPricing() {
    throw new Error('getPricing() must be implemented by subclass');
  }

  // ============================================================================
  // Core Operations
  // ============================================================================

  /**
   * Submit a question to the Oracle
   * @param {string} context - Packed codebase context from Repomix
   * @param {string} question - User's formatted question
   * @param {Object} options - Additional options (temperature, maxTokens, etc.)
   * @returns {Promise<Object>} Normalized response object
   */
  async submit(context, question, options = {}) {
    throw new Error('submit() must be implemented by subclass');
  }

  /**
   * Poll for status of a long-running request
   * @param {string} requestId - Unique request identifier
   * @returns {Promise<Object>} Normalized response object with current status
   */
  async poll(requestId) {
    throw new Error('poll() must be implemented by subclass');
  }

  /**
   * Retrieve a completed or in-progress response
   * @param {string} requestId - Unique request identifier
   * @returns {Promise<Object>} Normalized response object
   */
  async retrieve(requestId) {
    throw new Error('retrieve() must be implemented by subclass');
  }

  /**
   * Cancel a running request
   * @param {string} requestId - Unique request identifier
   * @returns {Promise<boolean>} Success status
   */
  async cancel(requestId) {
    throw new Error('cancel() must be implemented by subclass');
  }

  // ============================================================================
  // Cost & Response Normalization
  // ============================================================================

  /**
   * Calculate cost based on token usage
   * @param {Object} usage - Token usage object
   * @param {number} usage.inputTokens
   * @param {number} usage.outputTokens
   * @param {number} [usage.reasoningTokens]
   * @returns {number} Cost in USD
   */
  calculateCost(usage) {
    throw new Error('calculateCost() must be implemented by subclass');
  }

  /**
   * Normalize provider-specific response to unified format
   * @param {Object} rawResponse - Provider-specific response
   * @returns {Object} Normalized response
   */
  normalizeResponse(rawResponse) {
    return {
      id: rawResponse.id || 'unknown',
      status: this._normalizeStatus(rawResponse.status),
      output: this._extractOutput(rawResponse),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      },
      cost: 0.0,
      metadata: {
        provider: this.getName(),
        model: this.getModelName(),
        elapsed: 0,
        timestamp: new Date().toISOString()
      }
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Normalize provider-specific status to unified format
   * @private
   */
  _normalizeStatus(status) {
    const statusMap = {
      'completed': 'completed',
      'complete': 'completed',
      'success': 'completed',
      'in_progress': 'in_progress',
      'processing': 'in_progress',
      'running': 'in_progress',
      'queued': 'queued',
      'pending': 'queued',
      'failed': 'failed',
      'error': 'failed',
      'cancelled': 'cancelled',
      'canceled': 'cancelled',
      'incomplete': 'incomplete'
    };

    return statusMap[status?.toLowerCase()] || 'unknown';
  }

  /**
   * Extract output text from provider-specific response
   * @private
   */
  _extractOutput(rawResponse) {
    // Subclasses should override if needed
    return rawResponse.output || rawResponse.text || '';
  }

  /**
   * Resolve API key from config (supports environment variable substitution)
   * @protected
   */
  /**
   * Is a credential reachable without reading it? (presence only — for degraded-mode
   * messages and the doctor; the value itself is resolved lazily on the first network call)
   */
  hasApiKey() {
    try { this._resolveApiKey(); return true; } catch { return false; }
  }

  /**
   * Resolve the API key (SENSIBILITIES #6, #11). A "$VAR" reference is read from the
   * environment first, then from the macOS Keychain as a generic password whose service
   * name is VAR (add one with: security add-generic-password -s VAR -a "$USER" -w). The
   * value is returned to the SDK and never logged, printed, or written to disk. A literal
   * key in .oraclerc still works but is the deprecated form — that file is plaintext.
   */
  _resolveApiKey() {
    const key = this.config.apiKey;

    if (key?.startsWith('$')) {
      const envVar = key.substring(1);
      const envValue = process.env[envVar];
      if (envValue) return envValue;

      const fromKeychain = readKeychain(envVar);
      if (fromKeychain) return fromKeychain;

      throw new Error(
        `API key references ${envVar}, which is neither exported nor in the Keychain. ` +
        `Export ${envVar}, or store it once with: security add-generic-password -s ${envVar} -a "$USER" -w`
      );
    }

    if (!key) {
      throw new Error(
        `API key not configured for ${this.getName()} provider. ` +
        `Please set it in .oraclerc`
      );
    }

    return key;
  }
}
