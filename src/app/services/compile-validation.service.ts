import { Injectable } from '@angular/core';
import { HttpBackend, HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { API } from '../configs/api.config';
import { AuthService, CommonResponse } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class CompileValidationService {
  private readonly storageKey = 'aily_compile_validated_users';
  private readonly requestTimeoutMs = 3000;
  private readonly inFlightUserIds = new Set<string>();
  private readonly completedUserIds = new Set<string>();

  private silentHttp: HttpClient;

  constructor(
    private authService: AuthService,
    httpBackend: HttpBackend,
  ) {
    this.silentHttp = new HttpClient(httpBackend);
    this.restoreCompletedUserIds();
  }

  triggerAfterSuccessfulCompile(): void {
    void this.validateInBackground();
  }

  private async validateInBackground(): Promise<void> {
    if (!this.authService.isAuthenticated) {
      return;
    }

    const token = await this.authService.getToken2();
    if (!token) {
      return;
    }

    const currentUser = this.authService.currentUser;
    const userId = currentUser?.id;
    const invitation = currentUser?.invitation;

    if (!userId || !invitation?.is_invited) {
      return;
    }

    if (invitation.compile_validated) {
      this.markUserCompleted(userId);
      return;
    }

    if (this.inFlightUserIds.has(userId) || this.completedUserIds.has(userId)) {
      return;
    }

    this.inFlightUserIds.add(userId);

    try {
      const response: any = await firstValueFrom(
        this.silentHttp.post<CommonResponse>(
          API.invitationValidateCompile,
          {},
          {
            headers: new HttpHeaders({
              Authorization: `Bearer ${token}`
            })
          }
        ).pipe(timeout(this.requestTimeoutMs))
      );

      const validated = Boolean(response?.data?.validated);
      const message = String(response?.data?.message || '');

      if (validated || message === '已验证过') {
        this.markUserCompleted(userId);
        this.authService.refreshMe();
      }
    } catch (error) {
      console.warn('首次编译验证后台上报失败:', error);
    } finally {
      this.inFlightUserIds.delete(userId);
    }
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