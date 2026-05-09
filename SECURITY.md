# Security Policy

Drift treats repository files, `.drift` metadata, Git index content, snippets,
commit messages, and generated text as untrusted input.

## Supported Versions

| Version | Support |
| --- | --- |
| Latest minor | Security fixes |
| Older minors | Best-effort critical fixes |
| Unpublished development builds | Current `main` only |

## Reporting

Please report security vulnerabilities privately through GitHub Security Advisories for this repository.

Avoid opening public issues for exploitable vulnerabilities until a fix is available.


## Scope

In scope:

- bypasses of `.drift` contract or manifest integrity checks
- path traversal or unsafe contract path handling
- terminal escape/control sequence injection
- secret leakage through snippets, JSON, GitHub Markdown, or terminal output
- unsafe Git hook behavior or execution of non-local binaries
- denial-of-service inputs that make hooks or CI allocate excessive memory

Out of scope:

- false negatives from conservative detectors, unless they bypass a documented
  security guarantee
- vulnerabilities only present in unpublished local modifications

## Response Targets

We aim to acknowledge reports within 72 hours, provide an initial assessment
within 7 days, and publish fixes as soon as practical based on severity.

## Report Template

Please include affected version, platform, reproduction steps, expected
behavior, actual behavior, and whether the issue affects CI, hooks, or local CLI
usage.

## Trust Boundaries

- `.drift/config.json`, `.drift/manifest.json`, and contract files are validated
  and integrity-checked before trust decisions.
- Contract paths are forced under `.drift/contracts`.
- Git hooks run only the local `./node_modules/.bin/drift` binary and never
  fall back to `PATH`, `npx`, or network downloads.
- Terminal output strips control sequences and redacts common secret patterns.
- CI should run `drift ci --baseline-ref <trusted-ref>` so mutable PR metadata
  cannot lower protection thresholds.
