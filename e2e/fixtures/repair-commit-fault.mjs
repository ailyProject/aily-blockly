import assert from 'node:assert/strict'

/** Interrupt one native metadata commit in the suite-owned parent. Actual
 * child launch, authentication, Agent IO and all project writes stay real. */
export async function interruptRepairCommit(app, { pid, appData, kind, requestId, lineageId, previousOwner }) {
  assert.ok(['final-ack', 'adoption-current'].includes(kind))
  if (kind === 'adoption-current') {
    assert.ok(Number.isSafeInteger(previousOwner?.hostPid) && previousOwner.hostPid > 0)
    assert.ok(Number.isSafeInteger(previousOwner?.epoch) && previousOwner.epoch >= 0)
    assert.equal(typeof previousOwner?.environmentId, 'string')
    assert.equal(typeof previousOwner?.recordFile, 'string')
  }
  await app.evaluate(({ app }, input) => {
    const path = process.getBuiltinModule('node:path')
    const { createRequire } = process.getBuiltinModule('node:module')
    if (process.pid !== input.pid || path.resolve(process.env.AILY_APPDATA_PATH) !== path.resolve(input.appData)
      || globalThis.__isolatedRepairCommitFault) throw new Error('Fault injection requires the exact private parent')
    const require = createRequire(path.join(app.getAppPath(), 'package.json'))
    const native = require('./electron/project-repair-environment.js')
    const original = native.writeRecord
    const state = { hit: null, restore: () => { native.writeRecord = original } }
    globalThis.__isolatedRepairCommitFault = state
    native.writeRecord = function (filename, value) {
      const relative = path.relative(path.join(input.appData, 'agent-repair-environments', 'lineages'), filename)
      const within = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      const matches = input.kind === 'final-ack'
        ? path.basename(path.dirname(filename)) === 'requests' && value.requestId === input.requestId && value.state === 'completed'
        : path.basename(filename) === 'current.json' && value.lineageId === input.lineageId && value.ownerHostPid === process.pid
          && value.hostPid === input.previousOwner.hostPid && value.environmentId === input.previousOwner.environmentId
          && value.recordFile === input.previousOwner.recordFile && value.epoch > input.previousOwner.epoch
      if (within && matches) {
        state.hit = { kind: input.kind, filename, value }
        state.restore()
        throw Object.assign(new Error('Isolated native commit interruption'), { code: 'EIO' })
      }
      return original.apply(this, arguments)
    }
  }, { pid, appData, kind, requestId, lineageId, previousOwner })
  return {
    async restore({ required = true } = {}) {
      const hit = await app.evaluate(() => {
        const state = globalThis.__isolatedRepairCommitFault
        state?.restore()
        delete globalThis.__isolatedRepairCommitFault
        return state?.hit
      })
      if (required) assert.ok(hit, 'The exact native commit boundary must actually have been interrupted')
      return hit
    }
  }
}
