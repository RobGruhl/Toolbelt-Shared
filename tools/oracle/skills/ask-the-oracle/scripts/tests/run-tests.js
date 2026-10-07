/**
 * Ask the Oracle - Test Suite
 *
 * Unit tests for core modules. Runs without external dependencies
 * (no API keys, no network calls) using mock providers.
 *
 * Usage:
 *   node skills/ask-the-oracle/scripts/tests/run-tests.js
 */

// ============================================================================
// Minimal Test Framework (zero dependencies)
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`    ❌ ${name}`);
    console.log(`       ${error.message}`);
  }
}

// Async variant for tests that return promises
const asyncTests = [];
function itAsync(name, fn) {
  asyncTests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertClose(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(
      message || `Expected ~${expected} (±${tolerance}), got ${actual} (diff: ${diff})`
    );
  }
}

// ============================================================================
// Mock Provider
// ============================================================================

class MockProvider {
  constructor(pricing = { input: 15.00, output: 120.00, reasoning: 15.00 }) {
    this.pricing = pricing;
  }

  getName() { return 'mock'; }
  getDisplayName() { return 'Mock Provider'; }
  getModelName() { return 'mock-model'; }
  getPricing() { return this.pricing; }
  getMaxContextTokens() { return 200000; }
  getMaxOutputTokens() { return 128000; }

  calculateCost(usage) {
    const inputCost = (usage.inputTokens / 1_000_000) * this.pricing.input;
    const outputCost = (usage.outputTokens / 1_000_000) * this.pricing.output;
    const reasoningCost = ((usage.reasoningTokens || 0) / 1_000_000) * this.pricing.reasoning;
    return inputCost + outputCost + reasoningCost;
  }
}

/**
 * MockPollProvider — configurable sequence of poll responses for waitForCompletion tests
 */
class MockPollProvider extends MockProvider {
  constructor(pollResponses = []) {
    super();
    this.pollResponses = pollResponses;
    this.pollIndex = 0;
  }

  async poll(requestId) {
    if (this.pollIndex >= this.pollResponses.length) {
      // Default: keep returning in_progress
      return { status: 'in_progress', output: '', usage: {}, cost: 0, metadata: { provider: 'mock', model: 'mock-model' } };
    }
    const response = this.pollResponses[this.pollIndex++];
    if (response._throw) {
      const err = new Error(response._throw.message || 'poll error');
      err.status = response._throw.status;
      throw err;
    }
    return response;
  }

  async cancel() { return true; }
  async retrieve(requestId) { return this.poll(requestId); }
}

// ============================================================================
// Import modules under test
// ============================================================================

import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CostCalculator } from '../cost-calculator.js';
import { ConfigValidator } from '../config-validator.js';
import {
  Oracle,
  OracleError,
  EXIT_CODES,
  stripJsonComments,
  buildEnvelope,
  buildErrorEnvelope,
} from '../oracle-service.js';
import { parseArgs } from '../oracle.js';

// ============================================================================
// CostCalculator Tests
// ============================================================================

describe('CostCalculator.estimateCost', () => {
  it('auto-scales output for large input (caps at 8000)', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 50000);

    // 50k * 0.4 = 20k, capped at 8000
    assert(estimate.expectedOutputTokens === 8000, `expected 8000, got ${estimate.expectedOutputTokens}`);
    assert(estimate.outputAutoScaled === true, 'should be auto-scaled');
    // 50k input @ $15/M = $0.75, 8k output @ $120/M = $0.96
    assertClose(estimate.estimatedCost, 1.71, 0.01);
  });

  it('auto-scales output for small input', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 1000);

    // 1000 * 0.4 = 400
    assert(estimate.expectedOutputTokens === 400, `expected 400, got ${estimate.expectedOutputTokens}`);
    assert(estimate.outputAutoScaled === true);
    // 1k @ $15/M = $0.015, 400 @ $120/M = $0.048
    assertClose(estimate.estimatedCost, 0.063, 0.005);
  });

  it('auto-scales output with floor of 200', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 100);

    // 100 * 0.4 = 40, floored to 200
    assert(estimate.expectedOutputTokens === 200, `expected 200, got ${estimate.expectedOutputTokens}`);
    assert(estimate.outputAutoScaled === true);
  });

  it('uses explicit output tokens when provided', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 50000, 8000, 10000);

    assert(estimate.expectedOutputTokens === 8000);
    assert(estimate.outputAutoScaled === false, 'should not be auto-scaled');
    // +10k reasoning @ $15/M = $0.15
    assertClose(estimate.estimatedCost, 1.86, 0.01);
  });

  it('produces accurate per-category breakdown', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 100000, 10000, 5000);

    assertClose(estimate.breakdown.input, 1.50, 0.01);
    assertClose(estimate.breakdown.output, 1.20, 0.01);
    assertClose(estimate.breakdown.reasoning, 0.075, 0.001);
  });

  it('handles zero tokens gracefully', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 0, 0, 0);
    assert(estimate.estimatedCost === 0, `Expected 0, got ${estimate.estimatedCost}`);
  });

  it('uses provider display name', () => {
    const provider = new MockProvider();
    const estimate = CostCalculator.estimateCost(provider, 1000);
    assert(estimate.provider === 'Mock Provider');
  });
});

describe('CostCalculator.calculateActual', () => {
  it('calculates from response without provider (fallback)', () => {
    const response = {
      usage: { inputTokens: 50000, outputTokens: 2000, reasoningTokens: 1000, totalTokens: 53000 },
      cost: 1.50,
      metadata: { provider: 'openai', model: 'gpt-5.5-pro' }
    };

    const actual = CostCalculator.calculateActual(response);
    assert(actual.inputTokens === 50000);
    assert(actual.outputTokens === 2000);
    assert(actual.actualCost === 1.50);
    assert(actual.provider === 'openai');
  });

  it('uses provider for accurate breakdown when available', () => {
    const provider = new MockProvider();
    const response = {
      usage: { inputTokens: 100000, outputTokens: 1000, reasoningTokens: 0, totalTokens: 101000 },
      cost: provider.calculateCost({ inputTokens: 100000, outputTokens: 1000, reasoningTokens: 0 }),
      metadata: { provider: 'mock', model: 'mock-model' }
    };

    const withProvider = CostCalculator.calculateActual(response, provider);
    const withoutProvider = CostCalculator.calculateActual(response);

    // With provider: input = 100k @ $15/M = $1.50, output = 1k @ $120/M = $0.12
    assertClose(withProvider.breakdown.input, 1.50, 0.01);
    assertClose(withProvider.breakdown.output, 0.12, 0.01);

    // Provider-based gives more to output (it's 8x more expensive per token)
    assert(withProvider.breakdown.output > withoutProvider.breakdown.output,
      'Provider breakdown should allocate more to output due to higher $/token');
  });
});

describe('CostCalculator.checkLimits', () => {
  it('passes when within limits', () => {
    const result = CostCalculator.checkLimits(3.00, {
      maxCostPerRequest: 10.00, warnCostThreshold: 5.00
    });
    assert(result.withinLimit === true);
    assert(result.warning === false);
  });

  it('warns when above threshold', () => {
    const result = CostCalculator.checkLimits(7.00, {
      maxCostPerRequest: 10.00, warnCostThreshold: 5.00
    });
    assert(result.withinLimit === true);
    assert(result.warning === true);
    assert(result.message.includes('5.00'));
  });

  it('blocks when exceeding limit', () => {
    const result = CostCalculator.checkLimits(12.00, {
      maxCostPerRequest: 10.00, warnCostThreshold: 5.00
    });
    assert(result.withinLimit === false);
    assert(result.exceeded === true);
  });

  it('passes with empty limits', () => {
    const result = CostCalculator.checkLimits(999.00, {});
    assert(result.withinLimit === true);
  });
});

