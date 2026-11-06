import {
  validateLocalSerialCommand,
  validateLocalSerialExchange,
  validateSimulatorSubappHostProviderInvocationV1,
  validateSimulatorSubappHostProviderExchangeV1,
  type LocalSerialScope,
} from '@aily-project/simulator-protocol/host';
import type {
  SubappHostProviderAdapter, SubappHostProviderRecord, SubappHostProviderFailureCode,
} from '../../services/integrations/subapps/host-provider/subapp-host-provider-dispatcher';

/** Hardware is negotiated independently of project callbacks. The native
 * authority is the exact Main controller closure, never project context. */
export function createSimulatorLocalSerialHostProvider(
  invoke: (command: SubappHostProviderRecord) => Promise<SubappHostProviderRecord>,
): SubappHostProviderAdapter {
  let closed = false;
  const scopes = new Map<string, LocalSerialScope>();
  const key = (scope: LocalSerialScope) => JSON.stringify([scope.sessionId, scope.nodeId, scope.clockDomainId, scope.generation]);
  const revoke = async (scope: LocalSerialScope) => {
    const command = { schemaVersion: 1 as const, kind: 'aily-local-serial-command' as const, command: 'revoke' as const, scope };
    const result = validateLocalSerialExchange(command, await invoke(command));
    if (result.ok === false) throw new Error(`Local serial release remains unconfirmed: ${result.errorCode}`);
    scopes.delete(key(scope));
  };
  const envelope = (invocation: SubappHostProviderRecord) => ({
    schemaVersion: 1, kind: 'aily-simulator-subapp-host-provider-result',
    invocationId: invocation['invocationId'], provider: 'hardware', providerRevision: invocation['providerRevision'],
    protocolVersion: 1, capability: 'hardware.serial', completedAtUnixMs: Math.min(Date.now(), Number(invocation['deadlineUnixMs'])),
  });
  const failure = (invocation: SubappHostProviderRecord, code: SubappHostProviderFailureCode) => ({
    ...envelope(invocation), status: 'failed', payload: null, errorCode: code,
  });
  let closing: Promise<void> | null = null;
  return {
    provider: 'hardware', protocolVersions: [1], capabilities: ['hardware.serial'], createFailureResult: failure,
    async handleInvocation(value, context) {
      const invocation = await validateSimulatorSubappHostProviderInvocationV1(structuredClone(value));
      if (invocation.provider !== 'hardware' || invocation.capability !== 'hardware.serial') throw new TypeError('Invalid hardware invocation.');
      const command = validateLocalSerialCommand(invocation.payload);
      if (closed || context.signal.aborted) return { result: failure(value, 'cancelled') };
      if (Date.now() >= invocation.deadlineUnixMs) return { result: failure(value, 'deadline-exceeded') };
      if (!scopes.has(key(command.scope)) && scopes.size >= 64) return { result: failure(value, 'operation-failed') };
      scopes.set(key(command.scope), command.scope);
      // Cancellation revokes the hardware mapping; it never retries a write.
      let cancelledRelease: Promise<void> | null = null;
      const cancel = () => { cancelledRelease ??= revoke(command.scope); void cancelledRelease.catch(() => undefined); };
      context.signal.addEventListener('abort', cancel, { once: true });
      try {
        const payload = validateLocalSerialExchange(command, await invoke(command as unknown as SubappHostProviderRecord));
        if (closed || context.signal.aborted || Date.now() >= invocation.deadlineUnixMs) {
          cancel(); await cancelledRelease;
          return { result: failure(value, closed || context.signal.aborted ? 'cancelled' : 'deadline-exceeded') };
        }
        if (command.command === 'revoke' && payload.ok) scopes.delete(key(command.scope));
        const result = { ...envelope(value), status: 'succeeded', errorCode: null, payload };
        await validateSimulatorSubappHostProviderExchangeV1(invocation, result);
        if (closed || context.signal.aborted || Date.now() >= invocation.deadlineUnixMs) {
          cancel(); await cancelledRelease;
          return { result: failure(value, closed || context.signal.aborted ? 'cancelled' : 'deadline-exceeded') };
        }
        return { result };
      } finally { context.signal.removeEventListener('abort', cancel); }
    },
    close() {
      closed = true;
      if (closing) return closing;
      const task = Promise.allSettled([...scopes.values()].map(revoke)).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Hardware provider cleanup requires retry.');
      }).finally(() => { if (closing === task) closing = null; });
      closing = task; return task;
    },
  };
}
