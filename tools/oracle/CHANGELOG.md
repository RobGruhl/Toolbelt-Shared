# Changelog

All notable changes to Ask the Oracle will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-08-22 — vendored into the Toolbelt as tools/oracle

### Changed
- The paid send (`submit`, `ask`) is gated to the belt's flag tier: estimate + file list + sensitive-file warning, then a typed yes on /dev/tty (not stdin) or an explicit `--yes`; with no terminal or under `--json` it exits 7 (`CONFIRMATION_REQUIRED`) with the `--yes` re-run and sends nothing. `--json` no longer bypasses the confirmation
- Continuations (`--continue`) pass the same gate
- API key: `$VAR` references fall back to the macOS Keychain (service = VAR); the OpenAI client is built lazily so `estimate`/`list`/`cleanup` need no key
- `.oraclerc` is optional: built-in defaults (gpt-5.5-pro, $10/$5 limits) apply and are named in the warnings; `DEFAULT_LIMITS` apply even when a `.oraclerc` omits `limits`
- Packed artifacts, history, request manifests and the audit log live under `tools/oracle/data/` (dir 700, files 600; `ORACLE_DATA_DIR` overrides), not `/tmp` or the project's `.claude/`
- Audit line per send and per cancel to `data/audit.log` and stderr; a provider failure (401, 429, network) writes a `submit-failed` / `cancel-failed` line so every attempt is on the record
- A `no` at the /dev/tty prompt exits 8 (`DECLINED`), distinct from exit 1 (unknown error)
- `submit --yes` without `--artifact` and `--context-hash` reuses the pack its own preview wrote; the send path is tested end-to-end against a mock provider (`OPENAI_BASE_URL`)
- Root `oracle.js` shim; `checks/openai-key.mjs` doctor probe; tests for the gate, the defaults and the data dir

### Removed
- `scripts/` one-off drift-check scripts, `.claude/settings.local.json`, `.claude-plugin/plugin.json`, `bun.lock` (npm lockfile committed instead)

## [1.1.0] - 2026-03-13

### Changed
- Updated dependencies: repomix 1.12.0, openai 6.29.0, chalk 5.6.2, ora 9.3.0
- Resolved all 8 npm audit vulnerabilities (now 0)
- Removed node_modules from git tracking (was 193MB)
- Aligned plugin.json and SKILL.md with Anthropic spec
- SKILL.md uses `${CLAUDE_SKILL_DIR}` for portable paths
- Improved skill description for better auto-triggering
- Updated pricing to March 2026 rates ($30/M input, $180/M output)
- Removed dead code (unused imports, uncalled methods, unenforced config fields)
- Consolidated docs: replaced 5 stale reference copies with single REFERENCES.md
- Trimmed README from 509 to 140 lines, CLAUDE.md from 272 to 127 lines

### Removed
- Obsolete planning docs (PLAN, PRD, HANDOFF, etc.)
- .claude-plugin/README.md (only plugin.json belongs per spec)

## [1.0.0] - 2025-11-11

### Added
- Initial release with OpenAI GPT-5.4 Pro integration
- Cost tracking and transparent breakdown
- History storage in `.claude/oracle-history/`
- Repomix integration for code packaging
- Configuration system via `.oraclerc`
- Provider abstraction layer for future multi-model support
- Long-running request handling with polling (Responses API)
- Background Bash execution for non-blocking operation
