import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { environmentSessionStartup } from './r2-environment-session.mjs'

const project = path.resolve('owned-project'), commands = [
  { id: 'create', type: 'session.create', cwd: project, at: 1 },
  { id: 'subscribe', type: 'session.subscribe', sessionId: 'original', at: 3 },
]
const created = { id: 'create', ok: true, sessionId: 'original', cwd: project, at: 2 }
test('fresh runtime requires its actual create and subscribed ACKs before a registry observation', () => {
  assert.equal(environmentSessionStartup(commands, [], project), undefined)
  assert.equal(environmentSessionStartup(commands, [created], project), undefined)
  const ready = environmentSessionStartup(commands, [created, { id: 'subscribe', ok: true, subscribed: true, at: 4 }], project)
  assert.equal(ready.sessionId, 'original'); assert.equal(ready.subscriptionResponse.at, 4)
})
test('failed or foreign ACKs cannot stand in for the exact real UI runtime', () => {
  assert.throws(() => environmentSessionStartup(commands, [{ ...created, ok: false, errorCode: 'OPEN_FAILED' }], project), /OPEN_FAILED/)
  assert.throws(() => environmentSessionStartup(commands, [created, { id: 'subscribe', ok: false, errorCode: 'SUBSCRIBE_FAILED' }], project), /SUBSCRIBE_FAILED/)
  assert.throws(() => environmentSessionStartup(commands, [{ ...created, cwd: path.resolve('foreign') }], project))
  assert.equal(environmentSessionStartup(commands, [created, { id: 'unrelated', ok: true, subscribed: true }], project), undefined)
})
