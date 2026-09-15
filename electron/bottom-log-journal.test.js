'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BottomLogJournal } = require('./bottom-log-journal');

test('writes every entry and reads bounded tail, older pages, and incremental pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-bottom-log-'));
  try {
    const journal = new BottomLogJournal(root);
    for (let i = 0; i < 1500; i++) {
      journal.append('main', { timestamp: i + 1, detail: `line-${i}`, state: i % 10 === 0 ? 'error' : 'info' });
    }
    const tail = await journal.read('main', { mode: 'tail', limit: 200 });
    assert.equal(tail.entries.length, 200);
    assert.equal(tail.entries[0].detail, 'line-1300');
    assert.equal(tail.entries.at(-1).detail, 'line-1499');
    assert.equal(tail.hasMore, true);

    const older = await journal.read('main', { mode: 'before', beforeOffset: tail.beforeOffset, generation: tail.generation, limit: 200 });
    assert.equal(older.entries.length, 200);
    assert.equal(older.entries[0].detail, 'line-1100');
    assert.equal(older.entries.at(-1).detail, 'line-1299');

    journal.append('main', { detail: 'line-1500', state: 'error' });
    const incremental = await journal.read('main', { mode: 'after', afterOffset: tail.nextOffset, generation: tail.generation });
    assert.deepEqual(incremental.entries.map(item => item.detail), ['line-1500']);
    assert.equal(incremental.hasMore, false);

    const errors = await journal.read('main', { mode: 'tail', errorsOnly: true, limit: 20 });
    assert.equal(errors.entries.length, 20);
    assert.ok(errors.entries.every(item => item.state === 'error'));
    const noMatches = await journal.read('main', { mode: 'tail', keyword: 'never-present' });
    assert.equal(noMatches.hasMore, false);
    assert.equal(noMatches.beforeOffset, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clear rotates the visible file and export streams the complete active log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-bottom-log-'));
  try {
    const journal = new BottomLogJournal(root);
    journal.append('main', { detail: 'before-clear' });
    const old = await journal.read('main', { mode: 'tail' });
    await journal.clear('main');
    journal.append('main', { title: 'Build', detail: '\u001b[31m[ERROR] after-clear\u001b[0m', state: 'error' });
    const current = await journal.read('main', { mode: 'tail' });
    assert.equal(current.generation, old.generation + 1);
    assert.deepEqual(current.entries.map(item => item.detail), ['\u001b[31m[ERROR] after-clear\u001b[0m']);
    const stale = await journal.read('main', { mode: 'after', generation: old.generation, afterOffset: old.nextOffset });
    assert.equal(stale.reset, true);

    const target = path.join(root, 'export.txt');
    assert.equal((await journal.exportText('main', target)).count, 1);
    assert.match(fs.readFileSync(target, 'utf8'), /Build after-clear/);
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /before-clear|\u001b/);
    await assert.rejects(journal.exportText('main', path.join(root, 'missing', 'export.txt')));
    const archived = fs.readFileSync(path.join(journal.sessionDir, 'main-0.jsonl'), 'utf8');
    assert.match(archived, /before-clear/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('large entries stay complete on disk and can be fetched for copying', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-bottom-log-'));
  try {
    const journal = new BottomLogJournal(root);
    const detail = `start-${'中'.repeat(40000)}-end`;
    journal.append('main', { detail });
    const page = await journal.read('main', { mode: 'tail', limit: 1 });
    assert.equal(page.entries[0].previewTruncated, true);
    assert.ok(page.entries[0].detail.endsWith('…'));
    const full = await journal.readEntry('main', {
      generation: page.generation,
      offset: page.entries[0].offset,
    });
    assert.equal(full.detail, detail);
    journal.append('main', { detail: 'second-entry' });
    const target = path.join(root, 'large-export.txt');
    assert.equal((await journal.exportText('main', target)).count, 2);
    const exported = fs.readFileSync(target, 'utf8');
    assert.match(exported, /start-中+\-end/);
    assert.match(exported, /second-entry/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
