import { Injectable } from '@angular/core';
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  map,
  shareReplay,
  type Observable,
} from 'rxjs';

import { AILY_CODER_EDITOR_SUBAPP_ID } from '../../../configs/required-subapp.config';
import {
  ChildToolProcessService,
  type ChildToolRuntimeSnapshot,
} from './child-tool-process.service';
import {
  SubappManagerService,
  type SubappCatalogItem,
  type SubappInstallProgress,
  type SubappUpdateState,
} from './subapp-manager.service';

export interface CoderEditorUpdateState {
  state: SubappUpdateState | 'restart-required';
  visible: boolean;
  busy: boolean;
  actionable: boolean;
  progress: number;
  installedVersion: string;
  availableVersion: string;
  error?: string;
}

export interface CoderEditorUpdateClient {
  prepareForUpdate(): Promise<void>;
  reloadAfterUpdate(): Promise<void>;
}

const CURRENT_STATE: CoderEditorUpdateState = {
  state: 'current',
  visible: false,
  busy: false,
  actionable: false,
  progress: 0,
  installedVersion: '',
  availableVersion: '',
};

function version(value: unknown): string {
  return String(value || '').trim();
}

export function resolveCoderEditorUpdateState(
  item: SubappCatalogItem | undefined,
  runtime: ChildToolRuntimeSnapshot,
  operationBusy: boolean,
  progress: SubappInstallProgress | null,
): CoderEditorUpdateState {
  if (!item?.installed) return CURRENT_STATE;

  const installedVersion = version(item.installedVersion);
  const availableVersion = version(item.availableVersion);
  const runningVersion = runtime.running ? version(runtime.version) : '';
  const preparedVersion = item.updateStatus.ready === true || item.updateStatus.state === 'ready'
    ? availableVersion
    : '';
  const restartRequired = !!runningVersion
    && (preparedVersion
      ? runningVersion !== preparedVersion
      : !!installedVersion && runningVersion !== installedVersion);
  const matchingProgress = progress?.id === item.id ? progress : null;
  const progressBusy = matchingProgress != null
    && matchingProgress.phase !== 'complete'
    && matchingProgress.phase !== 'error';
  const busy = operationBusy
    || progressBusy
    || item.updateStatus.state === 'downloading'
    || item.updateStatus.state === 'installing'
    || (item.updateStatus.state === 'available' && !!item.updatePolicy);
  const state = restartRequired
    ? 'restart-required'
    : item.updateStatus.state;
  const actionable = !busy && (
    restartRequired
    || state === 'ready'
    || state === 'failed'
    || (!item.updatePolicy && item.updateAvailable)
  );

  return {
    state,
    visible: restartRequired || item.updateAvailable || state !== 'current' || busy,
    busy,
    actionable,
    progress: Math.max(0, Math.min(100, Math.round(
      Number(matchingProgress?.percent ?? item.updateStatus.progress ?? 0),
    ))),
    installedVersion,
    availableVersion,
    ...(item.updateStatus.error ? { error: item.updateStatus.error } : {}),
  };
}

@Injectable({ providedIn: 'root' })
export class CoderEditorUpdateService {
  private readonly operationBusySubject = new BehaviorSubject(false);
  private readonly clients = new Set<CoderEditorUpdateClient>();
  private startupTask: Promise<boolean> | null = null;
  private startupChecked = false;
  private updateTask: Promise<boolean> | null = null;

  readonly state$: Observable<CoderEditorUpdateState>;

