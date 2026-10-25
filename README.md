# Browser Automation

Record a browser task once, replay it with one click, or let it run on a schedule.

## Install (once)
1. Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick the `extension` folder
4. Pin it: puzzle icon in the toolbar → pin "Browser Automation"

## Use
1. Sign in to the site as usual, open the page where the task starts.
2. Extension icon → **● Record on this tab**. A red "● Recording" badge appears on the page.
3. Do the task once: pick options, tick boxes, type, click, download.
4. Extension icon → name it → **Stop & save**. The task page opens.
5. On the task page: fix values (e.g. a search term), add a wait, set a schedule, **Save & run now**.

Downloads land in `Downloads/Browser Automation/<task name>/`. You get a notification after every run.
A failed run keeps its tab open so you can see where it stopped.

## Limits
- Runs only while Chrome is open and the Mac is awake (a missed run happens once when Chrome starts again).
- You must stay signed in; passwords are never recorded.
- If the site changes its layout, re-record or fix the step.
