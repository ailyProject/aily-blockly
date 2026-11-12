import assert from 'node:assert/strict'

/** Validate real proxy ordering without manufacturing SDK or host outcomes.
 * The first forwarded observation follows releaseObservation(), which the live
 * fixture permits only after the exact owned candidate artifact is unlinked. */
export function verifyCustomerApplyObservationTrace(commands, { requestId, backupRecordHash } = {}) {
  assert.ok(Array.isArray(commands))
  assert.ok(typeof requestId === 'string' && requestId.length > 0)
  const applications = commands.flatMap((command, index) => command.operation === 'abs_apply' ? [{ command, index }] : [])
  assert.equal(applications.length, 1, 'An uncertain native application must never be dispatched again')
  const application = applications[0]
  assert.equal(application.command.dropped, true, 'The original real native response must have been lost')
  assert.equal(application.command.requestId, requestId)

  const releasedObservation = commands.findIndex(command => command.action === 'observe_apply' && command.dropped === false)
  assert.ok(releasedObservation > application.index, 'Recovery must observe the original request after the cache-loss release')
  const uncertainObservations = commands.slice(application.index + 1, releasedObservation)
    .filter(command => command.action === 'observe_apply')
  assert.ok(uncertainObservations.length > 0 && uncertainObservations.every(command => command.dropped === true),
    'Automatic observations must lose their real replies before the explicit cache-loss recovery')
  for (const command of commands.filter(command => command.action === 'observe_apply')) {
    assert.equal(command.requestId, requestId, 'Every observation must address the one original native request')
  }

  const candidateReads = commands.flatMap((command, index) => command.action === 'read_candidate' && index > releasedObservation
    ? [{ command, index }] : [])
  assert.ok(candidateReads.length > 0, 'Recovery must actually read a project backup after observing the committed request')
  if (backupRecordHash !== undefined) {
    assert.ok(candidateReads.every(({ command }) => command.recordHash === backupRecordHash),
      'The post-cache-loss read must address the exact retained project record')
  }
  return {
    originalRequestId: requestId,
    originalApplyDispatches: applications.length,
    lostApplyCommand: application.index,
    lostAutomaticObservations: uncertainObservations.length,
    firstObservationAfterCacheLoss: releasedObservation,
    candidateReadAfterCacheLoss: candidateReads[0].index,
    exactRecordHashCaptured: backupRecordHash !== undefined
  }
}
