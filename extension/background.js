// Service worker: owns recording state, saved tasks, the replay engine and the schedule.
import { nextRun } from './schedule.js';
import { playStep } from './player.js';
import { describeStep } from './steps.js';

const ALARM = 'task:';
const RUNS_KEPT = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- storage ----------
// Tasks live in storage.local. The recording in progress lives in storage.session, so it
// survives the service worker being stopped but not a browser restart.
// Every read-modify-write goes through serial() so two messages can't overwrite each other.

let lock = Promise.resolve();
function serial(fn) {
  const p = lock.then(fn);
  lock = p.catch(() => {});
  return p;
}

async function getTasks() {
  return (await chrome.storage.local.get('tasks')).tasks || {};
}
async function getTask(id) {
  return (await getTasks())[id];
}
function updateTask(id, fn) {
  return serial(async () => {
    const tasks = await getTasks();
    if (!tasks[id]) return null;
    fn(tasks[id]);
    await chrome.storage.local.set({ tasks });
    return tasks[id];
  });
}
async function getRec() {
  return (await chrome.storage.session.get('rec')).rec || null;
}
const setRec = (rec) => (rec ? chrome.storage.session.set({ rec }) : chrome.storage.session.remove('rec'));

// ---------- recording ----------

async function startRecording(tabId) {
  if (await getRec()) throw new Error('Already recording. Save or cancel that first.');
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || '')) throw new Error('Open a normal web page (http or https) first.');
  await setRec({ tabId, startUrl: tab.url, title: tab.title || new URL(tab.url).hostname, steps: [] });
  await injectRecorder(tabId);
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: 'REC' });
}

async function injectRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder.js'] });
  } catch (e) {
    console.warn('recorder not injected:', e.message);
  }
}

function addRecordedStep(tabId, step) {
  return serial(async () => {
    const rec = await getRec();
    if (!rec || rec.tabId !== tabId) return;
    const last = rec.steps[rec.steps.length - 1];
    // typing into the same field twice in a row keeps only the final value
    if (step.type === 'input' && last?.type === 'input' && JSON.stringify(last.target) === JSON.stringify(step.target)) {
      rec.steps[rec.steps.length - 1] = step;
    } else {
      rec.steps.push(step);
    }
    await setRec(rec);
  });
}

async function endRecording() {
  const rec = await getRec();
  await setRec(null);
  await chrome.action.setBadgeText({ text: '' });
  if (rec) {
    chrome.scripting
      .executeScript({ target: { tabId: rec.tabId }, func: () => window.__baRec?.off() })
      .catch(() => {});
  }
  return rec;
}

function stopRecording(name) {
  return serial(async () => {
    const rec = await endRecording();
    if (!rec) throw new Error('Not recording.');
    const task = {
      id: crypto.randomUUID(),
      name: (name || '').trim() || rec.title,
      startUrl: rec.startUrl,
      steps: rec.steps,
      schedule: { type: 'off' },
      timeoutSec: 20,
      closeTab: true,
      runs: [],
      createdAt: Date.now(),
    };
    const tasks = await getTasks();
    tasks[task.id] = task;
    await chrome.storage.local.set({ tasks });
    return task;
  });
}

// Typing an address during a recording becomes a "Go to" step.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const rec = await getRec();
  if (!rec || rec.tabId !== d.tabId || !/^https?:/.test(d.url)) return;
  const typed = ['typed', 'auto_bookmark', 'generated', 'keyword'].includes(d.transitionType) ||
    (d.transitionQualifiers || []).includes('from_address_bar');
  if (typed) addRecordedStep(d.tabId, { type: 'navigate', url: d.url });
});

// A new page in the recorded tab needs the recorder again.
chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const rec = await getRec();
  if (rec?.tabId === d.tabId) injectRecorder(d.tabId);
});

// ---------- replay ----------

let current = null; // { taskId, taskName, downloads: [ids] }
const queue = [];

async function runTask(id, reason = 'manual') {
  if (current) {
    if (current.taskId !== id && !queue.includes(id)) queue.push(id);
    return null;
  }
  current = { taskId: id, taskName: '', downloads: [] };
  try {
    const task = await getTask(id);
    if (!task) return null;
    current.taskName = task.name;
    return await execute(task, reason);
  } finally {
    current = null;
    const next = queue.shift();
    if (next) runTask(next, 'queued');
  }
}

async function execute(task, reason) {
  const run = { at: Date.now(), reason, ok: false, error: '', downloads: [] };
  // Chrome stops an idle service worker after ~30 s; an API call every 20 s keeps it alive during a run.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  let tabId = null;
  try {
    tabId = (await chrome.tabs.create({ url: task.startUrl, active: false })).id;
    await waitForLoad(tabId);
    const timeoutMs = (task.timeoutSec || 20) * 1000;
    for (const [i, step] of task.steps.entries()) {
      try {
        await doStep(tabId, step, timeoutMs);
      } catch (e) {
        throw new Error(`Step ${i + 1} (${describeStep(step)}): ${e.message}`);
      }
    }
    run.downloads = await waitForDownloads(current.downloads);
    const failed = run.downloads.find((d) => d.state !== 'complete');
    if (failed) throw new Error(`Download ${failed.file || ''} failed (${failed.error || failed.state})`);
    run.ok = true;
  } catch (e) {
    run.error = e.message;
  } finally {
    clearInterval(keepAlive);
  }
  run.ms = Date.now() - run.at;
  await updateTask(task.id, (t) => {
    t.runs = [run, ...(t.runs || [])].slice(0, RUNS_KEPT);
  });
  // On failure the tab stays open so you can see where it stopped.
  if (run.ok && task.closeTab && tabId) chrome.tabs.remove(tabId).catch(() => {});
  notify(task, run);
  return run;
}

