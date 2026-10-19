import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, fromEvent, Subscription, takeUntil, timeout } from 'rxjs';
import { validateSignedSimulatorEntitlementLease, validateSignedSimulatorEntitlementRevocations } from '@aily-project/simulator-protocol/entitlement';
import type { SimulatorSubappHostEntitlementLeaseRequestV1 } from '@aily-project/simulator-protocol/host';
import type { SimulatorEntitlementHostLeaseDecision } from '@aily-project/simulator-host-sdk';
import { API } from '../../configs/api.config';

import { AuthService } from '@core/auth/public-api';
import type {
  SimulatorEntitlementAccountPort,
  SimulatorEntitlementAccountSnapshot,
} from './simulator-entitlement-callback-authority';

/** Redacted projection of Blockly account/connectivity state. */
@Injectable({ providedIn: 'root' })
export class SimulatorEntitlementAccountService
implements SimulatorEntitlementAccountPort {
  private deliveredScope: { generation: number; endpoint: string } | null = null;

  constructor(private readonly auth: AuthService, private readonly http: HttpClient) {}

  readSnapshot(): SimulatorEntitlementAccountSnapshot {
    const initialization = this.auth.getAuthInitializationState();
    return Object.freeze({
      state: this.auth.isLoggedIn || initialization === 'authenticated'
        ? 'authenticated'
        : initialization === 'signed_out'
          ? 'signed-out'
          : initialization === 'unavailable'
            ? 'unavailable'
            : 'checking',
      connectivity: readConnectivity(),
    });
  }

  async requestLease(
    request: SimulatorSubappHostEntitlementLeaseRequestV1,
    signal: AbortSignal,
  ): Promise<SimulatorEntitlementHostLeaseDecision> {
    signal.throwIfAborted();
    const generation = this.auth.getAuthCredentialGeneration();
    const endpoint = API.simulatorEntitlementLease;
    const unavailable = (): SimulatorEntitlementHostLeaseDecision => ({
      disposition: 'unavailable',
      unavailableReason: this.readSnapshot().state === 'signed-out'
        || this.deliveredScope !== null && (this.deliveredScope.generation !== generation
          || this.deliveredScope.endpoint !== endpoint)
        || this.auth.getAuthCredentialGeneration() !== generation
        || API.simulatorEntitlementLease !== endpoint
        ? 'sign-in-required' : 'temporarily-unavailable',
      lease: null,
      revocations: null,
    });

    if (this.readSnapshot().state !== 'authenticated') return unavailable();

    try {
      // The existing account interceptor owns bearer tokens and refresh. Only
      // signed public artifacts cross the Simulator Host Provider boundary.
      const response = await firstValueFrom(this.http.post<unknown>(endpoint, {
        product: 'aily-simulator', currentLeaseId: request.currentLeaseId,
      }).pipe(timeout(15_000), takeUntil(fromEvent(signal, 'abort'))));

      signal.throwIfAborted();

      if (this.auth.getAuthCredentialGeneration() !== generation
        || API.simulatorEntitlementLease !== endpoint
        || this.readSnapshot().state !== 'authenticated') return unavailable();

      if (!response || typeof response !== 'object' || Array.isArray(response)) return unavailable();

      const envelope = response as Record<string, unknown>;
      const data = envelope['data'];

      if (envelope['status'] !== 200 || !data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).sort().join(',') !== 'lease,revocations') return unavailable();

      const signed = data as Record<string, unknown>;

      const decision = Object.freeze({ disposition: 'granted' as const, unavailableReason: null,
        lease: validateSignedSimulatorEntitlementLease(signed['lease']),
        revocations: validateSignedSimulatorEntitlementRevocations(signed['revocations']) });

      this.deliveredScope = { generation, endpoint };

      return decision;
    } catch {
      signal.throwIfAborted();

      return unavailable();
    }
  }

  subscribe(
    listener: (snapshot: SimulatorEntitlementAccountSnapshot) => void,
  ): Readonly<{ close(): void }> {
    if (typeof listener !== 'function') {
      throw new TypeError('Simulator Entitlement account listener is invalid.');
    }
    const subscriptions = new Subscription();
    let closed = false;
    let lastDigest = snapshotDigest(this.readSnapshot());
    const emitIfChanged = () => {
      if (closed) return;
      const snapshot = this.readSnapshot();
      const digest = snapshotDigest(snapshot);
      if (digest === lastDigest) return;
      lastDigest = digest;
      listener(snapshot);
    };
    subscriptions.add(this.auth.authInitializationState$.subscribe(emitIfChanged));
    subscriptions.add(this.auth.isLoggedIn$.subscribe(emitIfChanged));
    window.addEventListener('online', emitIfChanged);
    window.addEventListener('offline', emitIfChanged);
    return Object.freeze({
      close: () => {
        if (closed) return;
        closed = true;
        subscriptions.unsubscribe();
        window.removeEventListener('online', emitIfChanged);
        window.removeEventListener('offline', emitIfChanged);
      },
    });
  }
}

function readConnectivity(): 'online' | 'offline' | 'unknown' {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
    return 'unknown';
  }
  return navigator.onLine ? 'online' : 'offline';
}

function snapshotDigest(snapshot: SimulatorEntitlementAccountSnapshot): string {
  return `${snapshot.state}\0${snapshot.connectivity}`;
}
