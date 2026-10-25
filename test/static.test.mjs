// Checks on the source itself: every file parses, and the extension has no way to send data anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../extension');
const files = (await readdir(dir)).filter((f) => /\.(js|html|json)$/.test(f));
const read = (f) => readFile(path.join(dir, f), 'utf8');

test('every script parses', () => {
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(path.join(dir, f)) });
  }
});

test('no network calls, no code from strings, no HTML injection', async () => {
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bimport\s*\(|externally_connectable|https?:\/\/(?!\*)/;
  for (const f of files.filter((f) => f.endsWith('.js'))) {
    const m = (await read(f)).match(banned);
    assert.equal(m, null, `${f} contains "${m?.[0]}"`);
  }
});

test('html pages load only local scripts, no inline code', async () => {
  for (const f of files.filter((f) => f.endsWith('.html'))) {
    const html = await read(f);
    for (const [, src] of html.matchAll(/<script\b([^>]*)>/g)) assert.match(src, /src="[\w.]+\.js"/, `${f}: inline or remote script`);
    assert.doesNotMatch(html, /\son\w+=|style=|https?:\/\//, `${f}: inline handler, inline style or remote URL`);
  }
});

test('manifest asks for no site access up front and blocks network from extension pages', async () => {
  const m = JSON.parse(await read('manifest.json'));
  assert.equal(m.host_permissions, undefined);
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.externally_connectable, undefined);
  assert.deepEqual(m.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'alarms', 'downloads', 'notifications', 'scripting', 'storage']);
  assert.match(m.content_security_policy.extension_pages, /connect-src 'none'/);
});
