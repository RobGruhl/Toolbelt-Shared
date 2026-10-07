/**
 * Cost Calculator
 *
 * Estimates and calculates costs for Oracle consultations.
 * Supports multiple providers with different pricing models.
 */

import chalk from 'chalk';

// Output estimation heuristic — scales with input instead of a flat 8K assumption.
// Typical output/input ratio for code analysis is 0.2-0.4.
const OUTPUT_RATIO = 0.4;
const MIN_OUTPUT_ESTIMATE = 200;
const MAX_OUTPUT_ESTIMATE = 8000;

export class CostCalculator {
  /**
   * Estimate cost before submission.
   *
   * Input cost is exact (known from Repomix token count).
   * Output cost is estimated — scales with input size when not explicit.
   * Reasoning cost is unpredictable (model-dependent); included if provided.
   *
   * @param {BaseProvider} provider - Oracle provider
   * @param {number} inputTokens - Input tokens (known from Repomix)
   * @param {number|null} expectedOutputTokens - Explicit output estimate, or null to auto-scale
   * @param {number} reasoningTokens - Expected reasoning tokens (usually 0 — unpredictable)
   * @returns {Object} Cost estimate
   */
  static estimateCost(provider, inputTokens, expectedOutputTokens = null, reasoningTokens = 0) {
    const outputAutoScaled = expectedOutputTokens === null;
    if (outputAutoScaled) {
      expectedOutputTokens = Math.min(
        Math.max(Math.round(inputTokens * OUTPUT_RATIO), MIN_OUTPUT_ESTIMATE),
        MAX_OUTPUT_ESTIMATE
      );
    }

    const cost = provider.calculateCost({
      inputTokens,
      outputTokens: expectedOutputTokens,
      reasoningTokens
    });

    return {
      provider: provider.getDisplayName(),
      inputTokens,
      expectedOutputTokens,
      outputAutoScaled,
      reasoningTokens,
      estimatedCost: cost,
      breakdown: {
        input: provider.calculateCost({ inputTokens, outputTokens: 0, reasoningTokens: 0 }),
        output: provider.calculateCost({ inputTokens: 0, outputTokens: expectedOutputTokens, reasoningTokens: 0 }),
        reasoning: provider.calculateCost({ inputTokens: 0, outputTokens: 0, reasoningTokens })
      }
    };
  }

  /**
   * Calculate actual cost from response
   * @param {Object} response - Normalized response from provider
   * @param {BaseProvider} [provider] - Provider for accurate per-category breakdown
   * @returns {Object} Cost breakdown
   */
  static calculateActual(response, provider = null) {
    // If we have a provider, use it for accurate per-category cost breakdown
    // (token types have very different prices, so proportional allocation is wrong)
    let breakdown;
    if (provider) {
      breakdown = {
        input: provider.calculateCost({ inputTokens: response.usage.inputTokens, outputTokens: 0, reasoningTokens: 0 }),
        output: provider.calculateCost({ inputTokens: 0, outputTokens: response.usage.outputTokens, reasoningTokens: 0 }),
        reasoning: provider.calculateCost({ inputTokens: 0, outputTokens: 0, reasoningTokens: response.usage.reasoningTokens || 0 })
      };
    } else {
      // Fallback: use total cost (less accurate but works without provider reference)
      const totalTokens = response.usage.totalTokens || 1;
      breakdown = {
        input: response.cost * (response.usage.inputTokens / totalTokens),
        output: response.cost * (response.usage.outputTokens / totalTokens),
        reasoning: response.cost * ((response.usage.reasoningTokens || 0) / totalTokens)
      };
    }

    return {
      provider: response.metadata.provider,
      model: response.metadata.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      reasoningTokens: response.usage.reasoningTokens || 0,
      totalTokens: response.usage.totalTokens,
      actualCost: response.cost,
      breakdown
    };
  }

  /**
   * Format cost estimate for display
   * @param {Object} estimate - Cost estimate from estimateCost()
   * @param {Object} limits - Cost limits from config
   * @param {BaseProvider} [provider] - Provider for dynamic pricing labels
   * @returns {string} Formatted string
   */
  static formatEstimate(estimate, limits = {}, provider = null) {
    const { estimatedCost, inputTokens, expectedOutputTokens, reasoningTokens, outputAutoScaled } = estimate;
    const pricing = provider?.getPricing?.() || { input: 15.00, output: 120.00, reasoning: 15.00 };

    let output = `\n${chalk.bold('Cost Estimate:')}\n`;
    output += `  Provider: ${chalk.cyan(estimate.provider)}\n`;
    output += `  Input tokens:    ${chalk.yellow(inputTokens.toLocaleString())} @ $${pricing.input}/M  = ${chalk.green('$' + estimate.breakdown.input.toFixed(2))} ${chalk.gray('(known)')}\n`;

    if (reasoningTokens > 0) {
      output += `  Reasoning tokens: ${chalk.yellow(reasoningTokens.toLocaleString())} @ $${pricing.reasoning}/M  = ${chalk.green('$' + estimate.breakdown.reasoning.toFixed(2))}\n`;
    } else if (pricing.reasoning > 0) {
      output += `  Reasoning tokens: ${chalk.gray('variable (not included in estimate)')}\n`;
    }

    const outputLabel = outputAutoScaled ? chalk.gray('(estimated)') : '';
    const outputPrefix = outputAutoScaled ? '~' : '';
    output += `  Output tokens:   ${outputPrefix}${chalk.yellow(expectedOutputTokens.toLocaleString())} @ $${pricing.output}/M = ${chalk.green(outputPrefix + '$' + estimate.breakdown.output.toFixed(2))} ${outputLabel}\n`;
    output += `  ${chalk.gray('─'.repeat(60))}\n`;

    // Color code based on limits
    const costStr = outputAutoScaled ? '~$' + estimatedCost.toFixed(2) : '$' + estimatedCost.toFixed(2);
    let coloredCost = costStr;

    if (limits.maxCostPerRequest && estimatedCost > limits.maxCostPerRequest) {
      coloredCost = chalk.red.bold(costStr + ' (EXCEEDS LIMIT!)');
    } else if (limits.warnCostThreshold && estimatedCost > limits.warnCostThreshold) {
      coloredCost = chalk.yellow.bold(costStr + ' (Warning: High Cost)');
    } else {
      coloredCost = chalk.green.bold(costStr);
    }

    output += `  ${chalk.bold('Estimated Total:')} ${coloredCost}\n`;

    return output;
  }

