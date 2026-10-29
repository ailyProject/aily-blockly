export interface SubappRecoveryLease { ownerLeaseId: string; sessionId: string; expiresAt: number }
export interface SubappOwnerRecoveryReceipt {
  version: 1; requestId: string; sessionId: string; previousOwnerLeaseId: string;
  ownerLeaseId: string; domainOperationsReplayed: false;
}
interface Retirement {
  lease: SubappRecoveryLease;
  cleanup: 'pending' | 'confirmed' | 'failed';
  requestId?: string;
  successor?: SubappRecoveryLease;
  receipt?: SubappOwnerRecoveryReceipt;
}
interface RecoveryPorts {
  active(id: string): SubappRecoveryLease | undefined;
  release(id: string, session: string): Promise<Record<string, unknown>>;
  acquire(session: string): SubappRecoveryLease;
  pending(id: string): number;
  now(): number;
}

/** Retirement evidence authorizes metadata-only successor leases, never tool replay.
 * Records are private to this Host incarnation; unknown or evicted records grant nothing.
 */
export class SubappOwnerRecovery {
  private readonly retired = new Map<string, Retirement>();
  private readonly limit = 2048;
  constructor(private readonly ports: RecoveryPorts) {}

  remember(lease: SubappRecoveryLease, completion: Promise<Record<string, unknown>>): void {
    if (this.retired.has(lease.ownerLeaseId)) return;
    if (this.retired.size >= this.limit) {
      for (const [id, record] of this.retired) {
        if (record.cleanup === 'confirmed' && this.ports.pending(id) === 0) {
          this.retired.delete(id);
          break;
        }
      }
    }
    // Cleanup still runs when bookkeeping is full. Missing evidence cannot recover.
    if (this.retired.size >= this.limit) return;
    const record: Retirement = { lease: { ...lease }, cleanup: 'pending' };
    this.retired.set(lease.ownerLeaseId, record);
    void completion.then(result => { record.cleanup = result['ok'] === true ? 'confirmed' : 'failed'; },
      () => { record.cleanup = 'failed'; });
  }

  inspect(ownerLeaseId: string, sessionId: string): Record<string, unknown> {
    this.validate(ownerLeaseId, sessionId);
    const active = this.ports.active(ownerLeaseId), record = this.retired.get(ownerLeaseId);
    const known = active ?? record?.lease;
    if (known && known.sessionId !== sessionId) throw this.error('SUBAPP_OWNER_MISMATCH', 'Owner belongs to another session.');
    const pendingRequests = this.ports.pending(ownerLeaseId);
    const state = active ? active.expiresAt > this.ports.now() ? 'active' : 'expired'
      : record ? record.cleanup === 'pending' ? 'retiring' : 'retired' : 'unknown';
    return { version: 1, action: 'inspect', sessionId, ownerLeaseId, state,
      cleanup: record?.cleanup ?? 'unknown', pendingRequests,
      recoverable: !active && record?.cleanup === 'confirmed' && pendingRequests === 0,
      ...(record?.receipt ? { recoveryReceipt: { ...record.receipt } } : {}) };
  }

  recover(ownerLeaseId: string, sessionId: string, requestId: string): Record<string, unknown> {
    this.validate(ownerLeaseId, sessionId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw this.error('SUBAPP_OWNER_RECOVERY_REQUEST_INVALID', 'Recovery requires its original private request ID.');
    }
    const active = this.ports.active(ownerLeaseId);
    if (active) {
      if (active.sessionId !== sessionId) throw this.error('SUBAPP_OWNER_MISMATCH', 'Owner belongs to another session.');
      if (active.expiresAt > this.ports.now()) return this.failure('SUBAPP_OWNER_ACTIVE', 'The owner is still active.');
      // release revokes synchronously and records cleanup before returning its Promise.
      void this.ports.release(ownerLeaseId, sessionId).catch(() => {});
    }
    const record = this.retired.get(ownerLeaseId);
    if (!record) return this.failure('SUBAPP_OWNER_UNKNOWN', 'No verified retirement exists in this Host incarnation.');
    if (record.lease.sessionId !== sessionId) throw this.error('SUBAPP_OWNER_MISMATCH', 'Owner belongs to another session.');
    if (record.requestId && record.requestId !== requestId) {
      return this.failure('SUBAPP_OWNER_RECOVERY_REQUEST_MISMATCH', 'Observe the original recovery; do not start a second one.');
    }
    record.requestId = requestId;
    if (record.successor && record.receipt) {
      const current = this.ports.active(record.successor.ownerLeaseId);
      const receipt = this.success(record, true, current ?? record.successor);
      return current && current.expiresAt > this.ports.now() ? receipt : { ...receipt, ok: false,
        errorCode: 'SUBAPP_OWNER_RECOVERY_RECEIPT_EXPIRED', error: 'The acknowledged successor is no longer active.' };
    }
    if (record.cleanup === 'pending') return this.failure('SUBAPP_OWNER_RETIRING', 'The old owner is still retiring.');
    if (record.cleanup !== 'confirmed') return this.failure('SUBAPP_OWNER_CLEANUP_FAILED', 'Old resource cleanup is not confirmed.');
    if (this.ports.pending(ownerLeaseId) !== 0) {
      return this.failure('SUBAPP_OWNER_PENDING_REQUESTS', 'Old cancelled requests have not finished.');
    }
    const successor = this.ports.acquire(sessionId);
    record.successor = { ...successor };
    record.receipt = { version: 1, requestId, sessionId, previousOwnerLeaseId: ownerLeaseId,
      ownerLeaseId: successor.ownerLeaseId, domainOperationsReplayed: false };
    return this.success(record, false);
  }

  clear(): void { this.retired.clear(); }
  private success(record: Retirement, reused: boolean, lease = record.successor): Record<string, unknown> {
    return { ok: true, version: 1, action: 'recover', ...lease,
      cleanup: 'confirmed', pendingRequests: 0, notResumed: true, deviceResourcesRestored: false,
      recoveryReceipt: { ...record.receipt }, reused };
  }
  private failure(errorCode: string, error: string): Record<string, unknown> {
    return { ok: false, version: 1, action: 'recover', errorCode, error, notResumed: true,
      deviceResourcesRestored: false };
  }
  private validate(ownerLeaseId: string, sessionId: string): void {
    if (!ownerLeaseId || ownerLeaseId.length > 256 || !sessionId || sessionId.length > 256) {
      throw this.error('SUBAPP_SESSION_REQUIRED', 'An exact private owner and session are required.');
    }
  }
  private error(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
}
