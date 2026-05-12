# Drift v0.1.1

## Highlights
- Local-first semantic integrity checks for TypeScript and JavaScript projects.
- Reviewable `.drift` contracts and manifest checks for trusted baseline workflows.
- Fail-closed CLI behavior for staged checks, CI checks, and local Git hooks.

## What's included
- `drift init`, `check`, `ci`, `watch`, `unwatch`, `status`, `ls`, `evolve`, `ignore`, `add`, and `refresh` commands.
- Contract patterns for nullification, sensitive logging, validation, rate limits, return and parameter boundaries, error handling, side effects, guard clauses, required calls, and imports.
- JSON, terminal, and GitHub-style reporting paths.
- GitHub Actions CI configuration for typecheck, lint, tests, coverage, build, audit, and npm package dry-run.

## Installation

Local development from this repository:

```bash
npm ci
npm run build
node dist/index.js --help
```

After npm publication, install as a development dependency:

```bash
npm install --save-dev drift-check
```

## Usage

```bash
npm exec drift -- init
npm exec drift -- check --staged
npm exec drift -- ci --baseline-ref origin/main
```

## Security / Privacy
- Drift's default workflow is static analysis and does not require API keys or a cloud service.
- Repository files, `.drift` metadata, Git index content, and generated text are treated as untrusted input.
- Evidence snippets are shortened and redacted before storage or terminal output.
- Users should not commit secrets, private URLs, production database URLs, local machine paths, or personal data in fixtures, contracts, screenshots, or logs.

## Breaking changes
- None. This is the first public release candidate for the current `0.1.x` line.

## Notes
- Drift is static analysis, not a proof system. Keep high-risk behavior covered by tests and code review.
- The npm package is prepared by dry-run only in this release process; external package publication must be performed separately.
