# browser_automation

Read `../CLAUDE.md` first (owner, rules). This file is about this project only.

**This repo is meant to be PUBLIC.** Never commit: real site addresses the owner automates
(work portal etc.), exported tasks, screenshots of real pages, anything about the server/AWS,
names or emails. Test only against `test/site/`. Keep `npm test` green: it enforces no network
code, no inline scripts and the exact permission list.

## What
A Chrome extension (Manifest V3, plain JS, no build step) that records browser steps once,
replays them in a background tab, and runs them on a schedule (e.g. "every Monday 09:00, open
the report page, pick last month, download the CSV"). Open source so people can check it
(see `../docs/ideas.md`). Security model: `SECURITY.md`, data: `PRIVACY.md`.

## Layout
```
extension/          the extension (load this folder unpacked)
  manifest.json
  background.js     service worker: recording state, tasks, replay engine, alarms, downloads
  recorder.js       injected into the recorded tab; turns clicks/typing/choices into steps
  player.js         playStep(): injected per step during replay; finds the element and acts
  steps.js          step shapes + describeStep(), ago()
  schedule.js       nextRun() / describeSchedule() (pure, unit-tested)
  popup.*           record / save / list / run
  editor.*          per-task page: steps, editable values, schedule, run history
test/
  schedule.test.mjs unit tests (npm test)
  static.test.mjs   source checks: parses, no network/eval/innerHTML, manifest permissions, CSP
  e2e.mjs           loads the extension in Playwright Chromium, records + replays on test/site (npm run e2e)
```

## Run / test
- Install in Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/`. After code changes press the reload icon on the extension card.
- `npm test` (schedule + static source checks), `npm run e2e` (needs `npm install` + `npx playwright install chromium` once).
- Service worker console: chrome://extensions → Browser Automation → "service worker". `ba.runTask(id)` etc. are exposed there.

## How it works (things that are easy to break)
- Tasks: `chrome.storage.local.tasks` keyed by id. Recording in progress: `chrome.storage.session.rec`. All read-modify-write goes through `serial()` in background.js.
- Element finding order (player.js): unique selectors recorded at the time (id, data-testid, name, aria-label, href…) → same tag + same visible text → CSS position path. Generated-looking ids (`ember123`, `:r5:`, hex) are never used.
- Site access: no host permissions at install; `optional_host_permissions` requested per site (popup Record button, task page Allow/Save). A run refuses to start unless all `task.origins` are allowed, and before every step checks the tab is still on one of `task.origins`.
- Messages: `rec-step` only from a content script in the recorded tab (top frame); everything else only from extension pages (`sender.url` is ours).
- Never recorded: password fields (incl. after show-password), one-time codes, card fields, files, `?query` link addresses. Runs rely on the user already being signed in in Chrome.
- e2e uses a temp copy of the extension with `host_permissions: ['http://127.0.0.1/*']` because Playwright can't click Chrome's permission prompt.
- Downloads during a run go to `Downloads/Browser Automation/<task name>/` (onDeterminingFilename). Playwright overrides downloads, so that folder is only checkable in real Chrome.
- Scheduling: one `chrome.alarms` alarm per task (`task:<id>`). On Chrome start, alarms are rebuilt and a missed run happens once. Nothing runs while Chrome is closed or the Mac sleeps.
- A failed run leaves its tab open and shows a notification; clicking it opens the task page.

## Known limits / next ideas
- Top frame only (no iframes, no shadow DOM). Links that open a new tab aren't followed. Typed addresses during a recording aren't recorded (needs webNavigation, deliberately not requested).
- Downloads started in other tabs during a run get counted in that run.
- Login with Chrome's saved passwords can't be automated safely: Chrome only releases autofilled passwords to a page after a real user gesture. Don't add password storage or the `debugger` permission.
- No monthly schedule yet ("1st of the month").
- Optional later: AI fallback when a step can't find its element.

## Deploy
None yet: users load it unpacked. Repo: public `rpzero19/browser_automation` (once the owner confirms). Chrome Web Store later (needs a $5 developer account, the owner's call).
