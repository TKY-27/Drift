# Contributing

Thanks for helping improve Drift. Keep changes focused, reviewable, and aligned
with the existing TypeScript CLI architecture.

## Development Setup

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## Pull Request Checklist

- Keep generated, local, and secret files out of commits.
- Add or update tests for behavior changes.
- Run typecheck, lint, tests, and build before requesting review.
- Do not include API keys, credentials, private URLs, or local machine paths in
  fixtures, documentation, screenshots, or logs.
- For security-sensitive changes, explain the trust boundary and failure mode in
  the pull request.

## Security Reports

Do not open public issues for exploitable vulnerabilities. Follow
[SECURITY.md](SECURITY.md) for private reporting guidance.

