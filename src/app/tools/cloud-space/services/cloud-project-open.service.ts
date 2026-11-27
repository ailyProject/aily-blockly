import { Injectable } from '@angular/core';
import { distinctUntilChanged, filter, firstValueFrom, take } from 'rxjs';
import { AuthService } from '@core/auth/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ProjectService } from '@domain/project/public-api';
import { publishProjectText } from '../../../services/core/platform/project-file-publication';
import { CloudService } from './cloud.service';
import { projectCloudIdentity, writeCloudSyncState } from './cloud-sync-state';

@Injectable({ providedIn: 'root' })
export class CloudProjectOpenService {
  private readonly opening = new Map<string, { promise: Promise<void>; isCurrent?: () => boolean }>();
  private readonly incompleteOpens = new Map<string, { path: string; identity: string; archiveSha256: string; ready: boolean }>();
  private accountEpoch = 0;

  constructor(private cloud: CloudService, private auth: AuthService, private config: ConfigService,
    private projects: ProjectService) {
    this.auth.userInfo$.pipe(distinctUntilChanged((a, b) => a?.id === b?.id))
      .subscribe(() => {
        ++this.accountEpoch;
        this.incompleteOpens.clear();
      });
  }

  open(projectId: string, ownOnly = false, expectedApiOrigin?: string, isCurrent?: () => boolean): Promise<void> {
    const key = JSON.stringify([this.accountEpoch, this.cloud.baseUrl, ownOnly, expectedApiOrigin, projectId]);
    const current = this.opening.get(key);
    if (current && current.isCurrent?.() !== false) return current.promise;
    const operation = this.openProject(projectId, ownOnly, expectedApiOrigin, isCurrent).finally(() => {
      if (this.opening.get(key)?.promise === operation) this.opening.delete(key);
    });
    this.opening.set(key, { promise: operation, isCurrent });
    return operation;
  }

  private async openProject(projectId: string, ownOnly: boolean, expectedApiOrigin?: string, isCurrent?: () => boolean): Promise<void> {
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
      if (isCurrent?.() === false) throw new Error('打开目标已切换');
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
    const scope = JSON.stringify([apiBase, String(accountId)]);
    const key = JSON.stringify([scope, ownOnly, project.id]);
    let target = this.incompleteOpens.get(key);
    if (!target) {
      const archive = await firstValueFrom(this.cloud.openVerifiedProjectArchive(project, ownOnly || project.owner_id === accountId));
      try {
        assertCurrent();
        await this.projects.ensureProjectRootPath();
        assertCurrent();
        const destination = window['path'].join(this.projects.projectRootPath, `Cloud_${crypto.randomUUID()}`);
        const path = this.projects.importProjectDirectory(archive.path, destination, true);
        if (this.projects.getProjectMode(path) !== category) throw new Error(`云工程归档与产品类型不匹配，已保留下载内容：${path}`);
        target = { path, identity: projectCloudIdentity(path), archiveSha256: archive.archiveSha256, ready: false };
        this.incompleteOpens.set(key, target);
      } finally {
        this.cloud.cleanupExtractedFiles(archive.path);
      }
    }
    const { path, identity, archiveSha256 } = target;
    const assertTarget = () => {
      assertCurrent();
      if (!window['fs'].existsSync(path) || projectCloudIdentity(path) !== identity) {
        this.incompleteOpens.delete(key);
        throw new Error('原下载目录已被替换，请重新下载');
      }
    };
    assertTarget();
    try {
      if (!target.ready) {
        const original = window['fs'].readFileSync(window['path'].join(path, 'package.json'), 'utf8');
        const manifest = JSON.parse(original);
        manifest.cloudId = project.id;
        manifest.nickname = project.nickname || manifest.nickname;
        manifest.description = project.description || '';
        manifest.doc_url = project.doc_url || '';
        manifest.keywords = typeof project.tags === 'string' ? JSON.parse(project.tags) : project.tags || [];
        const updated = JSON.stringify(manifest, null, 2);
        if (updated !== original) await publishProjectText(path, 'package.json', updated, original, assertTarget);
        assertTarget();
        writeCloudSyncState(path, { version: 1, identity, scope, binding: { cloudId: String(project.id), archiveSha256 } });
        target.ready = true;
      }
      if (!await this.projects.projectOpen(path)) throw new Error('尚未打开');
    } catch (error) {
      throw new Error(`项目已下载到 ${path}，打开失败：${error instanceof Error ? error.message : error}。可点同一项目继续打开`);
    }
    this.incompleteOpens.delete(key);
  }
}
