// Service worker: owns recording state, saved tasks, the replay engine and the schedule.
import { nextRun } from './schedule.js';
import { playStep } from './player.js';
import { describeStep } from './steps.js';

const ALARM = 'task:';
const RUNS_KEPT = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only ordinary web pages. Never javascript:, file:, chrome: or data: URLs.
function webOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}
const pattern = (origin) => `${origin}/*`;
const allowed = (origin) => chrome.permissions.contains({ origins: [pattern(origin)] });

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
  const origin = webOrigin(tab.url || '');
  if (!origin) throw new Error('Open a normal web page (http or https) first.');
  if (!(await allowed(origin))) throw new Error(`Allow ${origin} first.`);
  await setRec({ tabId, startUrl: tab.url, title: tab.title || new URL(tab.url).hostname, steps: [], origins: [origin], blocked: false });
  await injectRecorder(tabId);
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: 'REC' });
}

// Fails on sites that aren't allowed yet; the popup then offers "Allow this site".
async function injectRecorder(tabId) {
  let blocked = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder.js'] });
  } catch {
    blocked = true;
  }
  await serial(async () => {
    const rec = await getRec();
    if (rec?.tabId === tabId && rec.blocked !== blocked) await setRec({ ...rec, blocked });
  });
}

function addRecordedStep(tabId, origin, step) {
  return serial(async () => {
    const rec = await getRec();
    if (!rec || rec.tabId !== tabId) return;
    if (!rec.origins.includes(origin)) rec.origins.push(origin);
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
      origins: rec.origins, // the only sites a run may touch
      schedule: { type: 'off' },
      timeoutSec: 30,
      pauseSec: 1,
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

// A new page in the recorded tab needs the recorder again.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const rec = await getRec();
  if (rec?.tabId === tabId) injectRecorder(tabId);
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
    const origins = taskOrigins(task);
    if (!webOrigin(task.startUrl)) throw new Error('The start page must be an http(s) address.');
    for (const o of origins) if (!(await allowed(o))) throw new Error(`Not allowed on ${o}. Open the task and click Allow.`);
    tabId = (await chrome.tabs.create({ url: task.startUrl, active: false })).id;
    await waitForLoad(tabId);
    const timeoutMs = (task.timeoutSec || 20) * 1000;
    const pauseMs = Math.min(60, Math.max(0, Number(task.pauseSec ?? 1))) * 1000; // calmer pace, gentler on slow sites
    for (const [i, step] of task.steps.entries()) {
      try {
        if (i > 0) await sleep(pauseMs);
        await doStep(tabId, step, timeoutMs, origins);
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

function taskOrigins(task) {
  const set = new Set(task.origins || []);
  set.add(webOrigin(task.startUrl));
  for (const s of task.steps) if (s.type === 'navigate') set.add(webOrigin(s.url));
  set.delete(null);
  return [...set];
}

async function doStep(tabId, step, timeoutMs, origins) {
  if (step.type === 'wait') return sleep(Math.min(3600, Number(step.seconds) || 1) * 1000);
  if (step.type === 'navigate') {
    if (!webOrigin(step.url)) throw new Error('only http(s) addresses are allowed');
    await chrome.tabs.update(tabId, { url: step.url });
    await sleep(300);
    return waitForLoad(tabId);
  }
  let res = null;
  // If the page navigates while the step runs, the script is lost; try again on the new page.
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    await waitForLoad(tabId);
    // Act only on this task's own sites, even if another task allowed more.
    // (Chrome hides the address of sites that aren't allowed at all, so those land here too.)
    const site = webOrigin((await chrome.tabs.get(tabId)).url || '');
    if (!site || !origins.includes(site)) {
      throw new Error(`the page moved to ${site || 'a site this task may not use'} (a sign-in page?)`);
    }
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: playStep, args: [step, timeoutMs] });
      res = r?.result || null;
    } catch (e) {
      // Chrome refuses to run on a site the user hasn't allowed (e.g. the run was redirected to another site).
      if (/cannot access|permission/i.test(e.message)) {
        throw new Error('the page moved to a site this task may not use (a sign-in page?)');
      }
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
  const folder = current.taskName.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60) || 'task';
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
  if ('startUrl' in edit && !webOrigin(edit.startUrl)) throw new Error('The start page must be an http(s) address.');
  if (edit.steps?.some((s) => s.type === 'navigate' && !webOrigin(s.url))) throw new Error('"Go to" steps need an http(s) address.');
  await serial(async () => {
    const tasks = await getTasks();
    const t = tasks[edit.id];
    if (!t) throw new Error('Task not found.');
    for (const k of ['name', 'startUrl', 'steps', 'schedule', 'timeoutSec', 'pauseSec', 'closeTab']) if (k in edit) t[k] = edit[k];
    t.origins = taskOrigins(t);
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

// Messages come from two places: our own pages (popup, editor) and the recorder in a web page.
// Web-page senders may only add steps to the recording of their own tab, nothing else.
const fromOwnPage = (sender) => sender.url?.startsWith(chrome.runtime.getURL(''));
const RECORDED_TYPES = ['click', 'input', 'select', 'check', 'key'];

async function handle(msg, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('unknown sender');
  if (msg.type === 'rec-step') {
    const origin = webOrigin(sender.url || '');
    if (sender.tab && sender.frameId === 0 && origin && RECORDED_TYPES.includes(msg.step?.type)) {
      await addRecordedStep(sender.tab.id, origin, msg.step);
    }
    return {};
  }
  if (!fromOwnPage(sender)) throw new Error('not allowed');
  switch (msg.type) {
    case 'rec-reinject': {
      const rec = await getRec();
      if (rec) await injectRecorder(rec.tabId);
      return {};
    }
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
globalThis.ba = { startRecording, stopRecording, runTask, getTasks, scheduleTask, saveTask };
