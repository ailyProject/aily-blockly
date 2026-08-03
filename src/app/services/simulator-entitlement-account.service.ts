import { Injectable } from '@angular/core';
import { Subscription } from 'rxjs';

import { AuthService } from './auth.service';
import type {
  SimulatorEntitlementAccountPort,
  SimulatorEntitlementAccountSnapshot,
} from '../integrations/simulator/simulator-entitlement-callback-authority';

/** Redacted projection of Blockly account/connectivity state. */
@Injectable({ providedIn: 'root' })
export class SimulatorEntitlementAccountService
implements SimulatorEntitlementAccountPort {
  constructor(private readonly auth: AuthService) {}

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