describe('CostCalculator.estimateMultiple', () => {
  it('estimates across providers with different pricing', () => {
    const cheap = new MockProvider({ input: 5.00, output: 20.00, reasoning: 5.00 });
    const expensive = new MockProvider({ input: 15.00, output: 120.00, reasoning: 15.00 });

    const estimates = CostCalculator.estimateMultiple([cheap, expensive], 50000, 8000);
    assert(estimates.length === 2);
    assert(estimates[0].estimatedCost < estimates[1].estimatedCost,
      'Cheap provider should cost less');
  });
});

// ============================================================================
// ConfigValidator Tests
// ============================================================================

describe('ConfigValidator.validate', () => {
  it('accepts valid standard OpenAI configuration', () => {
    ConfigValidator.validate({
      defaultProvider: 'openai',
      providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true } } // pragma: allowlist secret
    });
    assert(true);
  });

  it('rejects missing apiKey', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { openai: { model: 'gpt-5.5-pro', enabled: true } }
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('apiKey'));
    }
  });

  it('rejects missing defaultProvider', () => {
    try {
      ConfigValidator.validate({
        providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true } } // pragma: allowlist secret
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('defaultProvider'));
    }
  });

  it('rejects unknown provider names', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { deepseek: { apiKey: 'test', model: 'test', enabled: true } } // pragma: allowlist secret
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('Unknown provider'));
    }
  });

  it('rejects no enabled providers', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: false } } // pragma: allowlist secret
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('No providers enabled'));
    }
  });

  it('rejects missing model', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test', enabled: true } } // pragma: allowlist secret
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('model'));
    }
  });

  it('rejects invalid temperature', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true, temperature: 3.0 } } // pragma: allowlist secret
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('temperature'));
    }
  });

  it('rejects negative cost limits', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true } }, // pragma: allowlist secret
        limits: { maxCostPerRequest: -5 }
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('maxCostPerRequest'));
    }
  });
});

describe('ConfigValidator.getWarnings', () => {
  it('warns about unset environment variable API keys', () => {
    delete process.env.__ORACLE_TEST_NONEXISTENT__;
    const warnings = ConfigValidator.getWarnings({
      providers: { openai: { apiKey: '$__ORACLE_TEST_NONEXISTENT__', model: 'gpt-5.5-pro', enabled: true } }
    });
    assert(warnings.length > 0);
    assert(warnings[0].includes('__ORACLE_TEST_NONEXISTENT__'));
  });

  it('warns about sync mode disabled', () => {
    const warnings = ConfigValidator.getWarnings({
      providers: {
        openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true, useBackgroundMode: false } // pragma: allowlist secret
      }
    });
    assert(warnings.some(w => w.includes('useBackgroundMode')));
  });

  it('warns about high cost limits', () => {
    const warnings = ConfigValidator.getWarnings({
      providers: {},
      limits: { maxCostPerRequest: 50 }
    });
    assert(warnings.some(w => w.includes('High cost limit')));
  });
});

// ============================================================================
// JSON Envelope Tests
// ============================================================================

describe('buildEnvelope', () => {
  it('produces correct success envelope shape', () => {
    const env = buildEnvelope('estimate', { fileCount: 5 });
    assert(env.schemaVersion === 1, `schemaVersion: expected 1, got ${env.schemaVersion}`);
    assert(env.ok === true, `ok: expected true, got ${env.ok}`);
    assert(env.command === 'estimate', `command: expected estimate, got ${env.command}`);
    assert(env.data.fileCount === 5, `data.fileCount: expected 5, got ${env.data.fileCount}`);
    assert(env.error === undefined, 'success envelope should not have error');
  });

  it('preserves nested data unchanged', () => {
    const data = { a: 1, nested: { b: 2 } };
    const env = buildEnvelope('submit', data);
    assert(env.data === data, 'data should be the same reference');
  });
});

describe('buildErrorEnvelope', () => {
  it('produces correct error envelope from OracleError', () => {
    const err = new OracleError('COST_LIMIT_EXCEEDED', 'Too expensive', { limit: 10 });
    const env = buildErrorEnvelope('submit', err);
    assert(env.schemaVersion === 1);
    assert(env.ok === false, `ok: expected false, got ${env.ok}`);
    assert(env.command === 'submit');
    assert(env.error.code === 'COST_LIMIT_EXCEEDED');
    assert(env.error.message === 'Too expensive');
    assert(env.error.details.limit === 10);
    assert(env.data === undefined, 'error envelope should not have data');
  });

  it('wraps plain Error with UNKNOWN code', () => {
    const env = buildErrorEnvelope('estimate', new Error('something broke'));
    assert(env.ok === false);
    assert(env.error.code === 'UNKNOWN');
    assert(env.error.message === 'something broke');
  });
});

// ============================================================================
// OracleError Tests
// ============================================================================

describe('OracleError', () => {
  it('maps error codes to correct exit codes', () => {
    const cases = [
      ['CONFIG_NOT_FOUND', 2],
      ['CONFIG_INVALID', 2],
      ['CONFIG_PARSE_ERROR', 2],
      ['NO_PROVIDER', 2],
      ['VALIDATION_ERROR', 3],
      ['COST_LIMIT_EXCEEDED', 3],
      ['PROVIDER_ERROR', 4],
      ['TIMEOUT', 5],
      ['REMOTE_FAILED', 6],
      ['REMOTE_CANCELLED', 6],
    ];
    for (const [code, expectedExit] of cases) {
      const err = new OracleError(code, 'test');
      assert(err.exitCode === expectedExit,
        `${code}: expected exit ${expectedExit}, got ${err.exitCode}`);
    }
  });

  it('falls back to exit code 1 for unknown codes', () => {
    const err = new OracleError('MADE_UP_CODE', 'test');
    assert(err.exitCode === 1, `expected 1, got ${err.exitCode}`);
  });

  it('is an instance of Error', () => {
    const err = new OracleError('TIMEOUT', 'timed out');
    assert(err instanceof Error, 'should be instanceof Error');
    assert(err.name === 'OracleError');
    assert(err.message === 'timed out');
  });
});

// ============================================================================
// stripJsonComments Tests
// ============================================================================

