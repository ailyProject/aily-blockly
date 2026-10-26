import { Injectable, NgZone } from '@angular/core';
import { AuthService } from '@core/auth/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { getServerUrl } from '../../../configs/api.config';

type MetricsEvent = 'app_opened' | 'project_created' | 'compile_attempted' | 'upload_succeeded';

/** 渲染窗口内的尽力上报；不持久化、不补报，也不影响业务结果。 */
@Injectable({ providedIn: 'root' })
export class MetricsService {
  private sessionId?: string;

  constructor(private config: ConfigService, private auth: AuthService, private zone: NgZone) {}

  record(event: MetricsEvent): void {
    try {
      const occurredAt = new Date().toISOString();
      this.zone.runOutsideAngular(() => {
        void this.send(event, occurredAt).catch(() => undefined);
      });
    } catch { /* 统计异常不能改变业务结果。 */ }
  }

  private async send(event: MetricsEvent, occurredAt: string): Promise<void> {
    await this.config.init();
    if (this.config.data.metricsEnabled === false) return;
    const product = (window as any).electronAPI?.auth?.product;
    if (product !== 'blockly' && product !== 'coder') return;
    const apiBase = getServerUrl().replace(/\/+$/u, '');
    this.sessionId ??= crypto.randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      // 只读取已有凭证，不检查登录状态、不刷新 Token；没有凭证也发送。
      const token = await this.auth.getToken2();
      if (controller.signal.aborted || this.config.data.metricsEnabled === false
        || apiBase !== getServerUrl().replace(/\/+$/u, '')) return;
      await fetch(`${apiBase}/api/v1/metrics/me`, {
        method: 'POST', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ session_id: this.sessionId, product, event, occurred_at: occurredAt }),
      });
    } finally { clearTimeout(timeout); }
  }
}
