import type {
  SimulatorEntitlementHostLeaseDecision,
  SimulatorEntitlementHostProviderAdapterOptions,
  SimulatorEntitlementHostStatusSubscription,
  SimulatorSubappHostEntitlementLeaseRequestV1,
  SimulatorSubappHostEntitlementStatusSubscribeV1,
  SimulatorSubappHostEntitlementStatusV1,
} from '@aily-project/simulator-host-sdk';

export type SimulatorEntitlementAccountState =
  | 'checking'
  | 'authenticated'
  | 'signed-out'
  | 'unavailable';

export interface SimulatorEntitlementAccountSnapshot {
  readonly state: SimulatorEntitlementAccountState;
  readonly connectivity: 'online' | 'offline' | 'unknown';
}

export interface SimulatorEntitlementAccountPort {
  readSnapshot(): SimulatorEntitlementAccountSnapshot;
  subscribe(
    listener: (snapshot: SimulatorEntitlementAccountSnapshot) => void,
  ): Readonly<{ close(): void }>;
}

export interface SimulatorEntitlementCallbackAuthorityOptions {
  account: SimulatorEntitlementAccountPort;
  now?: () => number;
}

type EntitlementCallbacks = Pick<
  SimulatorEntitlementHostProviderAdapterOptions,
  'requestLease' | 'subscribeStatus'
>;

/**
 * Product-account boundary for the Simulator Host Provider.
 *
 * Blockly currently has no trusted signed Simulator lease endpoint. This
 * authority therefore never derives runtime authorization from UI plan names,
 * groups or ordinary entitlement summaries. It exposes redacted account state
 * and fails closed until a future trusted source can supply signed lease and
 * revocation artifacts.
 */
export class SimulatorEntitlementCallbackAuthority {
  readonly callbacks: EntitlementCallbacks;

  private readonly account: SimulatorEntitlementAccountPort;
  private readonly now: () => number;
  private readonly activeSubscriptions = new Set<() => void>();
  private closed = false;

  constructor(options: SimulatorEntitlementCallbackAuthorityOptions) {
    if (
      !options.account
      || typeof options.account.readSnapshot !== 'function'
      || typeof options.account.subscribe !== 'function'
    ) {
      throw new TypeError('Simulator Entitlement account port is invalid.');
    }
    this.account = options.account;
    this.now = options.now ?? Date.now;
    this.callbacks = Object.freeze({
      requestLease: (request, signal) => this.requestLease(request, signal),
      subscribeStatus: (request, publish, signal) => (
        this.subscribeStatus(request, publish, signal)
      ),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const close of [...this.activeSubscriptions]) close();
    this.activeSubscriptions.clear();
  }

  private requestLease(
    _request: SimulatorSubappHostEntitlementLeaseRequestV1,
    signal: AbortSignal,
  ): SimulatorEntitlementHostLeaseDecision {
    this.requireOpen(signal);
    const account = this.readAccountSnapshot();
    return Object.freeze({
      disposition: 'unavailable',
      unavailableReason: account.state === 'signed-out'
        ? 'sign-in-required'
        : 'temporarily-unavailable',
      lease: null,
      revocations: null,
    });
  }

  private subscribeStatus(
    request: SimulatorSubappHostEntitlementStatusSubscribeV1,
    publish: (status: unknown) => void,
    signal: AbortSignal,
  ): SimulatorEntitlementHostStatusSubscription {
    this.requireOpen(signal);
    let closed = false;
    let source: Readonly<{ close(): void }> | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      this.activeSubscriptions.delete(close);
      source?.close();
      source = null;
    };
    this.activeSubscriptions.add(close);
    signal.addEventListener('abort', close, { once: true });
    try {
      source = this.account.subscribe(() => {
        if (!closed && !signal.aborted && !this.closed) {
          publish(this.createStatus());
        }
      });
      if (!source || typeof source.close !== 'function') {
        throw new TypeError('Simulator Entitlement account subscription is invalid.');
      }
      return Object.freeze({
        acceptedFromSequence: request.afterSequence ?? 0,
        status: this.createStatus(),
        close,
      });
    } catch (error) {
      close();
      throw error;
    }
  }

  private createStatus(): SimulatorSubappHostEntitlementStatusV1 {
    const account = this.readAccountSnapshot();
    const observedAtUnixMs = this.requireNow();
    return Object.freeze({
      schemaVersion: 1,
      kind: 'aily-simulator-host-entitlement-status',
      product: 'aily-simulator',
      accountState: account.state === 'signed-out'
        ? 'sign-in-required'
        : account.state === 'checking'
          ? 'refreshing'
          : 'temporarily-unavailable',
      connectivity: account.connectivity,
      leaseExpiresAtUnixMs: null,
      observedAtUnixMs,
    });
  }

  private readAccountSnapshot(): SimulatorEntitlementAccountSnapshot {
    const snapshot = this.account.readSnapshot();
    if (
      !snapshot
      || ![
        'checking',
        'authenticated',
        'signed-out',
        'unavailable',
      ].includes(snapshot.state)
      || !['online', 'offline', 'unknown'].includes(snapshot.connectivity)
    ) {
      throw new TypeError('Simulator Entitlement account snapshot is invalid.');
    }
    return Object.freeze({ ...snapshot });
  }

  private requireOpen(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Simulator Entitlement callback was cancelled.');
    }
    if (this.closed) {
      throw new Error('Simulator Entitlement callback authority is closed.');
    }
  }

  private requireNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('Simulator Entitlement callback clock is invalid.');
    }
    return now;
  }
}