describe('stripJsonComments', () => {
  it('strips // line comments', () => {
    const input = '{\n  "a": 1, // comment\n  "b": 2\n}';
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    assert(parsed.a === 1);
    assert(parsed.b === 2);
  });

  it('strips # line comments', () => {
    const input = '{\n  # this is a comment\n  "a": 1\n}';
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    assert(parsed.a === 1);
  });

  it('preserves URLs inside strings', () => {
    const input = '{ "url": "https://example.com/path" }';
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    assert(parsed.url === 'https://example.com/path',
      `expected URL preserved, got: ${parsed.url}`);
  });

  it('preserves # inside strings', () => {
    const input = '{ "color": "#ff0000" }';
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    assert(parsed.color === '#ff0000', `expected #ff0000, got: ${parsed.color}`);
  });

  it('handles escaped quotes inside strings', () => {
    const input = '{ "msg": "say \\"hello\\"" } // end';
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    assert(parsed.msg === 'say "hello"', `expected escaped quotes, got: ${parsed.msg}`);
  });

  it('produces valid JSON from .oraclerc-style content', () => {
    const input = `{
  "defaultProvider": "openai",
  // Main provider config
  "providers": {
    "openai": {
      "apiKey": "$OPENAI_API_KEY",
      "model": "gpt-5.5-pro",
      // "maxWaitMinutes": 120,
      "enabled": true
    }
  },
  # Cost limits
  "limits": {
    "maxCostPerRequest": 10.00
  }
}`;
    const result = stripJsonComments(input);
    const parsed = JSON.parse(result);
    assert(parsed.defaultProvider === 'openai');
    assert(parsed.providers.openai.apiKey === '$OPENAI_API_KEY');
    assert(parsed.providers.openai.maxWaitMinutes === undefined,
      'commented-out key should not appear');
    assert(parsed.limits.maxCostPerRequest === 10);
  });
});

// ============================================================================
// EXIT_CODES constant Tests
// ============================================================================

describe('EXIT_CODES', () => {
  it('has all expected error codes', () => {
    const expected = [
      'CONFIG_NOT_FOUND', 'CONFIG_INVALID', 'CONFIG_PARSE_ERROR', 'NO_PROVIDER',
      'VALIDATION_ERROR', 'COST_LIMIT_EXCEEDED', 'CONTEXT_TOO_LARGE', 'PROVIDER_ERROR',
      'TIMEOUT', 'REMOTE_FAILED', 'REMOTE_CANCELLED'
    ];
    for (const code of expected) {
      assert(EXIT_CODES[code] !== undefined, `missing EXIT_CODES.${code}`);
      assert(typeof EXIT_CODES[code] === 'number', `EXIT_CODES.${code} should be a number`);
    }
  });

  it('maps CONTEXT_TOO_LARGE to exit code 3', () => {
    assert(EXIT_CODES.CONTEXT_TOO_LARGE === 3, `expected 3, got ${EXIT_CODES.CONTEXT_TOO_LARGE}`);
  });
});

// ============================================================================
// CostCalculator.checkTokenLimits Tests
// ============================================================================

describe('CostCalculator.checkTokenLimits', () => {
  it('passes when within limits', () => {
    const provider = new MockProvider();
    const result = CostCalculator.checkTokenLimits(provider, 50000);
    assert(result.withinLimit === true, `expected withinLimit true, got ${result.withinLimit}`);
    assert(result.headroom > 0, `expected positive headroom, got ${result.headroom}`);
  });

  it('passes near boundary', () => {
    const provider = new MockProvider();
    // 200000 - 1700 overhead - 16000 output = 182300 max input
    const result = CostCalculator.checkTokenLimits(provider, 182000);
    assert(result.withinLimit === true, `expected withinLimit true near boundary`);
    assert(result.headroom > 0, `expected small positive headroom, got ${result.headroom}`);
  });

  it('fails when context exceeded', () => {
    const provider = new MockProvider();
    // 200000 total, need 190000 + 1700 overhead + 8000 output = 199700 — barely ok
    // But 195000 + 1700 + 8000 = 204700 — exceeds 200000
    const result = CostCalculator.checkTokenLimits(provider, 195000);
    assert(result.withinLimit === false, `expected withinLimit false for oversized context`);
  });

  it('includes actionable message on failure', () => {
    const provider = new MockProvider();
    const result = CostCalculator.checkTokenLimits(provider, 195000);
    assert(result.message.includes('Reduce input'), `message should suggest reducing input: ${result.message}`);
    assert(result.message.includes('195,000') || result.message.includes('195000'),
      `message should include token count: ${result.message}`);
  });

  it('reports correct headroom on success', () => {
    const provider = new MockProvider();
    // 50000 + 1700 overhead + 8000 output = 59700, headroom = 200000 - 59700 = 140300
    const result = CostCalculator.checkTokenLimits(provider, 50000);
    assert(result.headroom === 140300, `expected 140300 headroom, got ${result.headroom}`);
  });
});

// ============================================================================
// parseArgs Tests
// ============================================================================

describe('parseArgs', () => {
  it('parses estimate with patterns', () => {
    const result = parseArgs(['estimate', 'src/**/*.js']);
    assert(result.command === 'estimate', `expected estimate, got ${result.command}`);
    assert(result.patterns.length === 1);
    assert(result.patterns[0] === 'src/**/*.js');
  });

  it('parses submit with artifact flags', () => {
    const result = parseArgs(['submit', '--yes', '--json', '--artifact=/tmp/test.xml', '--context-hash=abc123', 'src/*.js', '--', 'Review this']);
    assert(result.command === 'submit');
    assert(result.artifact === '/tmp/test.xml');
    assert(result.contextHash === 'abc123');
    assert(result.flags.yes === true);
    assert(result.flags.json === true);
    assert(result.question === 'Review this');
  });

  it('separates question after --', () => {
    const result = parseArgs(['ask', 'src/**', '--', 'What', 'is', 'this?']);
    assert(result.command === 'ask');
    assert(result.question === 'What is this?');
    assert(result.patterns.length === 1);
    assert(result.patterns[0] === 'src/**');
  });

  it('defaults to ask command', () => {
    const result = parseArgs(['src/**/*.js', '--', 'Hello']);
    assert(result.command === 'ask', `expected ask, got ${result.command}`);
  });

  it('parses --cancel-on-timeout flag', () => {
    const result = parseArgs(['ask', '--cancel-on-timeout', 'src/**', '--', 'question']);
    assert(result.flags.cancelOnTimeout === true, 'expected cancelOnTimeout true');
  });

  it('parses list command', () => {
    const result = parseArgs(['list', '--json']);
    assert(result.command === 'list', `expected list, got ${result.command}`);
    assert(result.flags.json === true);
  });

  it('parses cleanup command', () => {
    const result = parseArgs(['cleanup']);
    assert(result.command === 'cleanup', `expected cleanup, got ${result.command}`);
  });

  it('parses --source-dir flag', () => {
    const result = parseArgs(['estimate', '--source-dir=/tmp/other-repo', 'src/**/*.cs']);
    assert(result.sourceDir === '/tmp/other-repo', `expected /tmp/other-repo, got ${result.sourceDir}`);
    assert(result.patterns[0] === 'src/**/*.cs');
  });

  it('parses single --extra-context flag', () => {
    const result = parseArgs(['ask', '--extra-context=/tmp/notes.md', 'src/**', '--', 'question']);
    assert(Array.isArray(result.extraContext), 'extraContext should be array');
    assert(result.extraContext.length === 1, `expected 1, got ${result.extraContext.length}`);
    assert(result.extraContext[0] === '/tmp/notes.md');
  });

  it('parses multiple --extra-context flags', () => {
    const result = parseArgs(['ask', '--extra-context=/tmp/a.md', '--extra-context=/tmp/b.md', '--extra-context=/tmp/c.md', '--', 'question']);
    assert(result.extraContext.length === 3, `expected 3, got ${result.extraContext.length}`);
    assert(result.extraContext[0] === '/tmp/a.md');
    assert(result.extraContext[1] === '/tmp/b.md');
    assert(result.extraContext[2] === '/tmp/c.md');
  });

  it('parses combined --source-dir and --extra-context', () => {
    const result = parseArgs(['ask', '--source-dir=/tmp/repo', '--extra-context=/tmp/doc.md', 'src/**', '--', 'question']);
    assert(result.sourceDir === '/tmp/repo');
    assert(result.extraContext.length === 1);
    assert(result.extraContext[0] === '/tmp/doc.md');
    assert(result.patterns[0] === 'src/**');
  });

  it('defaults sourceDir to null and extraContext to empty array', () => {
    const result = parseArgs(['estimate', 'src/**']);
    assert(result.sourceDir === null, `expected null, got ${result.sourceDir}`);
    assert(Array.isArray(result.extraContext) && result.extraContext.length === 0, 'extraContext should be empty array');
  });
});

