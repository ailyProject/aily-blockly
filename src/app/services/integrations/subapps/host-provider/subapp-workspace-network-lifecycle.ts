import {
  SIMULATOR_SUBAPP_HOST_PROVIDER_TRANSPORT_MESSAGE_TYPES as TYPES,
  validateHostNetworkBindingLifecycleV1, validateHostNetworkBindingCloseRequestV1, validateHostNetworkBindingCloseIdentityV1, validateHostNetworkBindingCloseExchangeV1,
  validateHostNetworkProviderRequestV1, validateHostNetworkProviderExchangeV1, hostNetworkGrantIdentityV1,
  type HostNetworkBindingLifecycleV1, type HostNetworkBindingCloseIdentityV1, type HostNetworkBindingCloseRequestV1,
} from '@aily-project/simulator-protocol/host';

type RecordValue = Record<string, unknown>;
/** One original Workspace binding. Main supplies only lifecycle correlation;
 * this adapter supplies the already-bound Host identity and original close lane.
 * Nonterminal state never retires the controller/catalog or grants permission. */
export function createWorkspaceNetworkLifecycle(options: {
  hostInstanceId: string;
  closeOriginal(): Promise<void>;
  send(message: RecordValue): Promise<void>;
}) {
  let retained: HostNetworkBindingLifecycleV1 | null = null;
  let selected: HostNetworkBindingCloseIdentityV1 | null = null;
  let submittedRevision = 0, publishing: Promise<void> | null = null;
  const operations = new Set<Promise<void>>();
  // The original selected identity stays retained during later/unknown select
  // delivery. It cannot close the whole tuple while that newer reservation
  // may own a chooser or grant. Only a validated terminal no-acquisition result
  // or the real successor grant can settle this destructive ordering fence.
  const selections = new Map<string, { requestId: string; requestSequence: number }>();
  const reservationKey = (request: { requestId: string; requestSequence: number }) => JSON.stringify([request.requestId, request.requestSequence]);
  const ownsPendingLegacySelection = (original: HostNetworkBindingCloseRequestV1) =>
    original.kind === 'aily-host-network-binding-lifecycle' && selections.size === 1
    && selections.has(reservationKey(original.selection));
  const requireSameOriginal = (current: HostNetworkBindingCloseRequestV1 | null, original: HostNetworkBindingCloseRequestV1) => {
    if (!current) throw new Error('Original network cleanup identity is unavailable.');
    validateHostNetworkBindingCloseExchangeV1(current, { schemaVersion: 1,
      kind: 'aily-host-network-binding-close-result', hostInstanceId: original.hostInstanceId,
      selection: original.selection, grant: original.grant, state: 'closed' });
  };
  const flush = (): Promise<void> => {
    if (publishing) return publishing;
    const task = Promise.resolve().then(async () => {
      while (retained && retained.revision > submittedRevision) {
        const original = retained;
        await options.send({ type: TYPES.networkBindingState, version: 1, state: original });
        submittedRevision = original.revision;
      }
    }).finally(() => { if (publishing === task) publishing = null; });
    publishing = task;
    return task;
  };
  return {
    observeDispatch(value: unknown): void {
      const request = validateHostNetworkProviderRequestV1(value);
      if (request.operation !== 'select') return;
      if (selections.has(reservationKey(request))) throw new Error('Original network selection cleanup reservation is already owned.');
      if (selections.size >= 16) throw new Error('Original network selection cleanup capacity reached.');
      selections.set(reservationKey(request), Object.freeze({ requestId: request.requestId, requestSequence: request.requestSequence }));
    },
    observeExchange(request: unknown, result: unknown): void {
      const value = validateHostNetworkProviderExchangeV1(request, result);
      if (value.operation === 'select' && (value.ok === true || value.ok === false && ['busy', 'invalid-input', 'request-replayed', 'backpressure'].includes(value.errorCode))) {
        // Timeout/cancelled/unknown failures can precede the original chooser's
        // actual settlement; keep those reservations until full owner close.
        selections.delete(reservationKey(value));
      }
      if (value.ok && value.operation === 'select' && value.outcome === 'selected') {
        const input = request as { requestId: string; requestSequence: number };
        selected = validateHostNetworkBindingCloseIdentityV1({ schemaVersion: 1,
          kind: 'aily-host-network-binding-close-identity', hostInstanceId: options.hostInstanceId,
          selection: { requestId: input.requestId, requestSequence: input.requestSequence }, grant: hostNetworkGrantIdentityV1(value.grant) });
      }
      // A grant-release receipt is not a full binding retirement. Retain the
      // original destructive handle until a real successor selection replaces
      // it or this actual Workspace binding is finally released.
    },
    observe(value: unknown): boolean {
      let next: HostNetworkBindingLifecycleV1;
      try {
        next = validateHostNetworkBindingLifecycleV1(value);
        if (next.hostInstanceId !== options.hostInstanceId || next.revision <= (retained?.revision ?? 0)) return false;
        if (retained) validateHostNetworkBindingCloseExchangeV1(retained, {
          schemaVersion: 1, kind: 'aily-host-network-binding-close-result', hostInstanceId: next.hostInstanceId,
          selection: next.selection, grant: next.grant, state: 'closed',
        });
      } catch { return false; }
      retained = next;
      // Retention precedes delivery. A failed push remains available to flush
      // before any related ordinary result, without replaying its request.
      void flush().catch(() => undefined);
      return true;
    },
    flush,
    handleClose(value: RecordValue): boolean {
      if (value['type'] !== TYPES.networkBindingClose) return false;
      if (value['version'] !== 1 || Object.keys(value).sort().join(',') !== 'original,requestId,type,version'
        || typeof value['requestId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value['requestId'])) return true;
      let original: HostNetworkBindingCloseRequestV1;
      try {
        original = validateHostNetworkBindingCloseRequestV1(value['original']);
        requireSameOriginal(original.kind === 'aily-host-network-binding-close-identity' ? selected : retained, original);
        if (selected && (!ownsPendingLegacySelection(original)
          || original.selection.requestSequence <= selected.selection.requestSequence)) requireSameOriginal(selected, original);
      } catch { return true; }
      if (operations.size >= 64) return true;
      const requestId = value['requestId'];
      const work = Promise.resolve().then(async () => {
        let outcome: RecordValue;
        try {
          // This closes the exact retained Main tuple. It remains authorized
          // after controller exit/expiry and never allocates a Host sequence.
          // Recheck in the actual close microtask: a newer dispatch can enter
          // after frame validation. Do not consume or drop the old capability;
          // failed/unknown cleanup and its real owner remain retained.
          requireSameOriginal(original.kind === 'aily-host-network-binding-close-identity' ? selected : retained, original);
          // A trusted Main lifecycle may precede its own selected result. Only
          // that exact sole reservation can close its partial original owner;
          // an old RAW frame must not close a successor chooser or grant.
          const ownPendingLegacy = ownsPendingLegacySelection(original);
          if (selections.size && !ownPendingLegacy)
            throw new Error('Original network cleanup is fenced by another selection.');
          if (selected && (!ownPendingLegacy
            || original.selection.requestSequence <= selected.selection.requestSequence)) requireSameOriginal(selected, original);
          await options.closeOriginal();
          outcome = { ok: true, result: { schemaVersion: 1, kind: 'aily-host-network-binding-close-result',
            hostInstanceId: original.hostInstanceId, selection: original.selection, grant: original.grant, state: 'closed' } };
        } catch { outcome = { ok: false, errorCode: 'cleanup-unconfirmed' }; }
        await options.send({ type: TYPES.networkBindingCloseResult, version: 1, requestId, outcome });
      });
      operations.add(work);
      void work.catch(() => undefined).finally(() => operations.delete(work));
      return true;
    },
    async whenIdle(): Promise<void> { await Promise.allSettled([...operations]); },
    snapshot: () => Object.freeze({ retained, submittedRevision, pendingCleanup: operations.size }),
  };
}
