'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProjectViewNavigation } = require('../../electron/project-view-navigation');
const loadNativeLock = require('./fixtures/project-view-locks.cjs');

function fixture() {
  const records = new Map();
  const lock = {
    normalizeProjectPathLoose: path => path,
    tryAcquireLock(path) {
      const alreadyHeld = records.has(path);
      if (!alreadyHeld) records.set(path, { hash: randomUUID(), identity: { path }, owner: { pid: process.pid } });
      return { ok: true, alreadyHeld, normalizedPath: path };
    },
    readViewLockSnapshot: path => records.get(path),
    releaseLock(path, expected) {
      if (expected && records.get(path) !== expected) return { ok: false, code: 'PROJECT_VIEW_CHANGED' };
      records.delete(path);
      return { ok: true };
    },
    handoffViewLock(source, previous, target, reservation) {
      if (records.get(target) !== reservation) return { ok: false, code: 'PROJECT_VIEW_CHANGED' };
      return this.releaseLock(source, previous);
    },
  };
  const navigation = createProjectViewNavigation(lock);
  const select = path => {
    lock.tryAcquireLock(path);
    navigation.selectLegacy(path);
  };
  const request = (sourceProject, projectPath, rendererGeneration = 1) => ({
    requestId: randomUUID(), rendererGeneration, sourceProject, projectPath,
  });
  return { lock, navigation, request, records, select };
}

test('a failed preflight can release only its unselected reservation', () => {
  const { navigation, request, records, select } = fixture();
  select('A');
  const original = request('A', 'B');
  assert.equal(navigation.reserve(original).ok, true);
  assert.equal(navigation.currentProject(), 'A');
  assert.equal(navigation.release(original).ok, true);
  assert.equal(navigation.currentProject(), 'A');
  assert.deepEqual([...records.keys()], ['A']);
  assert.equal(navigation.promote(original).ok, false);
});

test('a late original release cannot remove the successor selection in the same process', () => {
  const { navigation, request, records, select } = fixture();
  select('A');
  const first = request('A', 'B');
  const successor = request('B', 'A', 2);
  assert.equal(navigation.reserve(first).ok, true);
  assert.equal(navigation.promote(first).ok, true);
  assert.equal(navigation.reserve(successor).ok, true);
  assert.equal(navigation.promote(successor).ok, true);
  assert.equal(navigation.release(first).ok, true);
  assert.equal(navigation.promote(first).ok, false);
  assert.equal(navigation.currentProject(), 'A');
  assert.deepEqual([...records.keys()], ['A']);
});

test('renderer exit retires only uncommitted reservations and preserves the selected project', () => {
  const { navigation, request, records, select } = fixture();
  select('A');
  const original = request('A', 'B');
  assert.equal(navigation.reserve(original).ok, true);
  navigation.retireGeneration(1);
  const successor = request('A', 'B', 2);
  assert.equal(navigation.reserve(successor).ok, true);
  assert.equal(navigation.release(original).ok, true);
  assert.equal(navigation.promote(successor).ok, true);
  assert.deepEqual([...records.keys()], ['B']);
  assert.equal(navigation.currentProject(), 'B');
});

test('read-only observation recovers a lost promotion response without another transition', () => {
  const { navigation, request, records, select } = fixture();
  select('A');
  const original = request('A', 'B');
  assert.equal(navigation.reserve(original).ok, true);
  assert.equal(navigation.promote(original).ok, true);
  const published = records.get('B');
  assert.equal(navigation.observe(original).selected, true);
  assert.equal(navigation.observe(original).selected, true);
  assert.equal(records.get('B'), published);
  assert.equal(records.has('A'), false);
});

test('abandoning a dispatched handoff or replacing its target cannot clear another view', () => {
  const { navigation, request, records, select } = fixture();
  select('A');
  const original = request('A', 'B');
  navigation.reserve(original);
  const replacement = { ...records.get('B') };
  records.set('B', replacement);
  assert.equal(navigation.promote(original).ok, false);
  assert.equal(navigation.release(original, true).code, 'PROJECT_VIEW_CHANGED');
  assert.equal(records.get('B'), replacement);
  assert.equal(navigation.currentProject(), 'A');
  const later = request('A', 'B');
  navigation.reserve(later);
  assert.equal(navigation.promote(later).ok, true);
  assert.equal(navigation.release(later, true).ok, true);
  assert.equal(navigation.currentProject(), 'B');
  assert.equal(records.get('B'), replacement);
});

test('a revoked reservation that reaches Main late cannot recreate its original lock', () => {
  const { navigation, request, records, select } = fixture();
  select('A');
  const original = request('A', 'B');
  assert.equal(navigation.release(original, true).ok, true);
  assert.equal(navigation.reserve(original).ok, false);
  assert.deepEqual([...records.keys()], ['A']);
  const successor = request('A', 'B');
  assert.equal(navigation.reserve(successor).ok, true);
  assert.equal(navigation.promote(successor).ok, true);
  assert.equal(navigation.release(original, true).ok, true);
  assert.deepEqual([...records.keys()], ['B']);
});

test('the native handoff refuses replaced markers and keeps the live source lock', t => {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const fixturePath = fs.realpathSync(fs.mkdtempSync(path.join(temporaryParent, 'aily-view-handoff-')));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(fixturePath)), temporaryParent);
    assert.match(path.basename(fixturePath), /^aily-view-handoff-/);
    fs.rmSync(fixturePath, { recursive: true });
  });
  const source = path.join(fixturePath, 'A'), target = path.join(fixturePath, 'B');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  const lock = loadNativeLock();
  assert.equal(lock.tryAcquireLock(source).ok, true);
  const controller = createProjectViewNavigation(lock);
  controller.selectLegacy(source);
  const request = { requestId: randomUUID(), rendererGeneration: 1, sourceProject: source, projectPath: target };
  assert.equal(controller.reserve(request).ok, true);
  const original = lock.readViewLockSnapshot(target);
  assert.equal(lock.releaseLock(target, original).ok, true);
  assert.equal(lock.tryAcquireLock(target).ok, true);
  const replacement = lock.readViewLockSnapshot(target);
  assert.notEqual(replacement.hash, original.hash);
  assert.equal(controller.promote(request).code, 'PROJECT_VIEW_CHANGED');
  assert.equal(controller.release(request, true).code, 'PROJECT_VIEW_CHANGED');
  assert.equal(lock.readViewLockSnapshot(target).hash, replacement.hash);
  assert.ok(lock.readViewLockSnapshot(source));
  assert.equal(controller.currentProject(), source);
});
