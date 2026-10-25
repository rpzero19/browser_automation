// End-to-end: load the extension in Chromium, record a task on the local test site
// (fill a form, open the report, download the CSV), then replay it by hand and by alarm.
// Run: npm run e2e
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
// A test copy of the extension that is pre-allowed on 127.0.0.1 only: Playwright can't click
// Chrome's "allow on this site" prompt. localhost stays NOT allowed, to test the refusal.
const extDir = await mkdtemp(path.join(tmpdir(), 'ba-ext-'));
await cp(path.join(root, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));
const csvRequests = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/redirect') {
    return res.writeHead(302, { location: `http://localhost:${server.address().port}/index.html` }).end();
  }
  if (url.pathname === '/report.csv') {
    csvRequests.push(Object.fromEntries(url.searchParams));
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
    return res.end('a,b\n1,2\n');
  }
  try {
    const body = await readFile(path.join(root, 'test/site', path.basename(url.pathname) || 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(path.join(tmpdir(), 'ba-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const ok = (msg) => console.log(`  ✓ ${msg}`);

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  sw.on('console', (m) => console.log('  [sw]', m.text()));

  // ---- record ----
  const page = await ctx.newPage();
  await page.goto(`${base}/index.html`);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/index.html`);
  await sw.evaluate((id) => ba.startRecording(id), tabId);
  await page.waitForSelector('text=● Recording');

  await page.getByLabel('Email').fill('me@example.com');
  await page.keyboard.press('Tab');
  await page.getByLabel('Period').selectOption({ label: 'Last month' });
  await page.getByLabel('Include archived').check();
  await page.getByLabel('Password').fill('hunter2-secret');
  await page.getByLabel('One-time code').fill('424242');
  await page.getByRole('button', { name: 'Show report' }).click();
  await page.waitForURL(/report\.html/);
  await page.waitForSelector('text=● Recording'); // recorder injected again on the new page
  const dl = page.waitForEvent('download');
  await page.getByText('Download CSV').click();
  await dl;
  await page.waitForTimeout(300);

  const task = await sw.evaluate(() => ba.stopRecording('Test report'));
  const { describeStep } = await import('../extension/steps.js');
  console.log('  recorded:\n' + task.steps.map((s, i) => `    ${i + 1}. ${describeStep(s)}`).join('\n'));
  assert.deepEqual(task.steps.map((s) => s.type), ['input', 'select', 'check', 'click', 'click']);
  assert.equal(task.steps[1].target.label, 'Period');
  assert.ok(!JSON.stringify(task).match(/hunter2|424242/), 'secrets must never be recorded');
  assert.deepEqual(task.origins, [base]);
  assert.ok(!task.steps[3].target.css.some((c) => c.includes('btn-8f3a')), 'generated id must not be used');
  ok('recording captured 5 steps, no generated ids, no password or one-time code');
  await page.close();

  // ---- replay manually ----
  csvRequests.length = 0;
  const run = await sw.evaluate((id) => ba.runTask(id, 'test'), task.id);
  console.log('  run:', JSON.stringify(run));
  assert.ok(run.ok, run.error);
  assert.equal(csvRequests.length, 1);
  assert.equal(csvRequests[0].email, 'me@example.com');
  assert.equal(csvRequests[0].period, 'last-month');
  assert.equal(csvRequests[0].archived, 'on');
  assert.equal(run.downloads.length, 1);
  assert.equal(run.downloads[0].state, 'complete');
  // Playwright takes over downloads in its browser, so the "Browser Automation/<task>/" folder is checked in real Chrome.
  ok('replay filled the form with the recorded values and downloaded the CSV');

  // ---- replay by alarm (what the scheduler fires) ----
  await sw.evaluate((id) => chrome.alarms.create('task:' + id, { when: Date.now() + 500 }), task.id);
  const deadline = Date.now() + 60e3;
  let runs = [];
  while (Date.now() < deadline) {
    runs = await sw.evaluate(async (id) => (await ba.getTasks())[id].runs, task.id);
    if (runs.length >= 2) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(runs.length, 2, 'scheduled run did not happen');
  assert.ok(runs[0].ok && runs[0].reason === 'schedule', runs[0].error);
  ok('alarm triggered a scheduled run that succeeded');

  // ---- a broken step fails with a clear message ----
  await sw.evaluate(async (id) => {
    const tasks = await ba.getTasks();
    const t = tasks[id];
    t.timeoutSec = 2;
    t.steps[3] = { type: 'click', target: { css: ['#nope'], text: 'No such button', tag: 'button', label: 'No such button' } };
    await chrome.storage.local.set({ tasks });
  }, task.id);
  const bad = await sw.evaluate((id) => ba.runTask(id, 'test'), task.id);
  assert.ok(!bad.ok);
  assert.match(bad.error, /^Step 4 \(Click "No such button"\): could not find/);
  ok(`broken step reported: ${bad.error}`);

  // ---- a run that lands on another site stops there ----
  const moved = await sw.evaluate(async ([id, base]) => {
    const tasks = await ba.getTasks();
    tasks[id].timeoutSec = 20;
    tasks[id].startUrl = `${base}/redirect`; // 302 to localhost, which is not one of this task's sites
    await chrome.storage.local.set({ tasks });
    return ba.runTask(id, 'test');
  }, [task.id, base]);
  assert.ok(!moved.ok);
  assert.match(moved.error, /^Step 1 .*: the page moved to/);
  ok(`redirect to another site stopped: ${moved.error}`);

  // ---- refuses sites that aren't allowed, and non-web addresses ----
  const port = new URL(base).port;
  await sw.evaluate(async ([id, port]) => {
    const tasks = await ba.getTasks();
    tasks[id].startUrl = `http://localhost:${port}/index.html`;
    tasks[id].origins = [`http://localhost:${port}`];
    await chrome.storage.local.set({ tasks });
  }, [task.id, port]);
  const refused = await sw.evaluate((id) => ba.runTask(id, 'test'), task.id);
  assert.ok(!refused.ok);
  assert.match(refused.error, /^Not allowed on http:\/\/localhost:/);
  ok(`site not allowed: ${refused.error}`);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings']) {
    const err = await sw.evaluate(([id, url]) => ba.saveTask({ id, startUrl: url }).then(() => 'saved', (e) => e.message), [task.id, url]);
    assert.match(err, /must be an http\(s\) address/, url);
  }
  ok('javascript:, file: and chrome: start pages are rejected');

  console.log('\nE2E PASSED');
} finally {
  await ctx.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
  await rm(extDir, { recursive: true, force: true });
}
