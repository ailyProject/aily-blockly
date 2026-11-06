import { HttpClient } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { AuthService } from '@core/auth/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ElectronService } from '@core/platform/public-api';
import { NzMessageService } from 'ng-zorro-antd/message';
import { firstValueFrom, timeout } from 'rxjs';
import { API, getServerUrl } from '../../../configs/api.config';

interface HubDesktopRequest {
  request: string;
  state: string;
  code_challenge: string;
  redirect_uri: string;
  sourceApiUrl: string;
  returnUrl: string;
}

interface PendingHubNavigation {
  request: string;
  accountId: string;
  generation: number;
  accessToken: string | null;
  sourceApiUrl: string;
  hubOrigin: string;
  returnUrl: string;
  product: string;
  expiresAt: number;
  consumed: boolean;
}

@Injectable({ providedIn: 'root' })
export class HubNavigationService implements OnDestroy {
  private pending: PendingHubNavigation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly removeListener?: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly electron: ElectronService,
    private readonly http: HttpClient,
    private readonly message: NzMessageService,
    zone: NgZone,
  ) {
    this.removeListener = this.bridge?.onAuthorize((request: HubDesktopRequest) => {
      zone.run(() => { void this.authorize(request); });
    });
  }

  private get bridge() { return window['electronAPI']?.hubDesktop; }

  async open(path: string): Promise<void> {
    if (this.pending && this.isCurrent(this.pending)) return;
    this.clear();
    let pending: PendingHubNavigation;
    try {
      const target = new URL(this.config.getHubWebUrl(path));
      if (!this.auth.isLoggedIn) {
        if (target.pathname !== '/projects') throw new Error();
        this.electron.openUrl(target.toString());
        return;
      }
      if (!this.bridge || this.auth.isSessionInvalidating || !this.auth.currentUser?.id) throw new Error();
      pending = {
        request: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
        accountId: this.auth.currentUser.id,
        generation: this.auth.getAuthCredentialGeneration(),
        accessToken: null,
        sourceApiUrl: getServerUrl().replace(/\/+$/, ''),
        hubOrigin: target.origin,
        returnUrl: target.pathname + target.search,
        product: this.config.isCoderProduct() ? 'coder' : 'blockly',
        expiresAt: Date.now() + 120_000,
        consumed: false,
      };
      this.pending = pending;
      pending.accessToken = await this.auth.getToken2();
      if (new URL(pending.sourceApiUrl).origin !== pending.sourceApiUrl
        || !pending.accessToken || !this.isCurrent(pending)) throw new Error();
      const identity = await firstValueFrom(this.http.get<{ status: number; data: { id: string } }>(API.me)
        .pipe(timeout(12_000)));
      if (identity.status !== 200 || identity.data?.id !== pending.accountId
        || await this.auth.getToken2() !== pending.accessToken || !this.isCurrent(pending)) throw new Error();
      if (!await this.bridge.begin(pending.request) || !this.isCurrent(pending)) throw new Error();
      this.timer = setTimeout(() => this.clear(pending), 120_000);
      const desktop = new URL('/auth/desktop', pending.hubOrigin);
      for (const key of ['request', 'sourceApiUrl', 'product', 'returnUrl'] as const) desktop.searchParams.set(key, pending[key]);
      this.electron.openUrl(desktop.toString());
    } catch {
      if (!pending || this.pending === pending) {
        this.clear(pending);
        this.message.error('无法使用当前客户端账号打开 Hub，请重试。');
      }
    }
  }

  private isCurrent(pending: PendingHubNavigation): boolean {
    return this.pending === pending && pending.expiresAt > Date.now()
      && this.auth.isLoggedIn && !this.auth.isSessionInvalidating
      && this.auth.currentUser?.id === pending.accountId
      && this.auth.getAuthCredentialGeneration() === pending.generation
      && getServerUrl().replace(/\/+$/, '') === pending.sourceApiUrl
      && new URL(this.config.getHubWebUrl()).origin === pending.hubOrigin
      && (this.config.isCoderProduct() ? 'coder' : 'blockly') === pending.product;
  }

  private async authorize(request: HubDesktopRequest): Promise<void> {
    const pending = this.pending;
    if (!pending || request?.request !== pending.request || pending.consumed) return;
    pending.consumed = true;
    try {
      if (await this.auth.getToken2() !== pending.accessToken || !this.isCurrent(pending)
        || request.sourceApiUrl !== pending.sourceApiUrl
        || request.returnUrl !== pending.returnUrl
        || request.redirect_uri !== `${pending.hubOrigin}/auth/callback`
        || !/^[A-Za-z0-9_-]{32,256}$/.test(request.state)
        || !/^[A-Za-z0-9_-]{43}$/.test(request.code_challenge)) throw new Error();
      const result = await firstValueFrom(this.http.post<{ status: number; data: { redirect_url: string } }>(API.hubAuthorize, {
        client_id: 'aily-hub',
        redirect_uri: request.redirect_uri,
        state: request.state,
        code_challenge: request.code_challenge,
        code_challenge_method: 'S256',
        scope: 'identity workspace:read',
        approved: true,
      }).pipe(timeout(15_000)));
      if (await this.auth.getToken2() !== pending.accessToken || !this.isCurrent(pending)) return;
      const redirect = new URL(result?.data?.redirect_url);
      const keys = Array.from(redirect.searchParams.keys());
      if (result.status !== 200 || redirect.origin !== pending.hubOrigin || redirect.pathname !== '/auth/callback'
        || redirect.username || redirect.password || redirect.hash
        || keys.length !== 2 || !keys.includes('code') || !keys.includes('state')
        || !redirect.searchParams.get('code') || redirect.searchParams.get('state') !== request.state) throw new Error();
      const desktop = new URL('/auth/desktop', pending.hubOrigin);
      desktop.search = redirect.search;
      this.electron.openUrl(desktop.toString());
    } catch {
      if (this.pending === pending) this.message.error('Hub 账号交接失败，请从客户端重新打开。');
    } finally {
      this.clear(pending);
    }
  }

  private clear(expected?: PendingHubNavigation): void {
    if (expected && this.pending !== expected) return;
    const request = this.pending?.request;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (request) void this.bridge?.cancel(request).catch(() => {});
  }

  ngOnDestroy(): void { this.clear(); this.removeListener?.(); }
}