async function doStep(tabId, step, timeoutMs) {
  if (step.type === 'wait') return sleep((Number(step.seconds) || 1) * 1000);
  if (step.type === 'navigate') {
    await chrome.tabs.update(tabId, { url: step.url });
    await sleep(300);
    return waitForLoad(tabId);
  }
  let res = null;
  // If the page navigates while the step runs, the script is lost; try again on the new page.
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    await waitForLoad(tabId);
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: playStep, args: [step, timeoutMs] });
      res = r?.result || null;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    if (!res) await sleep(500);
  }
  if (!res?.ok) throw new Error(res?.error || 'the page did not respond');
  await sleep(500); // let a click start its page load before checking
  await waitForLoad(tabId);
}

async function waitForLoad(tabId, timeoutMs = 45e3) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    await sleep(250);
  }
}

async function waitForDownloads(ids, timeoutMs = 10 * 60e3) {
  await sleep(2000); // a download often starts a moment after the last click
  const end = Date.now() + timeoutMs;
  let items = [];
  while (Date.now() < end) {
    items = (await Promise.all(ids.map((id) => chrome.downloads.search({ id })))).flat();
    if (!items.some((d) => d.state === 'in_progress')) break;
    await sleep(1000);
  }
  return items.map((d) => ({ file: d.filename.split(/[\\/]/).pop(), path: d.filename, state: d.state, error: d.error || '' }));
}

chrome.downloads.onCreated.addListener((item) => {
  if (current) current.downloads.push(item.id);
});

// Files downloaded by a run go to Downloads/Browser Automation/<task name>/
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!current?.taskName) return suggest();
  const folder = current.taskName.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'task';
  suggest({ filename: `Browser Automation/${folder}/${item.filename}`, conflictAction: 'uniquify' });
});

function notify(task, run) {
  const files = run.downloads.map((d) => d.file).join(', ');
  chrome.notifications.create(`${task.id}|${run.at}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${run.ok ? 'Done' : 'Failed'}: ${task.name}`,
    message: run.ok ? (files ? `Downloaded ${files}` : `Finished in ${Math.round(run.ms / 1000)} s`) : run.error,
  });
}

chrome.notifications.onClicked.addListener((nid) => {
  chrome.tabs.create({ url: `editor.html?id=${nid.split('|')[0]}` });
});

// ---------- schedule ----------

async function scheduleTask(id) {
  await chrome.alarms.clear(ALARM + id);
  const task = await updateTask(id, (t) => {
    t.nextRunAt = nextRun(t.schedule);
  });
  if (task?.nextRunAt) await chrome.alarms.create(ALARM + id, { when: task.nextRunAt });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM)) return;
  const id = alarm.name.slice(ALARM.length);
  if (!(await getTask(id))) return;
  await scheduleTask(id);
  runTask(id, 'schedule');
});

// When Chrome starts: set every alarm again, and run once anything that was missed while it was closed.
async function resync() {
  const now = Date.now();
  for (const t of Object.values(await getTasks())) {
    const missed = t.nextRunAt && t.nextRunAt < now - 60e3;
    await scheduleTask(t.id);
    if (missed) runTask(t.id, 'missed');
  }
}
chrome.runtime.onStartup.addListener(resync);
chrome.runtime.onInstalled.addListener(resync);

// ---------- messages from the popup, editor and recorder ----------

async function saveTask(edit) {
  await serial(async () => {
    const tasks = await getTasks();
    const t = tasks[edit.id];
    if (!t) throw new Error('Task not found.');
    for (const k of ['name', 'startUrl', 'steps', 'schedule', 'timeoutSec', 'closeTab']) if (k in edit) t[k] = edit[k];
    await chrome.storage.local.set({ tasks });
  });
  await scheduleTask(edit.id);
}

function deleteTask(id) {
  return serial(async () => {
    await chrome.alarms.clear(ALARM + id);
    const tasks = await getTasks();
    delete tasks[id];
    await chrome.storage.local.set({ tasks });
  });
}

async function handle(msg, sender) {
  switch (msg.type) {
    case 'rec-step':
      if (sender.tab) await addRecordedStep(sender.tab.id, msg.step);
      return {};
    case 'rec-start':
      await startRecording(msg.tabId);
      return {};
    case 'rec-stop':
      return { task: await stopRecording(msg.name) };
    case 'rec-cancel':
      await serial(endRecording);
      return {};
    case 'status':
      return { rec: await getRec(), running: current?.taskId || null, queue };
    case 'run':
      runTask(msg.id, 'manual');
      return {};
    case 'save-task':
      await saveTask(msg.task);
      return {};
    case 'delete-task':
      await deleteTask(msg.id);
      return {};
  }
  throw new Error(`unknown message ${msg.type}`);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: e.message }));
  return true;
});

// For the end-to-end test (test/e2e.mjs) and debugging from the service worker console.
globalThis.ba = { startRecording, stopRecording, runTask, getTasks, scheduleTask };
