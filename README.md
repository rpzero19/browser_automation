# Browser Automation

A Chrome extension that records a browser task once, then replays it with one click or on a
schedule. Example: every Monday at 09:00, open a report page, pick "Last month", tick a box,
wait for the report and download the file.

- **Works only on sites you allow.** Out of the box it can't read or touch any website. Chrome asks you, per site, the first time.
- **Sends nothing anywhere.** No servers, no analytics, no accounts. The extension's own pages are blocked from making network requests at all (see [PRIVACY.md](PRIVACY.md)).
- **Never records passwords**, one-time codes or card numbers.
- Plain JavaScript, no build step, no third-party code inside the extension. Every line is in `extension/`.

Built with AI coding agents (Claude Code) and tested with the automated tests in `test/`.

## Install
Not on the Chrome Web Store yet. To install from this source:
1. Download this repository (Code → Download ZIP) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder.
4. Pin it: click the puzzle icon in Chrome's toolbar, then the pin next to "Browser Automation".

## Use
1. Sign in to the site as usual and open the page where your task starts.
2. Click the extension's icon, then **● Record on this tab**. Chrome asks to allow the site. A red "● Recording" badge appears on the page.
3. Do the task once: choose options, tick boxes, type, click, download.
4. Click the icon again, name the task, **Stop & save**. The task page opens.
5. On the task page you can change typed values, remove or reorder steps, add a wait, set a schedule, and **Save & run now**.

Runs happen in a background tab. Files go to `Downloads/Browser Automation/<task name>/`.
You get a notification after each run. A failed run keeps its tab open so you can see where it stopped.

Each run pauses 1 s between steps (change it per task). Untick "Close the tab after a
successful run" to watch a run happen.

If a step waits for something slow (a report that takes a while to prepare), raise
"Wait for each element up to … s" on the task page, or add a wait step.

## What it asks Chrome for, and why

| Permission | Why |
|---|---|
| Access to a site (asked per site, optional) | To record and replay on that site. Remove it any time on the task page or in `chrome://extensions`. |
| `activeTab` | To see which page you are on when you press Record. |
| `scripting` | To run the recorder and the replay steps in pages of allowed sites. |
| `storage` | To keep your tasks on this computer. |
| `alarms` | To run tasks on schedule. |
| `downloads` | To put a run's files in their own folder and confirm they finished. |
| `notifications` | To tell you a run finished or failed. |

## Limits
- Runs only while Chrome is open and the computer is awake. A run missed while it was closed or asleep happens once when Chrome starts again.
- You must already be signed in to the site. The extension never types passwords. If a run lands on a sign-in page, it stops and tells you.
- Pages inside frames, links that open a new tab, and typing an address during a recording aren't supported yet.
- If a site changes its layout, re-record the task or fix the step.

## Development
```
npm install && npx playwright install chromium   # once
npm test        # unit + source checks (no network calls, no inline scripts, manifest permissions)
npm run e2e     # records and replays on a local test site in a real Chromium
```

## License
MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
