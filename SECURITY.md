# Security

## Reporting a problem
Please don't open a public issue for a security problem. Use GitHub's private
**Report a vulnerability** button (Security tab of this repository). You'll get an answer as soon
as possible, usually within a few days.

## Design
- No site access by default. Per-site access only after Chrome's own prompt; a run checks before
  every step that the page is still on one of that task's own sites.
- No network code. Extension pages run under `default-src 'self'; connect-src 'none'`; no remote
  scripts, no `eval`, no `innerHTML`. `npm test` enforces this on the source.
- Web pages can't talk to the extension (no `externally_connectable`). The recorder, running in a
  page, may only add steps to the recording of its own tab; every other action is accepted only
  from the extension's own pages.
- Never recorded: password fields (also after a "show password" toggle), one-time codes, card
  numbers, file inputs, and link addresses that carry a `?query`.
- Only `http(s)` addresses can be opened by a task (no `javascript:`, `file:`, `chrome:`).
- No third-party code inside the extension. The only dependency (Playwright) is for tests and is
  never shipped.