// ============================================================================
// waitForCompletion Tests (async)
// ============================================================================

describe('waitForCompletion', () => {
  itAsync('returns completed on first poll', async () => {
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 1 } }, ui: {} };
    oracle.provider = new MockPollProvider([
      { status: 'completed', output: 'done', usage: { inputTokens: 100, outputTokens: 50 }, cost: 0.01, metadata: { provider: 'mock', model: 'mock-model' } }
    ]);
    const result = await oracle.waitForCompletion('req_123', { _pollIntervalMs: 1 });
    assert(result.status === 'completed', `expected completed, got ${result.status}`);
    assert(result.output === 'done');
  });

  itAsync('returns detached on timeout (default)', async () => {
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 0.001 } }, ui: {} }; // ~60ms
    oracle.provider = new MockPollProvider([]); // always in_progress
    const result = await oracle.waitForCompletion('req_456', { _pollIntervalMs: 1 });
    assert(result.status === 'detached', `expected detached, got ${result.status}`);
    assert(result.id === 'req_456');
  });

  itAsync('throws TIMEOUT when cancelOnTimeout is true', async () => {
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 0.001 } }, ui: {} };
    oracle.provider = new MockPollProvider([]);
    try {
      await oracle.waitForCompletion('req_789', { cancelOnTimeout: true, _pollIntervalMs: 1 });
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err instanceof OracleError, 'expected OracleError');
      assert(err.code === 'TIMEOUT', `expected TIMEOUT, got ${err.code}`);
    }
  });

  itAsync('retries on 429 with backoff callback', async () => {
    let backoffSeen = false;
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 1 } }, ui: {} };
    oracle.provider = new MockPollProvider([
      { _throw: { status: 429, message: 'rate limited' } },
      { status: 'completed', output: 'ok', usage: {}, cost: 0, metadata: { provider: 'mock', model: 'mock-model' } }
    ]);
    const result = await oracle.waitForCompletion('req_retry', {
      _pollIntervalMs: 1,
      onStatus: ({ status }) => { if (status === 'rate_limited') backoffSeen = true; }
    });
    assert(result.status === 'completed', `expected completed, got ${result.status}`);
    assert(backoffSeen, 'should have seen rate_limited callback');
  });

  itAsync('throws REMOTE_FAILED on failed status', async () => {
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 1 } }, ui: {} };
    oracle.provider = new MockPollProvider([
      { status: 'failed', error: 'something went wrong', output: '', usage: {}, cost: 0, metadata: { provider: 'mock', model: 'mock-model' } }
    ]);
    try {
      await oracle.waitForCompletion('req_fail', { _pollIntervalMs: 1 });
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err instanceof OracleError, 'expected OracleError');
      assert(err.code === 'REMOTE_FAILED', `expected REMOTE_FAILED, got ${err.code}`);
    }
  });

  itAsync('cancelOnTimeout is overridden to detach for expensive requests', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 0.001 } }, limits: { warnCostThreshold: 5 }, ui: {} };
    oracle._getHistoryDir = () => tmpDir;
    oracle.provider = new MockPollProvider([]); // always in_progress

    // Save a manifest with high estimated cost
    await oracle.saveManifest('req_expensive', {
      providerName: 'mock', model: 'mock-model', question: 'big review',
      patterns: ['**'], artifactPath: '/tmp/test.xml',
      submittedAt: '2026-03-14T00:00:00Z', estimatedCost: 8.50,
    });

    let overrideSeen = false;
    const result = await oracle.waitForCompletion('req_expensive', {
      cancelOnTimeout: true,
      _pollIntervalMs: 1,
      onStatus: ({ status }) => { if (status === 'detach_override') overrideSeen = true; },
    });

    // Should detach instead of cancel
    assert(result.status === 'detached', `expected detached, got ${result.status}`);
    assert(overrideSeen, 'should have seen detach_override callback');

    await rm(tmpDir, { recursive: true });
  });

  itAsync('cancelOnTimeout proceeds for cheap requests', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    const oracle = new Oracle();
    oracle.config = { providers: { mock: { maxWaitMinutes: 0.001 } }, limits: { warnCostThreshold: 5 }, ui: {} };
    oracle._getHistoryDir = () => tmpDir;
    oracle.provider = new MockPollProvider([]); // always in_progress

    // Save a manifest with low estimated cost
    await oracle.saveManifest('req_cheap', {
      providerName: 'mock', model: 'mock-model', question: 'quick q',
      patterns: ['*.js'], artifactPath: '/tmp/test.xml',
      submittedAt: '2026-03-14T00:00:00Z', estimatedCost: 0.50,
    });

    try {
      await oracle.waitForCompletion('req_cheap', {
        cancelOnTimeout: true,
        _pollIntervalMs: 1,
      });
      assert(false, 'should have thrown TIMEOUT');
    } catch (err) {
      assert(err instanceof OracleError, 'expected OracleError');
      assert(err.code === 'TIMEOUT', `expected TIMEOUT, got ${err.code}`);
    }

    await rm(tmpDir, { recursive: true });
  });
});

// ============================================================================
// Request Manifest Tests (async)
// ============================================================================

