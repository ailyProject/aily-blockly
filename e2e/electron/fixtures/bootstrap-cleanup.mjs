/** Unknown observation is never permission to terminate accepted product work. */
export function bootstrapCleanupDecision({ hostStarted, submissionAttempted, hostState, session,
  sessionObserved = false, requiresSession = true }) {
  if (!hostStarted) return { allowed: true, reason: 'no-owned-host-started' }
  const hostKnown = Boolean(hostState && Number.isInteger(hostState.lifecycleOwners)
    && typeof hostState.hasRunning === 'boolean')
  const buildActive = Boolean(hostState?.buildRequestId && hostState.buildCompleted !== true && hostState.cancelled !== true)
  const hostSettled = hostKnown && hostState.lifecycleOwners === 0 && hostState.hasRunning === false && !buildActive
  const final = session?.messages?.filter(message => message.role === 'assistant').at(-1)
  const sessionSettled = sessionObserved && session?.isIdle === true && session?.isStreaming === false
    && ['stop', 'aborted', 'error'].includes(final?.stopReason)
  const allowed = hostSettled && (!submissionAttempted || !requiresSession || sessionSettled)
  return { allowed, reason: allowed ? 'authoritatively-settled' : !hostKnown ? 'host-state-unknown'
    : !hostSettled ? 'host-work-still-active' : !sessionObserved ? 'submitted-session-state-unknown' : 'submitted-session-not-settled',
    hostKnown, hostSettled, buildActive, sessionObserved, sessionSettled }
}
