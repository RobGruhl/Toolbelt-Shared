/**
 * Config Validator
 *
 * Validates .oraclerc configuration to catch errors early
 */

export class ConfigValidator {
  /**
   * Validate configuration object
   * @param {Object} config - Configuration to validate
   * @throws {Error} If configuration is invalid
   */
  static validate(config) {
    const errors = [];

    // Check required top-level fields
    if (!config.defaultProvider) {
      errors.push('Missing required field: defaultProvider');
    }

    if (!config.providers || typeof config.providers !== 'object') {
      errors.push('Missing or invalid field: providers (must be an object)');
    } else {
      // Validate providers
      this.validateProviders(config.providers, errors);
    }

    // Validate limits if present
    if (config.limits) {
      this.validateLimits(config.limits, errors);
    }

    // Validate repomix if present
    if (config.repomix) {
      this.validateRepomix(config.repomix, errors);
    }

    if (errors.length > 0) {
      throw new Error(
        `Configuration validation failed:\n  - ${errors.join('\n  - ')}\n\n` +
        `Please check your .oraclerc file.`
      );
    }
  }

  static validateProviders(providers, errors) {
    const validProviders = ['openai', 'google', 'anthropic'];
    const enabledProviders = [];

    for (const [name, providerConfig] of Object.entries(providers)) {
      if (!validProviders.includes(name)) {
        errors.push(`Unknown provider: ${name} (valid: ${validProviders.join(', ')})`);
        continue;
      }

      if (!providerConfig.enabled) {
        continue; // Skip disabled providers
      }

      enabledProviders.push(name);

      if (!providerConfig.apiKey) {
        errors.push(`Provider ${name}: missing apiKey`);
      }
      if (!providerConfig.model) {
        errors.push(`Provider ${name}: missing model`);
      }

      // Validate optional fields
      if (providerConfig.maxWaitMinutes !== undefined) {
        if (typeof providerConfig.maxWaitMinutes !== 'number' || providerConfig.maxWaitMinutes <= 0) {
          errors.push(`Provider ${name}: maxWaitMinutes must be a positive number`);
        }
      }

      if (providerConfig.temperature !== undefined) {
        if (typeof providerConfig.temperature !== 'number' ||
            providerConfig.temperature < 0 || providerConfig.temperature > 2) {
          errors.push(`Provider ${name}: temperature must be between 0 and 2`);
        }
      }

      if (providerConfig.sdkTimeoutMinutes !== undefined) {
        if (typeof providerConfig.sdkTimeoutMinutes !== 'number' || providerConfig.sdkTimeoutMinutes <= 0) {
          errors.push(`Provider ${name}: sdkTimeoutMinutes must be a positive number`);
        }
      }
    }

    if (enabledProviders.length === 0) {
      errors.push('No providers enabled (set enabled: true for at least one provider)');
    }
  }

  static validateLimits(limits, errors) {
    const numericFields = [
      'maxCostPerRequest',
      'warnCostThreshold'
    ];

    for (const field of numericFields) {
      if (limits[field] !== undefined) {
        if (typeof limits[field] !== 'number' || limits[field] < 0) {
          errors.push(`limits.${field} must be a non-negative number`);
        }
      }
    }
  }

  static validateRepomix(repomix, errors) {
    const validStyles = ['xml', 'markdown', 'json', 'plain'];

    if (repomix.style && !validStyles.includes(repomix.style)) {
      errors.push(`repomix.style must be one of: ${validStyles.join(', ')}`);
    }

    const booleanFields = ['compress', 'includeLineNumbers', 'removeComments'];
    for (const field of booleanFields) {
      if (repomix[field] !== undefined && typeof repomix[field] !== 'boolean') {
        errors.push(`repomix.${field} must be a boolean`);
      }
    }
  }

  /**
   * Get warnings for configuration (non-blocking issues)
   * @param {Object} config - Configuration to check
   * @returns {string[]} Array of warning messages
   */
  static getWarnings(config, { provider = null } = {}) {
    const warnings = [];

    // A "$VAR" key that is neither exported nor in the Keychain: the tool still estimates,
    // but submit/status/retrieve will fail — say so up front, once.
    for (const [name, providerConfig] of Object.entries(config.providers || {})) {
      if (!providerConfig.enabled) continue;

      if (providerConfig.apiKey?.startsWith('$')) {
        const envVar = providerConfig.apiKey.slice(1);
        const present = provider && provider.getName() === name
          ? provider.hasApiKey()
          : Boolean(process.env[envVar]);
        if (!present) {
          warnings.push(
            `Provider ${name}: ${envVar} is neither exported nor in the Keychain — ` +
            `estimate/list/cleanup work, submit/status/retrieve will not. ` +
            `Export ${envVar} or: security add-generic-password -s ${envVar} -a "$USER" -w`
          );
        }
      }
    }

    // Warn about sync mode (useBackgroundMode: false)
    for (const [name, providerConfig] of Object.entries(config.providers || {})) {
      if (!providerConfig.enabled) continue;

      if (providerConfig.useBackgroundMode === false) {
        warnings.push(
          `Provider ${name}: useBackgroundMode is disabled. ` +
          `Sync mode can timeout for complex questions that trigger extended reasoning. ` +
          `Consider enabling background mode (remove useBackgroundMode or set to true).`
        );
      }
    }

    // Warn about high cost limits
    if (config.limits?.maxCostPerRequest > 25) {
      warnings.push(
        `High cost limit: maxCostPerRequest is $${config.limits.maxCostPerRequest}. ` +
        `Consider lowering to avoid accidental high costs.`
      );
    }

    return warnings;
  }
}
