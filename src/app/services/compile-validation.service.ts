import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { API } from '../configs/api.config';
import { AuthService } from './auth.service';

interface CompileValidationResponse {
  status?: number;
  data?: {
    validated?: boolean;
    message?: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class CompileValidationService {
  private readonly storageKey = 'aily_compile_validated_users';
  private readonly requestTimeoutMs = 20_000;
  private readonly inFlightUserIds = new Set<string>();
  private readonly completedUserIds = new Set<string>();
  private readonly invitationCheckedUserIds = new Set<string>();

  constructor(
    private authService: AuthService,
    private http: HttpClient,
  ) {
    this.restoreCompletedUserIds();
  }

  triggerAfterSuccessfulCompile(): void {
    void this.validateInBackground();
  }

  private async validateInBackground(): Promise<void> {
    const userIdAtCompile = this.authService.currentUser?.id;
    let tokenAtCompile: string | null;
    try {
      tokenAtCompile = await this.authService.getToken2();
    } catch (error) {
      console.warn('[CompileValidation] 读取认证信息失败:', error);
      return;
    }

    if (!tokenAtCompile) {
      if (this.authService.isAuthenticated) {
        this.logSkip('token-not-ready');
      }
      return;
    }

    if (!this.authService.isAuthenticated) {
      const authState = this.authService.getAuthInitializationState();
      if (authState === 'idle' || authState === 'checking' || authState === 'unavailable') {
        try {
          await this.authService.initializeAuth();
        } catch (error) {
          console.warn('[CompileValidation] 等待认证初始化失败:', error);
        }
      }
    }

    if (!this.authService.isAuthenticated) {
      this.logSkip('auth-not-ready', {
        authState: this.authService.getAuthInitializationState(),
      });
      return;
    }

    let currentUser = this.authService.currentUser;
    const userId = currentUser?.id;

    if (!userId) {
      this.logSkip('user-not-ready');
      return;
    }

    if (userIdAtCompile && userIdAtCompile !== userId) {
      this.logSkip('user-changed-during-auth');
      return;
    }

    if (this.inFlightUserIds.has(userId) || this.completedUserIds.has(userId)) {
      return;
    }

    this.inFlightUserIds.add(userId);

    try {
      if (!currentUser.invitation) {
        if (this.invitationCheckedUserIds.has(userId)) {
          return;
        }

        try {
          await this.authService.refreshMe();
        } catch (error) {
          console.warn('[CompileValidation] 刷新邀请状态失败:', error);
          return;
        }

        currentUser = this.authService.currentUser;
        if (!this.authService.isAuthenticated || currentUser?.id !== userId) {
          this.logSkip('user-changed-during-refresh');
          return;
        }
        this.invitationCheckedUserIds.add(userId);
      }

      const invitation = currentUser.invitation;
      if (!invitation) {
        this.logSkip('invitation-not-ready');
        return;
      }

      if (invitation.is_invited !== true) {
        return;
      }

      if (invitation.compile_validated === true) {
        this.markUserCompleted(userId);
        return;
      }

      const tokenBeforeRequest = await this.authService.getToken2();
      if (
        tokenBeforeRequest !== tokenAtCompile
        || !this.authService.isAuthenticated
        || this.authService.currentUser?.id !== userId
      ) {
        this.logSkip('user-changed-before-request');
        return;
      }

      const response = await firstValueFrom(
        this.http.post<CompileValidationResponse>(
          API.invitationValidateCompile,
          {},
        ).pipe(timeout({ first: this.requestTimeoutMs }))
      );

      const validated = Boolean(response?.data?.validated);
      const message = String(response?.data?.message || '');

      if (validated || message === '已验证过') {
        if (!this.authService.isAuthenticated || this.authService.currentUser?.id !== userId) {
          this.logSkip('user-changed-before-response');
          return;
        }
        this.markUserCompleted(userId);
        void this.authService.refreshMe().catch((error) => {
          console.warn('[CompileValidation] 验证成功后刷新用户状态失败:', error);
        });
      } else {
        this.logSkip('response-not-confirmed', { status: response?.status });
      }
    } catch (error) {
      const reason = error instanceof TimeoutError
        ? 'timeout'
        : error instanceof HttpErrorResponse && error.status === 0
          ? 'network'
          : error instanceof HttpErrorResponse
            ? `http-${error.status}`
            : 'unknown';
      console.warn('[CompileValidation] 编译验证后台上报失败:', { reason, error });
    } finally {
      this.inFlightUserIds.delete(userId);
    }
  }

  private logSkip(reason: string, details: Record<string, unknown> = {}): void {
    console.debug('[CompileValidation] 跳过本次编译验证上报:', { reason, ...details });
  }

  private markUserCompleted(userId: string): void {
    this.completedUserIds.add(userId);
    this.persistCompletedUserIds();
  }

  private restoreCompletedUserIds(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      parsed
        .filter((value) => typeof value === 'string' && value)
        .forEach((userId) => this.completedUserIds.add(userId));
    } catch {
      // Ignore malformed or unavailable local storage.
    }
  }

  private persistCompletedUserIds(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.completedUserIds)));
    } catch {
      // Ignore storage write failures to keep this background task silent.
    }
  }
}
