# browser_automation

Read `../CLAUDE.md` first (owner, rules). This file is about this project only.

## What
A Chrome extension (Manifest V3, plain JS, no build step) that records browser steps once,
replays them in a background tab, and runs them on a schedule (e.g. "every Monday 09:00, open
the report page, pick last month, download the CSV"). Private use first; a public release would
need a security review (see `../docs/ideas.md`).

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
  e2e.mjs           loads the extension in Playwright Chromium, records + replays on test/site (npm run e2e)
```

## Run / test
- Install in Chrome: `chrome://extensions` → Developer mode → Load unpacked → `extension/`. After code changes press the reload icon on the extension card.
- `npm test` (schedule), `npm run e2e` (needs `npm install` + `npx playwright install chromium` once).
- Service worker console: chrome://extensions → Browser Automation → "service worker". `ba.runTask(id)` etc. are exposed there.

## How it works (things that are easy to break)
- Tasks: `chrome.storage.local.tasks` keyed by id. Recording in progress: `chrome.storage.session.rec`. All read-modify-write goes through `serial()` in background.js.
- Element finding order (player.js): unique selectors recorded at the time (id, data-testid, name, aria-label, href…) → same tag + same visible text → CSS position path. Generated-looking ids (`ember123`, `:r5:`, hex) are never used.
- Password and file fields are never recorded. Runs rely on the user already being signed in in Chrome.
- Downloads during a run go to `Downloads/Browser Automation/<task name>/` (onDeterminingFilename). Playwright overrides downloads, so that folder is only checkable in real Chrome.
- Scheduling: one `chrome.alarms` alarm per task (`task:<id>`). On Chrome start, alarms are rebuilt and a missed run happens once. Nothing runs while Chrome is closed or the Mac sleeps.
- A failed run leaves its tab open and shows a notification; clicking it opens the task page.

## Known limits / next ideas
- Top frame only (no iframes, no shadow DOM). Links that open a new tab aren't followed.
- No monthly schedule yet ("1st of the month").
- Optional later: AI fallback when a step can't find its element.

## Deploy
None. Local unpacked extension. GitHub repo only after the owner agrees (private).
