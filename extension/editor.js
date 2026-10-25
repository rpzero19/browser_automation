import { describeStep, ago } from './steps.js';
import { describeSchedule, nextRun, DAY_NAMES } from './schedule.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const id = new URLSearchParams(location.search).get('id');
let task = null;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

async function load() {
  const { tasks = {} } = await chrome.storage.local.get('tasks');
  return tasks[id] || null;
}

function fillForm() {
  document.title = `${task.name} · Browser Automation`;
  $('title').textContent = task.name;
  $('name').value = task.name;
  $('startUrl').value = task.startUrl;
  $('timeoutSec').value = task.timeoutSec;
  $('closeTab').checked = task.closeTab;
  const s = task.schedule || { type: 'off' };
  $('schedType').value = s.type;
  $('time').value = s.time || '09:00';
  $('every').value = s.every || 6;
  $('daysWrap').replaceChildren(
    ...DAY_NAMES.map((d, i) =>
      el('label', {}, el('input', { type: 'checkbox', value: i, checked: (s.days || [1, 2, 3, 4, 5]).includes(i), onchange: showSchedule }), ` ${d}`),
    ),
  );
  showSchedule();
  renderSites();
  renderSteps();
  renderRuns();
}

function readSchedule() {
  const type = $('schedType').value;
  if (type === 'off') return { type };
  if (type === 'hours') return { type, every: Math.max(1, Number($('every').value) || 1) };
  const s = { type, time: $('time').value || '09:00' };
  if (type === 'weekly') s.days = [...$('daysWrap').querySelectorAll('input:checked')].map((i) => Number(i.value));
  return s;
}

function showSchedule() {
  const s = readSchedule();
  $('timeWrap').hidden = !['daily', 'weekly'].includes(s.type);
  $('hoursWrap').hidden = s.type !== 'hours';
  $('daysWrap').hidden = s.type !== 'weekly';
  const next = nextRun(s);
  $('nextRun').textContent = s.type === 'off' ? '' : next ? `${describeSchedule(s)}. Next run after saving: ${new Date(next).toLocaleString()}` : 'Pick at least one day.';
}

function renderSteps() {
  $('steps').replaceChildren(
    ...task.steps.map((step, i) => {
      const parts = [];
      const what = step.target?.label ? `"${step.target.label}"` : '';
      // values you might want to change between runs (dates, search text) are editable here
      if (step.type === 'input' || step.type === 'select') {
        const key = step.type === 'input' ? 'value' : 'optionText';
        const input = el('input', { value: step[key] ?? step.value ?? '' });
        input.oninput = () => {
          step[key] = input.value;
          if (step.type === 'select') step.value = input.value; // player falls back to matching the option text
        };
        parts.push(step.type === 'input' ? `Type into ${what}: ` : `Choose in ${what}: `, input);
      } else if (step.type === 'wait') {
        const input = el('input', { type: 'number', min: 1, value: step.seconds, className: 'num' });
        input.oninput = () => (step.seconds = Number(input.value) || 1);
        parts.push('Wait ', input, ' s');
      } else {
        parts.push(describeStep(step));
      }
      const btn = (text, title, fn) => el('button', { className: 'small', textContent: text, title, onclick: fn });
      return el(
        'li',
        {},
        el(
          'div',
          { className: 'row' },
          el('span', { className: 'desc' }, ...parts),
          btn('↑', 'Move up', () => move(i, -1)),
          btn('↓', 'Move down', () => move(i, 1)),
          btn('✕', 'Remove step', () => {
            task.steps.splice(i, 1);
            renderSteps();
          }),
        ),
      );
    }),
  );
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= task.steps.length) return;
  [task.steps[i], task.steps[j]] = [task.steps[j], task.steps[i]];
  renderSteps();
}

function siteOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

function taskSites() {
  return [...new Set([siteOf(task.startUrl), ...(task.origins || [])])].filter(Boolean);
}

async function renderSites() {
  const rows = await Promise.all(
    taskSites().map(async (origin) => {
      const origins = [`${origin}/*`];
      const ok = await chrome.permissions.contains({ origins });
      const btn = el('button', { className: 'small', textContent: ok ? 'Remove access' : 'Allow' });
      btn.onclick = async () => {
        if (ok) await chrome.permissions.remove({ origins });
        else await chrome.permissions.request({ origins });
        renderSites();
      };
      return el('li', { className: 'row' },
        el('span', { className: 'spacer', textContent: origin }),
        el('span', { className: ok ? 'ok' : 'fail', textContent: ok ? 'Allowed' : 'Not allowed' }), btn);
    }),
  );
  $('sites').replaceChildren(...rows);
}

function renderRuns() {
  const runs = task.runs || [];
  $('runs').replaceChildren(
    ...(runs.length ? runs : [null]).map((r) => {
      if (!r) return el('li', { className: 'hint', textContent: 'Not run yet.' });
      const head = el('div', {},
        el('span', { className: r.ok ? 'ok' : 'fail', textContent: r.ok ? '✓ Done' : '✗ Failed' }),
        ` · ${new Date(r.at).toLocaleString()} (${ago(r.at)}) · ${r.reason} · ${Math.round(r.ms / 1000)} s`);
      const li = el('li', {}, head);
      if (r.error) li.append(el('div', { className: 'hint error', textContent: r.error }));
      if (r.downloads?.length) li.append(el('div', { className: 'hint', textContent: `Files: ${r.downloads.map((d) => d.file).join(', ')}` }));
      return li;
    }),
  );
}

async function save() {
  const startUrl = $('startUrl').value.trim();
  const site = siteOf(startUrl);
  if (!site) {
    $('saved').textContent = 'The start page must be an http(s) address.';
    return false;
  }
  // a new start site needs Chrome's permission prompt (this click counts as the user's go-ahead)
  if (!(await chrome.permissions.request({ origins: [`${site}/*`] }))) {
    $('saved').textContent = `Not saved: ${site} was not allowed.`;
    return false;
  }
  task.name = $('name').value.trim() || task.name;
  task.startUrl = startUrl;
  task.timeoutSec = Math.min(600, Math.max(5, Number($('timeoutSec').value) || 20));
  task.closeTab = $('closeTab').checked;
  task.schedule = readSchedule();
  const { name, steps, schedule, timeoutSec, closeTab } = task;
  const res = await send({ type: 'save-task', task: { id, name, startUrl, steps, schedule, timeoutSec, closeTab } });
  $('saved').textContent = res.error ? res.error : `Saved ${new Date().toLocaleTimeString()}`;
  $('title').textContent = task.name;
  renderSites();
  return !res.error;
}

$('schedType').onchange = showSchedule;
$('time').oninput = showSchedule;
$('every').oninput = showSchedule;
$('addWait').onclick = () => {
  task.steps.push({ type: 'wait', seconds: 3 });
  renderSteps();
};
$('save').onclick = save;
$('run').onclick = async () => {
  if (!(await save())) return;
  await send({ type: 'run', id });
  $('saved').textContent = 'Running in a background tab…';
};
$('delete').onclick = async () => {
  if (!confirm(`Delete "${task.name}"?`)) return;
  await send({ type: 'delete-task', id });
  window.close();
};

// New runs show up live without touching unsaved edits in the form.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.tasks || !task) return;
  const fresh = changes.tasks.newValue?.[id];
  if (!fresh) return;
  task.runs = fresh.runs;
  task.origins = fresh.origins;
  renderRuns();
});

task = await load();
if (task) fillForm();
else {
  $('form').hidden = true;
  $('missing').hidden = false;
}