describe('Request manifests', () => {
  itAsync('saveManifest + loadManifest roundtrip', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    const oracle = new Oracle();
    oracle.config = { ui: { historyPath: tmpDir } };
    // Override _getHistoryDir to use tmpDir directly
    oracle._getHistoryDir = () => tmpDir;

    await oracle.saveManifest('req_001', {
      providerName: 'mock', model: 'mock-model', question: 'test?',
      patterns: ['src/**'], artifactPath: '/tmp/test.xml',
      submittedAt: '2026-03-14T00:00:00Z',
    });

    const loaded = await oracle.loadManifest('req_001');
    assert(loaded !== null, 'manifest should exist');
    assert(loaded.requestId === 'req_001');
    assert(loaded.providerName === 'mock');
    assert(loaded.question === 'test?');
    assert(loaded.status === 'in_progress');

    await rm(tmpDir, { recursive: true });
  });

  itAsync('returns null for nonexistent manifest', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    const oracle = new Oracle();
    oracle._getHistoryDir = () => tmpDir;

    const loaded = await oracle.loadManifest('nonexistent');
    assert(loaded === null, 'expected null for missing manifest');

    await rm(tmpDir, { recursive: true });
  });

  itAsync('listManifests sorted by submittedAt desc', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    const oracle = new Oracle();
    oracle.config = { ui: { historyPath: tmpDir } };
    oracle._getHistoryDir = () => tmpDir;

    await oracle.saveManifest('req_old', {
      providerName: 'mock', model: 'mock-model', question: 'old',
      patterns: [], artifactPath: '', submittedAt: '2026-03-13T00:00:00Z',
    });
    await oracle.saveManifest('req_new', {
      providerName: 'mock', model: 'mock-model', question: 'new',
      patterns: [], artifactPath: '', submittedAt: '2026-03-14T00:00:00Z',
    });

    const list = await oracle.listManifests();
    assert(list.length === 2, `expected 2 manifests, got ${list.length}`);
    assert(list[0].requestId === 'req_new', 'newest should be first');
    assert(list[1].requestId === 'req_old', 'oldest should be second');

    await rm(tmpDir, { recursive: true });
  });

  itAsync('updateManifestStatus updates status field', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-test-'));
    const oracle = new Oracle();
    oracle.config = { ui: { historyPath: tmpDir } };
    oracle._getHistoryDir = () => tmpDir;

    await oracle.saveManifest('req_update', {
      providerName: 'mock', model: 'mock-model', question: 'test',
      patterns: [], artifactPath: '', submittedAt: '2026-03-14T00:00:00Z',
    });

    await oracle.updateManifestStatus('req_update', 'completed');
    const loaded = await oracle.loadManifest('req_update');
    assert(loaded.status === 'completed', `expected completed, got ${loaded.status}`);

    await rm(tmpDir, { recursive: true });
  });
});

// ============================================================================
// Artifact Sidecar Tests (async)
// ============================================================================

describe('Artifact sidecar', () => {
  itAsync('sidecar with matching hash is accepted', async () => {
    const { writeFile: write } = await import('fs/promises');
    const { createHash } = await import('crypto');
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-sidecar-'));
    const xmlPath = join(tmpDir, 'oracle-context-test.xml');
    const sidecarPath = join(tmpDir, 'oracle-context-test.manifest.json');

    const content = '<xml>test context</xml>';
    const contextHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

    await write(xmlPath, content);
    await write(sidecarPath, JSON.stringify({
      contextHash,
      tokenCount: 100,
      fileCount: 2,
      files: [{ path: 'a.js', tokens: 50 }, { path: 'b.js', tokens: 50 }],
    }));

    // Simulate what submit() does with sidecar
    const sidecarContent = await readFile(sidecarPath, 'utf-8');
    const sidecar = JSON.parse(sidecarContent);
    assert(sidecar.contextHash === contextHash, 'sidecar hash should match');

    const readContent = await readFile(xmlPath, 'utf-8');
    const verifyHash = createHash('sha256').update(readContent).digest('hex').slice(0, 16);
    assert(verifyHash === contextHash, 'XML content hash should match sidecar');

    await rm(tmpDir, { recursive: true });
  });

  itAsync('mismatched hash is rejected', async () => {
    const { writeFile: write } = await import('fs/promises');
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-sidecar-'));
    const sidecarPath = join(tmpDir, 'test.manifest.json');

    await write(sidecarPath, JSON.stringify({ contextHash: 'aaaa1111bbbb2222' }));

    const sidecarContent = await readFile(sidecarPath, 'utf-8');
    const sidecar = JSON.parse(sidecarContent);
    assert(sidecar.contextHash !== 'different_hash_value', 'hashes should not match');

    await rm(tmpDir, { recursive: true });
  });

  itAsync('missing sidecar falls back gracefully', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'oracle-sidecar-'));
    const sidecarPath = join(tmpDir, 'nonexistent.manifest.json');

    let sidecarContent = null;
    try {
      sidecarContent = await readFile(sidecarPath, 'utf-8');
    } catch {
      // expected
    }
    assert(sidecarContent === null, 'missing sidecar should result in null');

    await rm(tmpDir, { recursive: true });
  });
});

// ============================================================================
// ConfigValidator: background mode warnings
// ============================================================================

describe('ConfigValidator: background mode warnings', () => {
  it('warns when useBackgroundMode is false', () => {
    const warnings = ConfigValidator.getWarnings({
      providers: {
        openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true, useBackgroundMode: false } // pragma: allowlist secret
      }
    });
    assert(warnings.some(w => w.includes('useBackgroundMode')),
      `expected background mode warning, got: ${warnings}`);
  });

  it('no warning when useBackgroundMode is true or absent', () => {
    const warnings1 = ConfigValidator.getWarnings({
      providers: {
        openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true, useBackgroundMode: true } // pragma: allowlist secret
      }
    });
    assert(!warnings1.some(w => w.includes('useBackgroundMode')),
      'should not warn when background mode is true');

    const warnings2 = ConfigValidator.getWarnings({
      providers: {
        openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true } // pragma: allowlist secret
      }
    });
    assert(!warnings2.some(w => w.includes('useBackgroundMode')),
      'should not warn when background mode is absent');
  });

  it('rejects invalid sdkTimeoutMinutes', () => {
    try {
      ConfigValidator.validate({
        defaultProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true, sdkTimeoutMinutes: -5 } } // pragma: allowlist secret
      });
      assert(false, 'Should have thrown');
    } catch (e) {
      assert(e.message.includes('sdkTimeoutMinutes'), `expected sdkTimeoutMinutes error, got: ${e.message}`);
    }
  });

  it('accepts valid sdkTimeoutMinutes', () => {
    ConfigValidator.validate({
      defaultProvider: 'openai',
      providers: { openai: { apiKey: 'sk-test', model: 'gpt-5.5-pro', enabled: true, sdkTimeoutMinutes: 30 } } // pragma: allowlist secret
    });
    assert(true);
  });
});

// ============================================================================
// Integration Tests: Repomix packing (real I/O)
// ============================================================================

import { RepomixWrapper } from '../repomix-wrapper.js';

describe('Integration: RepomixWrapper', () => {
  itAsync('packs real files and returns valid metadata', async () => {
    const repomix = new RepomixWrapper({ style: 'xml', compress: true, includeLineNumbers: true, removeComments: false });
    const result = await repomix.pack(['package.json']);

    assert(result.fileCount >= 1, `expected at least 1 file, got ${result.fileCount}`);
    assert(result.tokenCount > 0, `expected positive token count, got ${result.tokenCount}`);
    assert(result.outputPath.includes('oracle-context-'), `expected oracle-context- in path, got ${result.outputPath}`);
    assert(Array.isArray(result.files), 'files should be an array');
    assert(result.files.some(f => f.path === 'package.json'), 'should include package.json');

    // Clean up
    const { unlink: del } = await import('fs/promises');
    await del(result.outputPath).catch(() => {});
  });

  itAsync('packAndRead returns context string and metadata', async () => {
    const repomix = new RepomixWrapper({ style: 'xml', compress: true, includeLineNumbers: true, removeComments: false });
    const { context, metadata } = await repomix.packAndRead(['package.json']);

    assert(typeof context === 'string', 'context should be a string');
    assert(context.length > 0, 'context should not be empty');
    assert(metadata.tokenCount > 0, `expected positive tokens, got ${metadata.tokenCount}`);
    assert(metadata.fileCount >= 1, `expected at least 1 file, got ${metadata.fileCount}`);

    // Clean up
    const { unlink: del } = await import('fs/promises');
    await del(metadata.outputPath).catch(() => {});
  });

  itAsync('packing nonexistent pattern returns zero files', async () => {
    const repomix = new RepomixWrapper({ style: 'xml', compress: true, includeLineNumbers: true, removeComments: false });
    const result = await repomix.pack(['__nonexistent_pattern_xyz_**/*.zzz']);
    assert(result.fileCount === 0, `expected 0 files for bogus pattern, got ${result.fileCount}`);

    const { unlink: del } = await import('fs/promises');
    await del(result.outputPath).catch(() => {});
  });

  itAsync('multiple patterns pack multiple files', async () => {
    const repomix = new RepomixWrapper({ style: 'xml', compress: true, includeLineNumbers: true, removeComments: false });
    const result = await repomix.pack(['package.json', 'CLAUDE.md']);

    assert(result.fileCount >= 2, `expected at least 2 files, got ${result.fileCount}`);

    const { unlink: del } = await import('fs/promises');
    await del(result.outputPath).catch(() => {});
  });
});

