import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subscription, distinctUntilChanged } from 'rxjs';

import {
  AuthService,
  type AuthInitializationState,
} from '../../../services/auth.service';
import { ElectronService } from '../../../services/electron.service';
import { AilyChatConfigService } from './aily-chat-config.service';

export type ChatRemoteCapabilityState =
  | 'unknown'
  | 'authenticated'
  | 'signed_out'
  | 'offline_cached'
  | 'unavailable';

export interface ChatRemoteCapabilitySnapshot {
  readonly state: ChatRemoteCapabilityState;
  readonly refreshing: boolean;
  readonly reason: string;
  readonly revision: number;
  readonly checkedAt?: number;
}

@Injectable({
  providedIn: 'root',
})
export class ChatRemoteCapabilityService implements OnDestroy {
  private readonly snapshotSubject = new BehaviorSubject<ChatRemoteCapabilitySnapshot>({
    state: 'unknown',
    refreshing: false,
    reason: 'created',
    revision: 0,
  });
  readonly snapshot$ = this.snapshotSubject.asObservable();

  private readonly subscriptions = new Subscription();
  private pendingRefreshReason: string | null = null;
  private refreshDrainPromise: Promise<void> | null = null;
  private retryHandle: ReturnType<typeof setTimeout> | null = null;
  private needsRetry = false;
  private revision = 0;
  private readonly retryDelayMs = 60000;

  private readonly onlineListener = () => {
    void this.refresh('browser-online');
  };
  private readonly offlineListener = () => {
    void this.refresh('browser-offline');
  };
  private readonly focusListener = () => {
    if (this.needsRetry) {
      void this.refresh('window-focus');
    }
  };

  constructor(
    private readonly authService: AuthService,
    private readonly chatConfig: AilyChatConfigService,
    private readonly electronService: ElectronService,
    private readonly ngZone: NgZone,
  ) {
    this.subscriptions.add(
      this.authService.authInitializationState$
        .pipe(distinctUntilChanged())
        .subscribe((state) => this.acceptAuthState(state)),
    );
    this.subscriptions.add(
      this.authService.isLoggedIn$
        .pipe(distinctUntilChanged())
        .subscribe((isLoggedIn) => {
          if (isLoggedIn) {
            this.accept('authenticated', 'auth-login', false);
          }
        }),
    );
    this.subscriptions.add(
      this.electronService.rendererLifecycle$.subscribe((event) => {
        if (event.kind === 'resume') {
          void this.refresh('renderer-resume');
        }
      }),
    );

    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('online', this.onlineListener);
      window.addEventListener('offline', this.offlineListener);
      window.addEventListener('focus', this.focusListener);
    });
    void this.refresh('startup');
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.clearRetry();
    window.removeEventListener('online', this.onlineListener);
    window.removeEventListener('offline', this.offlineListener);
    window.removeEventListener('focus', this.focusListener);
  }

  get snapshot(): ChatRemoteCapabilitySnapshot {
    return this.snapshotSubject.value;
  }

  get canSendRemoteRequests(): boolean {
    return this.snapshot.state === 'authenticated';
  }

  refresh(reason = 'manual'): Promise<void> {
    this.pendingRefreshReason = reason;
    if (this.refreshDrainPromise) {
      return this.refreshDrainPromise;
    }

    const drain = this.drainRefreshRequests();
    this.refreshDrainPromise = drain;
    const clearDrain = () => {
      if (this.refreshDrainPromise === drain) {
        this.refreshDrainPromise = null;
      }
    };
    void drain.then(clearDrain, clearDrain);
    return drain;
  }

  private async drainRefreshRequests(): Promise<void> {
    while (this.pendingRefreshReason) {
      const reason = this.pendingRefreshReason;
      this.pendingRefreshReason = null;
      const onlineAtStart = this.isBrowserOnline();
      await this.inspectRemoteCapability(reason);
      if (this.pendingRefreshReason && this.isBrowserOnline() === onlineAtStart) {
        // Resume/focus/online bursts that observed the same final connectivity
        // state are satisfied by the completed inspection. A connectivity edge
        // still schedules another pass.
        this.pendingRefreshReason = null;
      }
    }
  }

  private async inspectRemoteCapability(reason: string): Promise<void> {
    this.clearRetry();
    const current = this.snapshot;
    this.accept(current.state, reason, true);

    if (!this.isBrowserOnline()) {
      await this.acceptOfflineOrSignedOut(reason);
      return;
    }

    await this.authService.initializeAuth();
    if (!this.isBrowserOnline()) {
      await this.acceptOfflineOrSignedOut(reason);
      return;
    }

    const authState = this.authService.getAuthInitializationState();
    if (authState === 'authenticated' || this.authService.isLoggedIn) {
      this.accept('authenticated', reason, false);
      this.chatConfig.reloadRemoteModelCatalog(`remote-capability:${reason}`);
      return;
    }

    if (authState === 'signed_out') {
      this.accept('signed_out', reason, false);
      return;
    }

    const token = await this.authService.getToken2();
    this.accept(token ? 'unavailable' : 'signed_out', reason, false);
    if (token) {
      this.scheduleRetry();
    }
  }

  private async acceptOfflineOrSignedOut(reason: string): Promise<void> {
    const token = await this.authService.getToken2();
    this.accept(token ? 'offline_cached' : 'signed_out', reason, false);
    if (token) {
      this.scheduleRetry();
    }
  }

  private acceptAuthState(state: AuthInitializationState): void {
    switch (state) {
      case 'authenticated':
        this.accept('authenticated', 'auth-state', false);
        return;
      case 'signed_out':
        this.accept('signed_out', 'auth-state', false);
        return;
      case 'unavailable':
        if (this.isBrowserOnline()) {
          this.accept('unavailable', 'auth-state', false);
        } else {
          void this.acceptOfflineOrSignedOut('auth-state');
        }
        this.scheduleRetry();
        return;
      case 'checking':
        this.accept(this.snapshot.state, 'auth-state', true);
        return;
      case 'idle':
      default:
        return;
    }
  }

  private accept(
    state: ChatRemoteCapabilityState,
    reason: string,
    refreshing: boolean,
  ): void {
    const previous = this.snapshot;
    if (previous.state === state && previous.refreshing === refreshing) {
      return;
    }

    const next: ChatRemoteCapabilitySnapshot = {
      state,
      refreshing,
      reason,
      revision: ++this.revision,
      checkedAt: Date.now(),
    };
    this.snapshotSubject.next(next);
    console.info('[AilyChat][RemoteCapability]', {
      previous: previous.state,
      state,
      refreshing,
      reason,
      revision: next.revision,
    });
  }

  private scheduleRetry(): void {
    this.needsRetry = true;
    this.clearRetryHandle();
    if (!this.isWindowActive()) {
      return;
    }

    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      if (this.needsRetry) {
        void this.refresh('scheduled-retry');
      }
    }, this.retryDelayMs);
  }

  private clearRetry(): void {
    this.needsRetry = false;
    this.clearRetryHandle();
  }

  private clearRetryHandle(): void {
    if (this.retryHandle !== null) {
      clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private isBrowserOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  private isWindowActive(): boolean {
    return typeof document === 'undefined'
      || (document.visibilityState === 'visible' && document.hasFocus());
  }
}