  /**
   * Format actual cost for display
   * @param {Object} actual - Actual cost from calculateActual()
   * @returns {string} Formatted string
   */
  static formatActual(actual) {
    let output = `\n${chalk.bold('Actual Cost:')}\n`;
    output += `  Input tokens:    ${chalk.yellow(actual.inputTokens.toLocaleString())} = ${chalk.green('$' + actual.breakdown.input.toFixed(2))}\n`;

    if (actual.reasoningTokens > 0) {
      output += `  Reasoning tokens: ${chalk.yellow(actual.reasoningTokens.toLocaleString())} = ${chalk.green('$' + actual.breakdown.reasoning.toFixed(2))}\n`;
    }

    output += `  Output tokens:    ${chalk.yellow(actual.outputTokens.toLocaleString())} = ${chalk.green('$' + actual.breakdown.output.toFixed(2))}\n`;
    output += `  ${chalk.gray('─'.repeat(60))}\n`;
    output += `  ${chalk.bold('Total Cost:')} ${chalk.green.bold('$' + actual.actualCost.toFixed(2))}\n`;

    return output;
  }

  /**
   * Check if cost is within limits
   * @param {number} cost - Cost to check
   * @param {Object} limits - Limits from config
   * @returns {Object} { withinLimit, exceeded, warning }
   */
  static checkLimits(cost, limits = {}) {
    const result = {
      withinLimit: true,
      exceeded: false,
      warning: false,
      message: ''
    };

    if (limits.maxCostPerRequest && cost > limits.maxCostPerRequest) {
      result.withinLimit = false;
      result.exceeded = true;
      result.message = `Cost $${cost.toFixed(2)} exceeds limit of $${limits.maxCostPerRequest.toFixed(2)}`;
    } else if (limits.warnCostThreshold && cost > limits.warnCostThreshold) {
      result.warning = true;
      result.message = `Cost $${cost.toFixed(2)} exceeds warning threshold of $${limits.warnCostThreshold.toFixed(2)}`;
    }

    return result;
  }

  /**
   * Check if input tokens fit within provider's context window
   * @param {BaseProvider} provider - Oracle provider
   * @param {number} inputTokens - Estimated input tokens (code context)
   * @param {number} expectedOutputTokens - Expected output tokens (default 8000)
   * @returns {Object} { withinLimit, effectiveInput, expectedOutput, maxContext, headroom, message }
   */
  static checkTokenLimits(provider, inputTokens, expectedOutputTokens = 8000) {
    const OVERHEAD_RESERVE = 1700; // question ~500 + framing ~200 + safety ~1000
    const maxContext = provider.getMaxContextTokens();
    const effectiveInput = inputTokens + OVERHEAD_RESERVE;
    const expectedOutput = Math.min(expectedOutputTokens, provider.getMaxOutputTokens());
    const totalRequired = effectiveInput + expectedOutput;
    const headroom = maxContext - totalRequired;

    if (totalRequired > maxContext) {
      const maxInputBudget = maxContext - expectedOutput - OVERHEAD_RESERVE;
      return {
        withinLimit: false,
        effectiveInput,
        expectedOutput,
        maxContext,
        headroom,
        message: `Context too large: ${inputTokens.toLocaleString()} tokens + ${OVERHEAD_RESERVE} overhead + ${expectedOutput.toLocaleString()} output = ${totalRequired.toLocaleString()} total, but max context is ${maxContext.toLocaleString()}. Reduce input to under ${maxInputBudget.toLocaleString()} tokens.`,
      };
    }

    return {
      withinLimit: true,
      effectiveInput,
      expectedOutput,
      maxContext,
      headroom,
      message: `${headroom.toLocaleString()} tokens headroom remaining.`,
    };
  }

  /**
   * Estimate cost for multiple providers
   * @param {BaseProvider[]} providers - Array of providers
   * @param {number} inputTokens - Input tokens
   * @param {number} expectedOutputTokens - Expected output tokens
   * @returns {Object[]} Array of cost estimates
   */
  static estimateMultiple(providers, inputTokens, expectedOutputTokens = 8000) {
    return providers.map(provider =>
      CostCalculator.estimateCost(provider, inputTokens, expectedOutputTokens)
    );
  }

  /**
   * Calculate total cost for multiple responses
   * @param {Object[]} responses - Array of normalized responses
   * @returns {Object} Total cost breakdown
   */
  static calculateMultiple(responses) {
    const totals = {
      providers: responses.map(r => r.metadata.provider),
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      individual: []
    };

    responses.forEach(response => {
      const actual = CostCalculator.calculateActual(response);
      totals.totalCost += actual.actualCost;
      totals.totalInputTokens += actual.inputTokens;
      totals.totalOutputTokens += actual.outputTokens;
      totals.totalReasoningTokens += actual.reasoningTokens;
      totals.individual.push(actual);
    });

    return totals;
  }
}