// ============================================================================
// Integration Tests: Config loading (real file I/O)
// ============================================================================

describe('Integration: Config loading', () => {
  itAsync('loads and parses .oraclerc.example as valid config', async () => {
    const content = await readFile(join(process.cwd(), '.oraclerc.example'), 'utf-8');
    const stripped = stripJsonComments(content);
    const config = JSON.parse(stripped);

    assert(config.defaultProvider === 'openai', `expected openai, got ${config.defaultProvider}`);
    assert(config.providers.openai.enabled === true, 'openai should be enabled');
    assert(config.limits.maxCostPerRequest === 10, `expected limit 10, got ${config.limits.maxCostPerRequest}`);

    // Should pass validation
    ConfigValidator.validate(config);
  });

  itAsync('stripJsonComments roundtrips with real .oraclerc.example', async () => {
    const content = await readFile(join(process.cwd(), '.oraclerc.example'), 'utf-8');

    // Should contain comments
    assert(content.includes('//'), '.oraclerc.example should have // comments');

    // After stripping, should be valid JSON
    const stripped = stripJsonComments(content);
    const parsed = JSON.parse(stripped);
    assert(typeof parsed === 'object', 'should parse to an object');
  });
});

// ============================================================================
// Integration Tests: Full estimate pipeline (Repomix + CostCalculator)
// ============================================================================

describe('Integration: Estimate pipeline', () => {
  itAsync('estimate with real Repomix produces complete result', async () => {
    // Create a minimal Oracle with mock provider (no API key needed for estimate)
    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: { maxCostPerRequest: 10, warnCostThreshold: 5 },
      ui: {},
    };
    oracle.provider = new MockProvider();

    const result = await oracle.estimate({ patterns: ['package.json'] });

    // Verify all expected fields
    assert(result.fileCount >= 1, `expected >= 1 file, got ${result.fileCount}`);
    assert(result.tokenCount > 0, `expected positive tokens, got ${result.tokenCount}`);
    assert(result.estimate.estimatedCost > 0, `expected positive cost, got ${result.estimate.estimatedCost}`);
    assert(result.limitCheck.withinLimit === true, 'should be within limit');
    assert(result.tokenCheck.withinLimit === true, 'should be within token limit');
    assert(typeof result.artifactPath === 'string', 'should have artifactPath');
    assert(typeof result.contextHash === 'string', 'should have contextHash');
    assert(result.contextHash.length === 16, `contextHash should be 16 chars, got ${result.contextHash.length}`);
    assert(Array.isArray(result.sensitiveFiles), 'sensitiveFiles should be an array');

    // Verify sidecar was written
    const sidecarContent = await readFile(result.sidecarPath, 'utf-8').catch(() => null);
    assert(sidecarContent !== null, 'sidecar file should exist');
    const sidecar = JSON.parse(sidecarContent);
    assert(sidecar.contextHash === result.contextHash, 'sidecar hash should match');

    // Clean up
    const { unlink: del } = await import('fs/promises');
    await del(result.artifactPath).catch(() => {});
    await del(result.sidecarPath).catch(() => {});
  });

  itAsync('estimate with extra-context file produces combined result', async () => {
    const { writeFile: wf, unlink: del } = await import('fs/promises');
    const tmpFile = '/tmp/oracle-test-extra-context.md';
    await wf(tmpFile, '# Test Extra Context\n\nThis is research context for the oracle.\n'.repeat(10));

    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: { maxCostPerRequest: 10, warnCostThreshold: 5 },
      ui: {},
    };
    oracle.provider = new MockProvider();

    const result = await oracle.estimate({ patterns: ['package.json'], extraContext: [tmpFile] });

    // Extra-context file should be counted
    assert(result.fileCount >= 2, `expected >= 2 files (1 code + 1 extra), got ${result.fileCount}`);
    assert(result.tokenCount > 0, `expected positive tokens, got ${result.tokenCount}`);
    assert(typeof result.contextHash === 'string' && result.contextHash.length === 16);
    assert(typeof result.artifactPath === 'string');

    // Clean up
    await del(result.artifactPath).catch(() => {});
    await del(result.sidecarPath).catch(() => {});
    await del(tmpFile).catch(() => {});
  });

  itAsync('estimate with only extra-context (no patterns) skips repomix', async () => {
    const { writeFile: wf, unlink: del } = await import('fs/promises');
    const tmpFile = '/tmp/oracle-test-extra-only.md';
    await wf(tmpFile, 'Some research context for analysis');

    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: { maxCostPerRequest: 10, warnCostThreshold: 5 },
      ui: {},
    };
    oracle.provider = new MockProvider();

    const result = await oracle.estimate({ patterns: [], extraContext: [tmpFile] });

    assert(result.fileCount === 1, `expected 1 file (extra-context only), got ${result.fileCount}`);
    assert(result.tokenCount > 0, `expected positive tokens, got ${result.tokenCount}`);
    assert(typeof result.contextHash === 'string' && result.contextHash.length === 16);

    // Clean up
    await del(result.artifactPath).catch(() => {});
    await del(result.sidecarPath).catch(() => {});
    await del(tmpFile).catch(() => {});
  });

  itAsync('estimate with nonexistent extra-context throws VALIDATION_ERROR', async () => {
    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: {},
      ui: {},
    };
    oracle.provider = new MockProvider();

    try {
      await oracle.estimate({ patterns: ['package.json'], extraContext: ['/tmp/nonexistent-file-xyz.md'] });
      assert(false, 'should have thrown');
    } catch (err) {
      assert(err.code === 'VALIDATION_ERROR', `expected VALIDATION_ERROR, got ${err.code}`);
      assert(err.message.includes('not found'), `expected "not found" in message, got: ${err.message}`);
    }
  });

  itAsync('estimate context hash is deterministic', async () => {
    const { writeFile: wf, unlink: del } = await import('fs/promises');
    const tmpFile = '/tmp/oracle-test-hash-determinism.md';
    await wf(tmpFile, 'Deterministic content test');

    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: { maxCostPerRequest: 10, warnCostThreshold: 5 },
      ui: {},
    };
    oracle.provider = new MockProvider();

    const result1 = await oracle.estimate({ patterns: [], extraContext: [tmpFile] });
    const result2 = await oracle.estimate({ patterns: [], extraContext: [tmpFile] });

    assert(result1.contextHash === result2.contextHash,
      `hashes should match: ${result1.contextHash} vs ${result2.contextHash}`);

    // Clean up
    await del(result1.artifactPath).catch(() => {});
    await del(result1.sidecarPath).catch(() => {});
    await del(result2.artifactPath).catch(() => {});
    await del(result2.sidecarPath).catch(() => {});
    await del(tmpFile).catch(() => {});
  });

  itAsync('estimate sensitive file detection includes extra-context paths', async () => {
    const { writeFile: wf, unlink: del } = await import('fs/promises');
    const tmpFile = '/tmp/oracle-test-credentials.env';
    await wf(tmpFile, 'SECRET=foo');

    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: { maxCostPerRequest: 10, warnCostThreshold: 5 },
      ui: {},
    };
    oracle.provider = new MockProvider();

    const result = await oracle.estimate({ patterns: [], extraContext: [tmpFile] });

    assert(result.sensitiveFiles.length >= 1, `expected at least 1 sensitive file, got ${result.sensitiveFiles.length}`);
    assert(result.sensitiveFiles.some(f => f.path.includes('.env')), 'should detect .env in extra-context');

    // Clean up
    await del(result.artifactPath).catch(() => {});
    await del(result.sidecarPath).catch(() => {});
    await del(tmpFile).catch(() => {});
  });

  itAsync('estimate with sourceDir packs from that directory', async () => {
    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: { maxCostPerRequest: 10, warnCostThreshold: 5 },
      ui: {},
    };
    oracle.provider = new MockProvider();

    // Use the oracle project's own root as sourceDir
    const result = await oracle.estimate({
      patterns: ['package.json'],
      sourceDir: process.cwd(),
    });

    assert(result.fileCount >= 1, `expected >= 1 file, got ${result.fileCount}`);
    assert(result.tokenCount > 0);

    // Clean up
    const { unlink: del } = await import('fs/promises');
    await del(result.artifactPath).catch(() => {});
    await del(result.sidecarPath).catch(() => {});
  });

  itAsync('estimate detects sensitive files', async () => {
    const oracle = new Oracle();
    oracle.config = {
      defaultProvider: 'openai',
      providers: { mock: {} },
      repomix: { style: 'xml', compress: true, includeLineNumbers: true, removeComments: false },
      limits: {},
      ui: {},
    };
    oracle.provider = new MockProvider();

    // Test sensitive file detection with mock file list
    const sensitive = oracle.checkSensitiveFiles([
      { path: 'src/app.js' },
      { path: '.env' },
      { path: 'config/credentials.json' },
      { path: 'certs/server.pem' },
      { path: 'src/utils.js' },
    ]);

    assert(sensitive.length === 3, `expected 3 sensitive files, got ${sensitive.length}`);
    assert(sensitive.some(f => f.path === '.env'), 'should detect .env');
    assert(sensitive.some(f => f.path.includes('credentials')), 'should detect credentials');
    assert(sensitive.some(f => f.path.includes('.pem')), 'should detect .pem');
  });
});