  constructor(
    private readonly subappManager: SubappManagerService,
    private readonly childToolProcess: ChildToolProcessService,
  ) {
    this.state$ = combineLatest([
      this.subappManager.state$,
      this.subappManager.progress$,
      this.childToolProcess.runtimeStates$,
      this.operationBusySubject,
    ]).pipe(
      map(([catalog, progress, , operationBusy]) => resolveCoderEditorUpdateState(
        catalog.apps.find(item => item.toolId === AILY_CODER_EDITOR_SUBAPP_ID),
        this.childToolProcess.getRuntimeSnapshot(AILY_CODER_EDITOR_SUBAPP_ID),
        operationBusy,
        progress,
      )),
      distinctUntilChanged((previous, current) => JSON.stringify(previous) === JSON.stringify(current)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }

  registerClient(client: CoderEditorUpdateClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  /**
   * Coder 启动门禁：远端目录确认有新版本后，在首次 Runtime acquire 前完成安装。
   * 网络或更新失败不阻断旧版本启动，失败状态仍留在目录中供顶栏重试。
   */
  ensureUpdatedBeforeLaunch(): Promise<boolean> {
    if (this.startupChecked) return Promise.resolve(false);
    if (this.startupTask) return this.startupTask;
    const task = this.performStartupUpdate()
      .catch((error) => {
        console.warn('[Subapp] Aily Coder Editor startup update failed; continuing with the installed version:', error);
        return false;
      })
      .finally(() => {
        this.startupChecked = true;
        if (this.startupTask === task) this.startupTask = null;
      });
    this.startupTask = task;
    return task;
  }

  updateAndRestart(): Promise<boolean> {
    if (this.updateTask) return this.updateTask;
    const task = this.performInteractiveUpdate().finally(() => {
      if (this.updateTask === task) this.updateTask = null;
    });
    this.updateTask = task;
    return task;
  }

  private async performStartupUpdate(): Promise<boolean> {
    this.operationBusySubject.next(true);
    try {
      await this.subappManager.initialize();
      await this.subappManager.refresh(true);
      let item = this.findItem();
      if (!item?.installed) return false;

      item = await this.finishBackgroundDownload(item);
      if (!this.hasInstallableUpdate(item)) return false;

      if (this.childToolProcess.getRuntimeSnapshot(AILY_CODER_EDITOR_SUBAPP_ID).running) {
        await this.childToolProcess.forceStop(AILY_CODER_EDITOR_SUBAPP_ID);
      }
      await this.installAvailableUpdate(item, true);
      return true;
    } finally {
      this.operationBusySubject.next(false);
    }
  }

  private async performInteractiveUpdate(): Promise<boolean> {
    this.operationBusySubject.next(true);
    const clients = [...this.clients];
    let runtimeStopped = false;
    let updateCompleted = false;
    try {
      await this.subappManager.initialize();
      let item = this.findItem();
      if (!item?.installed) return false;

      item = await this.finishBackgroundDownload(item);
      const runtime = this.childToolProcess.getRuntimeSnapshot(AILY_CODER_EDITOR_SUBAPP_ID);
      const restartRequired = runtime.running
        && !!version(runtime.version)
        && !!version(item.installedVersion)
        && version(runtime.version) !== version(item.installedVersion);
      if (!restartRequired && !this.hasInstallableUpdate(item)) return false;

      await Promise.all(clients.map(client => client.prepareForUpdate()));
      await this.childToolProcess.forceStop(AILY_CODER_EDITOR_SUBAPP_ID);
      runtimeStopped = true;

      if (this.hasInstallableUpdate(item)) {
        await this.installAvailableUpdate(item, true);
      }
      updateCompleted = true;
      return true;
    } finally {
      let reloadError: unknown;
      if (runtimeStopped) {
        const results = await Promise.allSettled(
          clients.map(client => client.reloadAfterUpdate()),
        );
        const failed = results.find(result => result.status === 'rejected');
        if (clients.length === 0) {
          try {
            await this.childToolProcess.restart(AILY_CODER_EDITOR_SUBAPP_ID);
          } catch (error) {
            reloadError = error;
          }
        }
        if (failed?.status === 'rejected' && !updateCompleted) {
          console.warn('[Subapp] An Aily Coder Editor surface failed to reload after update:', failed.reason);
        }
        if (updateCompleted && failed?.status === 'rejected') {
          reloadError = failed.reason || new Error('Aily Coder Editor 更新后重载失败');
        }
        if (updateCompleted && !reloadError) {
          const expectedVersion = version(this.findItem()?.installedVersion);
          const runtime = this.childToolProcess.getRuntimeSnapshot(AILY_CODER_EDITOR_SUBAPP_ID);
          if (!runtime.running || (expectedVersion && version(runtime.version) !== expectedVersion)) {
            reloadError = new Error(
              `Aily Coder Editor 运行版本校验失败：应为 ${expectedVersion || '已安装版本'}，实际为 ${version(runtime.version) || '未运行'}`,
            );
          }
        }
        if (!updateCompleted && reloadError) {
          console.warn('[Subapp] Aily Coder Editor failed to recover its previous Runtime:', reloadError);
        }
      }
      this.operationBusySubject.next(false);
      if (updateCompleted && reloadError) throw reloadError;
    }
  }

  private async finishBackgroundDownload(item: SubappCatalogItem): Promise<SubappCatalogItem> {
    if (!item.updatePolicy || item.updateStatus.ready === true || item.updateStatus.state === 'ready') {
      return item;
    }
    if (
      item.updateAvailable
      || item.updateStatus.state === 'available'
      || item.updateStatus.state === 'downloading'
      || item.updateStatus.state === 'failed'
    ) {
      await this.subappManager.downloadUpdate(item.id);
      return this.findItem() || item;
    }
    return item;
  }

  private hasInstallableUpdate(item: SubappCatalogItem): boolean {
    return item.updatePolicy
      ? item.updateStatus.ready === true || item.updateStatus.state === 'ready'
      : item.updateAvailable;
  }

  private async installAvailableUpdate(
    item: SubappCatalogItem,
    forceClose: boolean,
  ): Promise<void> {
    if (item.updatePolicy) {
      await this.subappManager.installUpdate(item.id, { forceClose });
      return;
    }
    await this.subappManager.update(item.id, { forceClose });
  }

  private findItem(): SubappCatalogItem | undefined {
    return this.subappManager.state.apps.find(
      item => item.toolId === AILY_CODER_EDITOR_SUBAPP_ID,
    );
  }
}
