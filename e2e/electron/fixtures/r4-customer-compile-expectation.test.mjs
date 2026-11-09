import assert from 'node:assert/strict'
import test from 'node:test'
import { customerNaturalCases, verifyCustomerKnownCompileFailure } from './r4-customer-natural.mjs'
const fixture = { customer: { kind: 'chiyao', ...customerNaturalCases.chiyao } }
const result = { ok: false, code: 'BUILD_FAILED', verification: { status: 'failed' } }
const log = '[ERROR] fatal error: DS1302.h: No such file or directory'
const report = '修改已应用，编译未通过：缺少 DS1302.h。'
test('the original failed dependency is reported as a failure, independently of successful document application', () => {
  assert.equal(verifyCustomerKnownCompileFailure(fixture, result, log, report).actual, 'failed')
  assert.equal(verifyCustomerKnownCompileFailure(fixture, result, log, '修改已应用，编译失败。').missingHeaderMentioned, false)
})
test('success, unrelated compiler failure, or an inaccurate report cannot satisfy the original failure expectation', () => {
  assert.throws(() => verifyCustomerKnownCompileFailure(fixture, { ...result, ok: true }, log, report))
  assert.throws(() => verifyCustomerKnownCompileFailure(fixture, result, 'ENOTCACHED', report))
  assert.throws(() => verifyCustomerKnownCompileFailure(fixture, result, log, '已完成，编译成功。'))
})
test('another source fixture cannot borrow this known failure', () => {
  assert.throws(() => verifyCustomerKnownCompileFailure({ customer: { ...fixture.customer, inputAbiSha256: 'foreign' } }, result, log, report))
})