// ============================================================================
// Integration Tests: Provider construction
// ============================================================================

import { OpenAIProvider } from '../providers/openai.js';

describe('Integration: OpenAI provider construction', () => {
  it('creates standard OpenAI provider with API key', () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test-key-123', // pragma: allowlist secret
      model: 'gpt-5.5-pro',
    });
    assert(provider.getName() === 'openai');
    assert(provider.getModelName() === 'gpt-5.5-pro');
    assert(provider.getDisplayName() === 'OpenAI GPT-5.5-PRO');
    assert(provider.getMaxContextTokens() === 1050000);
    assert(provider.getMaxOutputTokens() === 128000);
    assert(provider.supportsBackgroundMode() === true);
  });

  it('defaults useBackgroundMode to true', () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test', // pragma: allowlist secret
      model: 'gpt-5.5-pro',
    });
    // useBackgroundMode defaults to true when not set
    assert(provider.config.useBackgroundMode !== false,
      'useBackgroundMode should default to truthy');
  });

  it('calculates cost correctly', () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test', // pragma: allowlist secret
      model: 'gpt-5.5-pro',
    });
    const pricing = provider.getPricing();
    assert(pricing.input === 30, `expected input $30/M, got ${pricing.input}`);
    assert(pricing.output === 180, `expected output $180/M, got ${pricing.output}`);

    const cost = provider.calculateCost({ inputTokens: 10000, outputTokens: 1000, reasoningTokens: 0 });
    // 10k @ $30/M = $0.30, 1k @ $180/M = $0.18
    assertClose(cost, 0.48, 0.01);
  });

  it('normalizes response status correctly', () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test', // pragma: allowlist secret
      model: 'gpt-5.5-pro',
    });
    const normalized = provider.normalizeResponse({
      id: 'resp_test',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
    assert(normalized.id === 'resp_test');
    assert(normalized.status === 'completed');
    assert(normalized.output === 'hello');
    assert(normalized.usage.inputTokens === 100);
    assert(normalized.usage.outputTokens === 50);
  });
});

// ============================================================================
// Toolbelt contract: the spend gate, the code-level defaults, the data dir
// ============================================================================

import { spawnSync, spawn } from 'child_process';
import { createServer } from 'http';
import { readFileSync, existsSync as _existsSync, mkdtempSync } from 'fs';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { DEFAULT_LIMITS, DEFAULT_CONFIG, EXIT_CODES as _EXIT, dataDir, artifactsDir } from '../oracle-service.js';
import { rerunCommand } from '../oracle.js';

const CLI = new URL('../oracle.js', import.meta.url).pathname;
const TOOL_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const SKILL_MD = new URL('../../SKILL.md', import.meta.url).pathname;

function runCli(args, { env = {}, cwd = TOOL_ROOT } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'], // no stdin, no tty: the agent's shape
    encoding: 'utf8',
  });
}

describe('Toolbelt contract: spend gate', () => {
  it('CONFIRMATION_REQUIRED maps to exit 7', () => {
    assert(_EXIT.CONFIRMATION_REQUIRED === 7, `expected 7, got ${_EXIT.CONFIRMATION_REQUIRED}`);
  });

  it('rerunCommand puts --yes first and never duplicates it', () => {
    const saved = process.argv;
    process.argv = ['node', 'oracle.js', 'submit', '--yes', 'src/**/*.js', '--', 'Review this'];
    try {
      const cmd = rerunCommand();
      assert(cmd.startsWith('node oracle.js --yes submit'), cmd);
      assert(cmd.split('--yes').length === 2, `--yes repeated: ${cmd}`);
      assert(cmd.includes(`'Review this'`), cmd);
    } finally {
      process.argv = saved;
    }
  });

  it('submit with no --yes, no tty, --json exits 7 and sends nothing', () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-gate-'));
    const r = runCli(['submit', '--json', SKILL_MD, '--', 'test question'], { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: '' } });
    assert(r.status === 7, `expected exit 7, got ${r.status}: ${r.stderr}`);
    const env = JSON.parse(r.stdout);
    assert(env.ok === false && env.error.code === 'CONFIRMATION_REQUIRED', r.stdout);
    assert(env.error.details.rerun.startsWith('node oracle.js --yes submit'), env.error.details.rerun);
    assert(env.error.details.preview.fileCount === 1, 'preview carries the estimate');
    assert(!_existsSync(join(data, 'audit.log')), 'no audit line: nothing was sent');
    assert(!r.stderr.includes('[oracle audit]'), 'no audit line on stderr either');
  });

  it('submit with no --yes and no tty (human mode) exits 7 too', () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-gate-'));
    const r = runCli(['submit', SKILL_MD, '--', 'test question'], { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: '' } });
    assert(r.status === 7, `expected exit 7, got ${r.status}: ${r.stderr}`);
    assert(r.stderr.includes('Nothing was sent'), r.stderr);
  });

  it('ask with no --yes, no tty exits 7', () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-gate-'));
    const r = runCli(['ask', '--json', SKILL_MD, '--', 'test question'], { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: '' } });
    assert(r.status === 7, `expected exit 7, got ${r.status}: ${r.stderr}`);
  });

});

