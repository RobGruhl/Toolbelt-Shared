/**
 * Provider Registry
 *
 * Central registration and discovery system for Oracle providers.
 * Automatically instantiates configured providers based on .oraclerc settings.
 */

import { OpenAIProvider } from './openai.js';
// Future providers:
// import { GoogleProvider } from './google.js';
// import { AnthropicProvider } from './anthropic.js';

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  /**
   * Register a provider instance
   * @param {BaseProvider} provider
   */
  register(provider) {
    this.providers.set(provider.getName(), provider);
  }

  /**
   * Get a specific provider by name
   * @param {string} name - Provider name (e.g., 'openai')
   * @returns {BaseProvider|null}
   */
  get(name) {
    return this.providers.get(name) || null;
  }

  /**
   * Get all registered providers
   * @returns {BaseProvider[]}
   */
  getAll() {
    return Array.from(this.providers.values());
  }

  /**
   * Get providers that are configured in the given config
   * Automatically instantiates providers based on available API keys
   * @param {Object} config - Configuration object from .oraclerc
   * @returns {BaseProvider[]}
   */
  getConfigured(config) {
    const configured = [];

    // OpenAI provider
    const openaiConfig = config.providers?.openai;

    if (openaiConfig && openaiConfig.enabled !== false && openaiConfig.apiKey) {
      try {
        configured.push(new OpenAIProvider(openaiConfig));
      } catch (error) {
        console.warn(`Failed to initialize OpenAI provider: ${error.message}`);
      }
    }

    // Future providers (V2.0+)
    /*
    if (config.providers?.google?.apiKey && config.providers.google.enabled !== false) {
      try {
        configured.push(new GoogleProvider(config.providers.google));
      } catch (error) {
        console.warn(`Failed to initialize Google provider: ${error.message}`);
      }
    }

    if (config.providers?.anthropic?.apiKey && config.providers.anthropic.enabled !== false) {
      try {
        configured.push(new AnthropicProvider(config.providers.anthropic));
      } catch (error) {
        console.warn(`Failed to initialize Anthropic provider: ${error.message}`);
      }
    }
    */

    return configured;
  }

  /**
   * Get the default provider from config
   * @param {Object} config - Configuration object from .oraclerc
   * @returns {BaseProvider|null}
   */
  getDefault(config) {
    const configured = this.getConfigured(config);

    if (configured.length === 0) {
      return null;
    }

    // If defaultProvider is specified, use it
    if (config.defaultProvider) {
      const defaultProvider = configured.find(
        p => p.getName() === config.defaultProvider
      );
      if (defaultProvider) {
        return defaultProvider;
      }
    }

    // Otherwise, use the first configured provider
    return configured[0];
  }

  /**
   * Check if any providers are configured
   * @param {Object} config - Configuration object from .oraclerc
   * @returns {boolean}
   */
  hasConfigured(config) {
    return this.getConfigured(config).length > 0;
  }

  /**
   * Get a specific configured provider by name
   * @param {Object} config - Configuration object from .oraclerc
   * @param {string} name - Provider name (e.g., 'openai')
   * @returns {BaseProvider|null}
   */
  getByName(config, name) {
    return this.getConfigured(config).find(p => p.getName() === name) || null;
  }

  /**
   * Get summary of configured providers
   * @param {Object} config - Configuration object from .oraclerc
   * @returns {string}
   */
  getSummary(config) {
    const configured = this.getConfigured(config);

    if (configured.length === 0) {
      return 'No providers configured';
    }

    const names = configured.map(p => p.getDisplayName()).join(', ');
    return `${configured.length} provider(s) configured: ${names}`;
  }
}

// Export singleton instance
export const registry = new ProviderRegistry();
