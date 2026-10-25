# Privacy

**Browser Automation collects nothing and sends nothing.** There is no server, no analytics, no
crash reporting and no account.

## What is stored, and where
Everything stays in Chrome's extension storage on your computer (`chrome.storage`):
- your tasks: name, start page address, the steps (what to click, which option to choose, text you typed into ordinary fields), the schedule;
- the last 20 runs of each task: time, result, error message, names of downloaded files.

Not stored, ever: passwords, one-time codes, card numbers, file uploads, page contents, cookies,
browsing history.

Note: the **start page address** is saved as you recorded it. If that address itself contains
something private (some sites put tokens in the address), edit it on the task page.

Removing the extension deletes all of this. Deleting a task deletes that task.

## Network
The extension's own pages and background worker are blocked from making network requests by their
Content Security Policy (`connect-src 'none'`), and the test suite fails if network code is ever
added. The only traffic is what the websites you automate do anyway, as if you clicked yourself.

## Site access
The extension can't read or change any website until you allow that site, and only those sites.
You can withdraw access any time on the task page ("Remove access") or in `chrome://extensions`.