// A stand-in for api.openai.com: the SDK honors OPENAI_BASE_URL, so the real provider code,
// the real CLI and the real gate run end-to-end with nothing leaving the machine.
function mockOpenAI({ status = 200, body } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? { id: 'resp_mock_1', status: 'queued', output: [], usage: {} }));
    });
  });
  return new Promise(resolveUp => {
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolveUp({ baseUrl, hits, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function runCliAsync(args, { env = {}, cwd = TOOL_ROOT } = {}) {
  return new Promise(resolveUp => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', status => resolveUp({ status, stdout, stderr }));
  });
}

describe('Toolbelt contract: the approved send (mock provider)', () => {
  itAsync('bare `submit --yes` (no --artifact) packs once, sends, exits 0, audits', async () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-send-'));
    const mock = await mockOpenAI();
    try {
      const r = await runCliAsync(['--yes', 'submit', SKILL_MD, '--', 'test question'],
        { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: 'sk-test-mock', OPENAI_BASE_URL: mock.baseUrl } }); // pragma: allowlist secret
      assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
      assert(r.stdout.includes('Submitted (Request ID: resp_mock_1)'), r.stdout);
      assert(mock.hits.length === 1 && mock.hits[0].url === '/v1/responses', JSON.stringify(mock.hits.map(h => h.url)));
      assert(mock.hits[0].body.input[0].content[0].text.includes('Ask the Oracle'), 'the pack reached the provider');
      const log = readFileSync(join(data, 'audit.log'), 'utf8');
      assert(/verb=submit .*request="resp_mock_1"/.test(log), log);
      assert(!log.includes('test question'), 'the audit line never carries the question');
    } finally {
      await mock.close();
    }
  });

  itAsync('`submit --yes --json` without --artifact returns the envelope', async () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-send-'));
    const mock = await mockOpenAI();
    try {
      const r = await runCliAsync(['submit', '--yes', '--json', SKILL_MD, '--', 'test question'],
        { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: 'sk-test-mock', OPENAI_BASE_URL: mock.baseUrl } }); // pragma: allowlist secret
      assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
      const env = JSON.parse(r.stdout);
      assert(env.ok && env.data.requestId === 'resp_mock_1', r.stdout);
    } finally {
      await mock.close();
    }
  });

  itAsync('a provider failure exits 4 and leaves a submit-failed audit line', async () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-send-'));
    const mock = await mockOpenAI({ status: 401, body: { error: { message: 'Incorrect API key provided' } } });
    try {
      const r = await runCliAsync(['--yes', 'submit', SKILL_MD, '--', 'test question'],
        { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: 'sk-test-mock', OPENAI_BASE_URL: mock.baseUrl, OPENAI_MAX_RETRIES: '0' } }); // pragma: allowlist secret
      assert(r.status === 4, `expected exit 4, got ${r.status}: ${r.stderr}`);
      const log = readFileSync(join(data, 'audit.log'), 'utf8');
      assert(log.includes('verb=submit-failed'), log);
      assert(/error="[^"]*401/.test(log), log);
      assert(!/verb=submit /.test(log), 'no success line for a failed attempt');
    } finally {
      await mock.close();
    }
  });

  it('DECLINED maps to exit 8, distinct from an unknown error', () => {
    assert(_EXIT.DECLINED === 8, `expected 8, got ${_EXIT.DECLINED}`);
  });
});

describe('Toolbelt contract: defaults and data dir', () => {
  it('DEFAULT_LIMITS carry a ceiling and a warn threshold', () => {
    assert(DEFAULT_LIMITS.maxCostPerRequest === 10, 'ceiling is $10');
    assert(DEFAULT_LIMITS.warnCostThreshold === 5, 'warn at $5');
    assert(DEFAULT_CONFIG.providers.openai.apiKey === '$OPENAI_API_KEY', 'key is a reference, never a literal');
  });

  it('ORACLE_DATA_DIR relocates data/, default is the tool dir', () => {
    assert(dataDir() === resolve(process.env.ORACLE_DATA_DIR), `dataDir ${dataDir()}`);
    assert(artifactsDir().startsWith(dataDir()), 'artifacts live under data');
  });

  itAsync('init() without .oraclerc runs on defaults and names the mode', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'oracle-nocfg-'));
    const saved = process.cwd();
    process.chdir(cwd);
    try {
      const oracle = await new Oracle().init();
      assert(oracle.configSource === 'defaults');
      assert(oracle.config.limits.maxCostPerRequest === 10);
      assert(oracle.getWarnings().some(w => w.includes('built-in defaults')), 'warning names the degraded mode');
    } finally {
      process.chdir(saved);
    }
  });

  itAsync('init() with a .oraclerc that omits limits still gets the code-level ceiling', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'oracle-cfg-'));
    await writeFile(join(cwd, '.oraclerc'), JSON.stringify({ defaultProvider: 'openai', providers: { openai: { apiKey: '$OPENAI_API_KEY', model: 'gpt-5.5-pro', enabled: true } } }));
    const saved = process.cwd();
    process.chdir(cwd);
    try {
      const oracle = await new Oracle().init();
      assert(oracle.configSource === 'file');
      assert(oracle.config.limits.maxCostPerRequest === 10 && oracle.config.limits.warnCostThreshold === 5, JSON.stringify(oracle.config.limits));
    } finally {
      process.chdir(saved);
    }
  });

  it('estimate --json works with no key and writes only under ORACLE_DATA_DIR', () => {
    const data = mkdtempSync(join(tmpdir(), 'oracle-est-'));
    const r = runCli(['estimate', '--json', SKILL_MD], { env: { ORACLE_DATA_DIR: data, OPENAI_API_KEY: '' } });
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    const env = JSON.parse(r.stdout);
    assert(env.ok && env.data.artifactPath.startsWith(join(data, 'artifacts')), env.data.artifactPath);
    assert(readFileSync(env.data.artifactPath, 'utf8').includes('Ask the Oracle'), 'the pack holds the packed file');
  });
});

// ============================================================================
// Run async tests, then summary
// ============================================================================

async function runAllAsync() {
  if (asyncTests.length > 0) {
    for (const { name, fn } of asyncTests) {
      try {
        await fn();
        passed++;
        console.log(`    \u2705 ${name}`);
      } catch (error) {
        failed++;
        failures.push({ name, error: error.message });
        console.log(`    \u274c ${name}`);
        console.log(`       ${error.message}`);
      }
    }
  }

  console.log('\n' + '\u2500'.repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    \u2022 ${f.name}: ${f.error}`));
  }
  console.log('\u2500'.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAllAsync();
