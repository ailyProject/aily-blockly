import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { interruptRepairCommit } from '../../e2e/fixtures/repair-commit-fault.mjs'

const require = createRequire(import.meta.url)
const native = require('../../electron/project-repair-environment.js')
const appData = path.resolve('tests/test-results/repair-commit-fault-fixture')
const app = { evaluate: (fn, input) => fn({ app: { getAppPath: () => path.resolve('.') } }, input) }
const owner = { hostPid: process.pid, environmentId: 'old-child', epoch: 2,
  recordFile: path.join(appData, 'old-epoch.json') }
const current = path.join(appData, 'agent-repair-environments/lineages/lineage/current.json')
function isolate(t) {
  const original = native.writeRecord, oldData = process.env.AILY_APPDATA_PATH, writes = []
  process.env.AILY_APPDATA_PATH = appData
  native.writeRecord = (...args) => { writes.push(args); return 'written' }
  t.after(() => {
    globalThis.__isolatedRepairCommitFault?.restore()
    delete globalThis.__isolatedRepairCommitFault
    native.writeRecord = original
    if (oldData === undefined) delete process.env.AILY_APPDATA_PATH
    else process.env.AILY_APPDATA_PATH = oldData
  })
  return writes
}
const adoption = () => interruptRepairCommit(app, { pid: process.pid, appData, kind: 'adoption-current',
  lineageId: 'lineage', previousOwner: owner })

test('adoption fault does not interrupt a replacement child or a different native identity', async t => {
  const writes = isolate(t), fault = await adoption()
  const value = { ...owner, lineageId: 'lineage', ownerHostPid: process.pid, epoch: 3 }
  for (const changed of [{ hostPid: owner.hostPid + 1 }, { environmentId: 'new-child' },
    { recordFile: path.join(appData, 'new-epoch.json') }, { epoch: owner.epoch }])
    assert.equal(native.writeRecord(current, { ...value, ...changed }), 'written')
  assert.equal(await fault.restore({ required: false }), null)
  assert.equal(writes.length, 4)
})

test('adoption fault interrupts only the exact continuing child and restores after one hit', async t => {
  const writes = isolate(t), fault = await adoption()
  const value = { ...owner, lineageId: 'lineage', ownerHostPid: process.pid, epoch: 3 }
  assert.throws(() => native.writeRecord(current, value), { code: 'EIO' })
  assert.equal(native.writeRecord(current, value), 'written')
  assert.deepEqual((await fault.restore()).value, value)
  assert.equal(writes.length, 1)
})

test('final-ack fault requires the exact request and an actual completed write', async t => {
  const writes = isolate(t)
  const fault = await interruptRepairCommit(app, { pid: process.pid, appData,
    kind: 'final-ack', requestId: 'exact-request' })
  const filename = path.join(path.dirname(current), 'requests/resume.json')
  native.writeRecord(filename, { requestId: 'another-request', state: 'completed' })
  native.writeRecord(filename, { requestId: 'exact-request', state: 'pending' })
  assert.throws(() => native.writeRecord(filename, { requestId: 'exact-request', state: 'completed' }), { code: 'EIO' })
  assert.equal((await fault.restore()).kind, 'final-ack')
  assert.equal(writes.length, 2)
})

test('adoption injection rejects missing identity instead of broadly matching a new launch', async () => {
  await assert.rejects(interruptRepairCommit(app, { pid: process.pid, appData, kind: 'adoption-current',
    lineageId: 'lineage' }))
})
