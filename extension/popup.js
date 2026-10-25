import { describeStep, ago } from './steps.js';
import { describeSchedule } from './schedule.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let nameFilled = false;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

async function refresh() {
  const { rec, running } = await send({ type: 'status' });
  $('rec-idle').hidden = !!rec;
  $('rec-on').hidden = !rec;
  if (rec) {
    $('rec-count').textContent = rec.steps.length;
    $('rec-steps').start = Math.max(1, rec.steps.length - 4);
    $('rec-steps').replaceChildren(...rec.steps.slice(-5).map((s) => el('li', { textContent: describeStep(s) })));
    if (!nameFilled) {
      $('rec-name').value = rec.title;
      nameFilled = true;
    }
  }

  const { tasks = {} } = await chrome.storage.local.get('tasks');
  const list = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt);
  $('empty').hidden = list.length > 0;
  $('tasks').replaceChildren(
    ...list.map((t) => {
      const last = t.runs?.[0];
      const meta = el('div', { className: 'meta' }, `${t.steps.length} steps · ${describeSchedule(t.schedule)}`);
      if (last) {
        meta.append(' · ', el('span', { className: last.ok ? 'ok' : 'fail', textContent: `${last.ok ? '✓' : '✗'} ${ago(last.at)}` }));
      }
      const isRunning = running === t.id;
      const run = el('button', { className: 'small', textContent: isRunning ? 'Running…' : 'Run', disabled: isRunning });
      run.onclick = async () => {
        run.disabled = true;
        run.textContent = 'Running…';
        await send({ type: 'run', id: t.id });
      };
      const edit = el('button', { className: 'small', textContent: 'Edit' });
      edit.onclick = () => chrome.tabs.create({ url: `editor.html?id=${t.id}` });
      return el('li', {}, el('div', { className: 'info' }, el('div', { className: 'name', textContent: t.name }), meta), run, edit);
    }),
  );
}

$('rec-start').onclick = async () => {
  $('rec-error').textContent = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await send({ type: 'rec-start', tabId: tab.id });
  if (res.error) $('rec-error').textContent = res.error;
  else window.close(); // get out of the way so the page can be used
};

$('rec-save').onclick = async () => {
  const res = await send({ type: 'rec-stop', name: $('rec-name').value });
  if (res.error) return ($('rec-save-error').textContent = res.error);
  chrome.tabs.create({ url: `editor.html?id=${res.task.id}` });
};

$('rec-cancel').onclick = async () => {
  await send({ type: 'rec-cancel' });
  nameFilled = false;
  refresh();
};

refresh();
setInterval(refresh, 1000);
