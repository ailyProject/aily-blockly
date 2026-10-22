import { Injectable } from '@angular/core';
import { distinctUntilChanged, filter, firstValueFrom, take } from 'rxjs';
import { AuthService } from '@core/auth/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ProjectService } from '@domain/project/public-api';
import { CloudService } from './cloud.service';
import { writeCloudSyncBaseline } from './cloud-sync-baseline';

@Injectable({ providedIn: 'root' })
export class CloudProjectOpenService {
  private readonly opening = new Map<string, Promise<void>>();
  private accountEpoch = 0;

  constructor(private cloud: CloudService, private auth: AuthService, private config: ConfigService,
    private projects: ProjectService) {
    this.auth.userInfo$.pipe(distinctUntilChanged((a, b) => a?.id === b?.id))
      .subscribe(() => ++this.accountEpoch);
  }

  open(projectId: string, ownOnly = false, expectedApiOrigin?: string): Promise<void> {
    const key = `${ownOnly}:${expectedApiOrigin || ''}:${projectId}`;
    const current = this.opening.get(key);
    if (current) return current;
    const operation = this.openProject(projectId, ownOnly, expectedApiOrigin).finally(() => this.opening.delete(key));
    this.opening.set(key, operation);
    return operation;
  }

  private async openProject(projectId: string, ownOnly: boolean, expectedApiOrigin?: string): Promise<void> {
    if (['idle', 'checking'].includes(this.auth.getAuthInitializationState())) {
      await firstValueFrom(this.auth.authInitializationState$.pipe(
        filter(state => state !== 'idle' && state !== 'checking'), take(1)));
    }
    const accountId = this.auth.userInfo?.id;
    if (!accountId || !this.auth.isLoggedIn) {
      this.auth.requestLogin('cloud-project-open');
      throw new Error('请先登录保存该工程的账号，再重新打开云工程');
    }
    const epoch = this.accountEpoch, apiBase = this.cloud.baseUrl;
    if (expectedApiOrigin && new URL(apiBase).origin !== expectedApiOrigin) {
      throw new Error('客户端服务区域与网页不一致，请切换到相同区域后重新打开');
    }
    const assertCurrent = () => {
      if (epoch !== this.accountEpoch || this.auth.userInfo?.id !== accountId || this.cloud.baseUrl !== apiBase
        || this.auth.isSessionInvalidating) throw new Error('账号或服务区域已切换，请重新打开云工程');
    };
    const response = await firstValueFrom(this.cloud.getProject(projectId, ownOnly));
    assertCurrent();
    if (response.status !== 200 || !response.data) throw new Error('找不到云工程，请确认客户端账号及服务区域与网页一致');
    const project = response.data;
    if (ownOnly && String(project.uuid).toLowerCase() !== projectId.toLowerCase()) {
      throw new Error('云工程标识不匹配，请在客户端确认工程后重新同步');
    }
    if (ownOnly && project.owner_id !== accountId) throw new Error('请使用保存该工程的账号打开');
    const category = this.config.isCoderProduct() ? 'coder' : 'blockly';
    if (project.category !== category) throw new Error(`请使用 Aily ${project.category === 'coder' ? 'Coder' : 'Blockly'} 打开该工程`);
    const archive = await firstValueFrom(this.cloud.openVerifiedProjectArchive(project, ownOnly || project.owner_id === accountId));
    assertCurrent();
    await this.projects.ensureProjectRootPath();
    assertCurrent();
    const target = window['path'].join(this.projects.projectRootPath, `Cloud_${crypto.randomUUID()}`);
    window['fs'].importProjectDirectory(archive.path, target, true);
    assertCurrent();
    if (this.projects.getProjectMode(target) !== category) throw new Error('云工程归档与产品类型不匹配，已保留下载内容');
    const manifestPath = window['path'].join(target, 'package.json');
    const manifest = JSON.parse(window['fs'].readFileSync(manifestPath, 'utf8'));
    manifest.cloudId = project.id;
    manifest.nickname = project.nickname || manifest.nickname;
    manifest.description = project.description || '';
    manifest.doc_url = project.doc_url || '';
    manifest.keywords = typeof project.tags === 'string' ? JSON.parse(project.tags) : project.tags || [];
    window['fs'].writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeCloudSyncBaseline(target, { cloudId: String(project.id), accountId, apiBase, archiveSha256: archive.sha256 });
    assertCurrent();
    await this.projects.projectOpen(target);
  }
}
