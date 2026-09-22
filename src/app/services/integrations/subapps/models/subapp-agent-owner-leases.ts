export interface SubappAgentOwnerLease {
  ownerLeaseId: string;
  sessionId: string;
  expiresAt: number;
}

/** Host-side authority for one live Agent session incarnation, not a device lease. */
export class SubappAgentOwnerLeases {
  private readonly leases = new Map<string, SubappAgentOwnerLease>();
  private readonly releasing = new Map<string, Promise<Record<string, unknown>>>();
  private readonly cancellations = new Map<string, Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly ttlMs = 45_000;
  readonly heartbeatMs = 10_000;

  constructor(
    private readonly onRelease: (lease: SubappAgentOwnerLease) => Promise<Record<string, unknown>>,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(sessionId: string): SubappAgentOwnerLease {
    if (!sessionId || sessionId.length > 256) throw this.error('SUBAPP_SESSION_REQUIRED', 'A valid session id is required');
    if (this.leases.size >= 256) throw this.error('SUBAPP_OWNER_LIMIT', 'Too many active Subapp owners');
    const lease = { ownerLeaseId: `owner-${crypto.randomUUID()}`, sessionId, expiresAt: this.now() + this.ttlMs };
    this.leases.set(lease.ownerLeaseId, lease);
    if (!this.timer) {
      this.timer = setInterval(() => void this.expire(), 1000);
      (this.timer as unknown as { unref?(): void }).unref?.();
    }
    return { ...lease };
  }

  require(ownerLeaseId: string, sessionId: string, requestId = ''): SubappAgentOwnerLease {
    const lease = this.leases.get(ownerLeaseId);
    if (!lease || lease.expiresAt <= this.now()) {
      throw this.error('SUBAPP_OWNER_EXPIRED', 'Subapp owner has closed or expired; reopen the Agent session');
    }
    if (lease.sessionId !== sessionId) throw this.error('SUBAPP_OWNER_MISMATCH', 'Subapp owner belongs to another session');
    const cancellations = this.cancellations.get(ownerLeaseId);
    if (requestId && (cancellations?.get(requestId) || 0) > this.now()) {
      throw this.error('SUBAPP_RPC_CANCELLED', 'Subapp Agent request was cancelled');
    }
    return lease;
  }

  renew(ownerLeaseId: string, sessionId: string): SubappAgentOwnerLease {
    const lease = this.require(ownerLeaseId, sessionId);
    lease.expiresAt = this.now() + this.ttlMs;
    return { ...lease };
  }

  cancel(ownerLeaseId: string, sessionId: string, requestId: string): void {
    this.require(ownerLeaseId, sessionId);
    if (!requestId || requestId.length > 256) throw this.error('SUBAPP_REQUEST_REQUIRED', 'A valid request id is required');
    let requests = this.cancellations.get(ownerLeaseId);
    if (!requests) this.cancellations.set(ownerLeaseId, requests = new Map());
    for (const [id, expiry] of requests) if (expiry <= this.now()) requests.delete(id);
    if (requests.size >= 1024 && !requests.has(requestId)) {
      throw this.error('SUBAPP_CANCEL_LIMIT', 'Too many cancelled requests; close this owner before continuing');
    }
    // Fence a cancel that arrives before the corresponding HTTP tool call.
    requests.set(requestId, this.now() + 620_000);
  }

  sessionId(ownerLeaseId: string): string { return this.leases.get(ownerLeaseId)?.sessionId || ownerLeaseId; }
  hasSession(sessionId: string): boolean { return [...this.leases.values()].some(lease => lease.sessionId === sessionId); }

  release(ownerLeaseId: string, sessionId?: string): Promise<Record<string, unknown>> {
    const pending = this.releasing.get(ownerLeaseId);
    if (pending) return pending;
    const lease = this.leases.get(ownerLeaseId);
    if (!lease) return Promise.resolve({ ok: true, released: false });
    if (sessionId && sessionId !== lease.sessionId) {
      return Promise.reject(this.error('SUBAPP_OWNER_MISMATCH', 'Subapp owner belongs to another session'));
    }
    // Revoke synchronously, before awaiting any Runtime callback.
    this.leases.delete(ownerLeaseId);
    this.cancellations.delete(ownerLeaseId);
    if (!this.leases.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const cleanup = Promise.resolve().then(() => this.onRelease(lease)).finally(() => this.releasing.delete(ownerLeaseId));
    this.releasing.set(ownerLeaseId, cleanup);
    return cleanup;
  }

  async expire(): Promise<void> {
    await Promise.all([...this.leases.values()].filter(lease => lease.expiresAt <= this.now()).map(async lease => {
      try {
        const result = await this.release(lease.ownerLeaseId);
        if (result['ok'] === false) console.warn('[subapp-owner] Expiry cleanup failed', lease.sessionId, result);
      } catch (error) { console.warn('[subapp-owner] Expiry cleanup failed', lease.sessionId, error); }
    }));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.leases.clear();
    this.cancellations.clear();
  }

  private error(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
}
