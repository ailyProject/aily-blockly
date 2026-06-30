import { Injectable } from '@angular/core';
import { AilyHost } from '../core/host';
import { runHostGitCommand } from '../helpers/git-host-command';
import type {
  IWorkspaceCheckpointProvider,
  RollbackResult,
  WorkspaceCheckpointAvailabilityDetail,
  WorkspaceCheckpointRefMetadata,
  WorkspaceCheckpointDescriptor,
  WorkspaceCheckpointForkRequest,
  WorkspaceCheckpointPresentationMode,
} from './edit-checkpoint.service';
import { EditingContentStore } from './editing-content-store.service';
import type { GitCheckpointApplyTarget, RestorePlan } from './editing-timeline.types';

const CHECKPOINT_REF_PREFIX = 'refs/sessions/';

interface PersistedWorkspaceCheckpointRecord extends WorkspaceCheckpointDescriptor {
  requestOrdinal: number;
  startCheckpointRef?: string;
  completedCheckpointRef?: string;
  additionalStartCheckpointRefs?: Record<string, string>;
  additionalCompletedCheckpointRefs?: Record<string, string>;
  createdAt: number;
  completedAt?: number;
}

interface PersistedWorkspaceCheckpointState {
  version: 1;
  sessionId: string;
  workspaceRoot: string;
  repositoryRoot: string;
  firstCheckpointRef?: string;
  lastCheckpointRef?: string;
  checkpoints: PersistedWorkspaceCheckpointRecord[];
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class GitWorkspaceCheckpointProviderService implements IWorkspaceCheckpointProvider {
  private readonly contentStore = new EditingContentStore({
    joinPath: (...parts: string[]) => AilyHost.get().path.join(...parts),
  });
  private sessionId: string | null = null;
  private workspaceRoot: string | null = null;
  private repositoryRootCache = new Map<string, string | null>();
  private availabilityDetailByWorkspaceRoot = new Map<string, WorkspaceCheckpointAvailabilityDetail>();
  private presentationModeWarmups = new Set<string>();
  private queued = Promise.resolve();
  private fallbackProvider: IWorkspaceCheckpointProvider | null = null;

  setContext(sessionId: string | null, workspaceRoot: string | null): void {
    this.sessionId = sessionId;
    this.workspaceRoot = workspaceRoot;
    this.fallbackProvider?.setContext?.(sessionId, workspaceRoot);
    this.warmPresentationModeCache(workspaceRoot);
  }

  setFallbackProvider(provider: IWorkspaceCheckpointProvider): void {
    this.fallbackProvider = provider;
    provider.setContext?.(this.sessionId, this.workspaceRoot);
  }

  clear(): void {
    this.sessionId = null;
    this.workspaceRoot = null;
  }

  private warmPresentationModeCache(workspaceRoot: string | null): void {
    if (!workspaceRoot || this.repositoryRootCache.has(workspaceRoot) || this.presentationModeWarmups.has(workspaceRoot)) {
      return;
    }

    this.presentationModeWarmups.add(workspaceRoot);
    void Promise.resolve()
      .then(() => {
        if (this.workspaceRoot !== workspaceRoot || this.repositoryRootCache.has(workspaceRoot)) {
          return;
        }
        return this.ensurePresentationMode();
      })
      .catch(error => {
        this.logCheckpointDiagnostic('error', `presentation mode warm-up failed: workspaceRoot=${workspaceRoot}`, error);
      })
      .finally(() => {
        this.presentationModeWarmups.delete(workspaceRoot);
      });
  }

  getPresentationMode(): WorkspaceCheckpointPresentationMode {
    const workspaceRoot = this.workspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!workspaceRoot) {
      this.setAvailabilityDetail(null, { mode: 'unknown', reason: 'no-workspace', message: '未打开工作区' });
      return 'unknown';
    }

    if (!this.repositoryRootCache.has(workspaceRoot)) {
      return this.getFallbackPresentationMode();
    }

    return this.repositoryRootCache.get(workspaceRoot)
      ? 'git'
      : this.getFallbackPresentationMode();
  }

  async ensurePresentationMode(): Promise<WorkspaceCheckpointPresentationMode> {
    const workspaceRoot = this.workspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!workspaceRoot) {
      this.logCheckpointDiagnostic('warn', 'ensurePresentationMode skipped: no workspace root');
      return 'unknown';
    }

    if (!this.repositoryRootCache.has(workspaceRoot)) {
      const sessionId = this.sessionId ?? '__presentation_probe__';
      this.logCheckpointDiagnostic('info', `ensurePresentationMode probing repository context: session=${sessionId}; workspaceRoot=${workspaceRoot}`);
      await this.resolveRepositoryContextForSession(sessionId);
    }

    const mode = this.getPresentationMode();
    const detail = this.getAvailabilityDetail();
    this.logCheckpointDiagnostic(
      mode === 'git' ? 'info' : 'warn',
      `ensurePresentationMode result: mode=${mode}; reason=${detail.reason ?? 'none'}; message=${detail.message ?? ''}; workspaceRoot=${workspaceRoot}`,
    );
    return mode;
  }

  getAvailabilityDetail(): WorkspaceCheckpointAvailabilityDetail {
    const workspaceRoot = this.workspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!workspaceRoot) {
      return { mode: 'unknown', reason: 'no-workspace', message: '未打开工作区' };
    }

    const existing = this.availabilityDetailByWorkspaceRoot.get(workspaceRoot);
    if (existing) {
      return existing;
    }

    const mode = this.getPresentationMode();
    if (mode === 'timeline') {
      return this.fallbackProvider?.getAvailabilityDetail?.() ?? { mode: 'timeline' };
    }
    if (mode === 'unknown') {
      return {
        mode,
        reason: 'timeline-unavailable',
        message: 'Git repository cache is unavailable and timeline checkpoint is not ready',
      };
    }
    return { mode };
  }

  private getFallbackPresentationMode(): WorkspaceCheckpointPresentationMode {
    return this.fallbackProvider?.getPresentationMode?.() ?? 'unknown';
  }

  async initializeRepository(): Promise<WorkspaceCheckpointPresentationMode> {
    const workspaceRoot = this.workspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!workspaceRoot) {
      this.setAvailabilityDetail(null, { mode: 'unknown', reason: 'no-workspace', message: '未打开工作区' });
      return 'unknown';
    }

    const currentMode = await this.ensurePresentationMode();
    if (currentMode === 'git') {
      return currentMode;
    }

    this.logCheckpointDiagnostic('info', `initializing git repository for checkpoint support: workspaceRoot=${workspaceRoot}`);
    try {
      await this.runGit(['init', '-b', 'main'], workspaceRoot);
    } catch (error) {
      this.logCheckpointDiagnostic('warn', `git init -b main failed; retrying plain git init: workspaceRoot=${workspaceRoot}`, error);
      await this.runGit(['init'], workspaceRoot);
    }

    this.repositoryRootCache.delete(workspaceRoot);
    this.availabilityDetailByWorkspaceRoot.delete(workspaceRoot);
    return await this.ensurePresentationMode();
  }

  createCheckpoint(descriptor: WorkspaceCheckpointDescriptor): Promise<WorkspaceCheckpointRefMetadata | null | void> {
    return this.enqueue(async () => {
      const context = await this.resolveRepositoryContext();
      if (!context) {
        return await Promise.resolve(this.fallbackProvider?.createCheckpoint(descriptor) ?? null);
      }

      const state = await this.ensureCheckpointRecord(context, descriptor);
      this.saveState(state);
      const record = state.checkpoints.find(checkpoint => checkpoint.checkpointId === descriptor.checkpointId);
      return record ? this.toCheckpointRefMetadata(context, record) : null;
    });
  }

  completeCheckpoint(descriptor: WorkspaceCheckpointDescriptor): Promise<WorkspaceCheckpointRefMetadata | null | void> {
    return this.enqueue(async () => {
      const context = await this.resolveRepositoryContext();
      if (!context) {
        return await Promise.resolve(this.fallbackProvider?.completeCheckpoint?.(descriptor) ?? null);
      }

      const state = await this.ensureCheckpointRecord(context, descriptor, this.loadState(context) ?? this.createEmptyState(context));

      const record = state.checkpoints.find(checkpoint => checkpoint.checkpointId === descriptor.checkpointId);
      if (!record || record.completedCheckpointRef) {
        return;
      }

      const completedRef = await this.createGitCheckpoint(context, record.requestOrdinal, record.startCheckpointRef);
      record.completedCheckpointRef = completedRef;
      if (record.additionalStartCheckpointRefs) {
        const additionalCompletedCheckpointRefs = {
          ...(record.additionalCompletedCheckpointRefs ?? {}),
        };
        for (const [repositoryRoot, startCheckpointRef] of Object.entries(record.additionalStartCheckpointRefs)) {
          if (additionalCompletedCheckpointRefs[repositoryRoot]) {
            continue;
          }

          additionalCompletedCheckpointRefs[repositoryRoot] = await this.createGitCheckpoint(
            { ...context, repositoryRoot },
            record.requestOrdinal,
            startCheckpointRef,
          );
        }
        if (Object.keys(additionalCompletedCheckpointRefs).length > 0) {
          record.additionalCompletedCheckpointRefs = additionalCompletedCheckpointRefs;
        }
      }
      record.completedAt = Date.now();
      state.lastCheckpointRef = completedRef;
      state.updatedAt = Date.now();
      this.saveState(state);
      return this.toCheckpointRefMetadata(context, record);
    });
  }

  async getCheckpointMetadata(checkpointId: string): Promise<WorkspaceCheckpointRefMetadata | null> {
    await this.waitForPendingCheckpointMutations();
    const context = await this.resolveRepositoryContext();
    if (!context) {
      return await Promise.resolve(this.fallbackProvider?.getCheckpointMetadata?.(checkpointId) ?? null);
    }

    const state = this.loadState(context);
    const record = state?.checkpoints.find(checkpoint => checkpoint.checkpointId === checkpointId);
    return record ? this.toCheckpointRefMetadata(context, record) : null;
  }

  replaceCheckpoints(descriptors: readonly WorkspaceCheckpointDescriptor[]): Promise<void> {
    return this.enqueue(async () => {
      const context = await this.resolveRepositoryContext();
      if (!context) {
        await Promise.resolve(this.fallbackProvider?.replaceCheckpoints(descriptors));
        return;
      }

      const existingState = this.loadState(context) ?? this.createEmptyState(context);
      const existingById = new Map(existingState.checkpoints.map(checkpoint => [checkpoint.checkpointId, checkpoint]));
      existingState.checkpoints = descriptors.map((descriptor, index) => {
        const existing = existingById.get(descriptor.checkpointId);
        const additionalRepositoryRoots = this.normalizeAdditionalRepositoryRoots(descriptor.additionalRepositoryRoots, context.repositoryRoot);
        const additionalStartCheckpointRefs = this.filterAdditionalCheckpointRefs(existing?.additionalStartCheckpointRefs, additionalRepositoryRoots);
        const additionalCompletedCheckpointRefs = this.filterAdditionalCheckpointRefs(existing?.additionalCompletedCheckpointRefs, additionalRepositoryRoots);
        return {
          ...descriptor,
          requestOrdinal: index + 1,
          ...(existing?.startCheckpointRef ? { startCheckpointRef: existing.startCheckpointRef } : {}),
          ...(existing?.completedCheckpointRef ? { completedCheckpointRef: existing.completedCheckpointRef } : {}),
          ...(additionalStartCheckpointRefs ? { additionalStartCheckpointRefs } : {}),
          ...(additionalCompletedCheckpointRefs ? { additionalCompletedCheckpointRefs } : {}),
          createdAt: existing?.createdAt ?? Date.now(),
          ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
        };
      });
      const firstCheckpointRef = existingState.checkpoints[0]?.startCheckpointRef;
      const lastCheckpointRef = [...existingState.checkpoints]
        .reverse()
        .find(checkpoint => !!checkpoint.completedCheckpointRef)
        ?.completedCheckpointRef;
      existingState.firstCheckpointRef = firstCheckpointRef;
      existingState.lastCheckpointRef = lastCheckpointRef ?? firstCheckpointRef;
      existingState.updatedAt = Date.now();
      this.saveState(existingState);
    });
  }

  forkCheckpoints(request: WorkspaceCheckpointForkRequest): Promise<WorkspaceCheckpointRefMetadata[] | null> {
    return this.enqueue(async () => {
      const context = await this.resolveRepositoryContextForSession(request.sourceSessionResource);
      if (!context) {
        return await Promise.resolve(this.fallbackProvider?.forkCheckpoints?.(request) ?? null);
      }

      const sourceState = this.loadState(context);
      if (!sourceState) {
        return null;
      }

      const checkpointIds = request.checkpointIds
        .map(checkpointId => checkpointId.trim())
        .filter(checkpointId => checkpointId.length > 0);
      const sourceByCheckpointId = new Map(sourceState.checkpoints.map(checkpoint => [checkpoint.checkpointId, checkpoint]));
      const retainedRecords = checkpointIds.map(checkpointId => sourceByCheckpointId.get(checkpointId));
      if (retainedRecords.some(record => !record)) {
        return null;
      }

      const targetSessionId = request.targetSessionResource.trim();
      if (!targetSessionId) {
        return null;
      }

      const targetContext = {
        ...context,
        sessionId: targetSessionId,
      };
      const now = Date.now();
      const targetState: PersistedWorkspaceCheckpointState = {
        version: 1,
        sessionId: targetSessionId,
        workspaceRoot: context.workspaceRoot,
        repositoryRoot: context.repositoryRoot,
        checkpoints: [],
        createdAt: now,
        updatedAt: now,
      };

      const firstSourceRef = retainedRecords[0]?.startCheckpointRef ?? sourceState.firstCheckpointRef;
      if (firstSourceRef) {
        const targetFirstRef = this.getCheckpointRef(targetSessionId, 0);
        await this.copyGitRef(context.repositoryRoot, firstSourceRef, targetFirstRef);
        targetState.firstCheckpointRef = targetFirstRef;
        targetState.lastCheckpointRef = targetFirstRef;
      }

      for (const [index, sourceRecord] of retainedRecords.entries()) {
        if (!sourceRecord) {
          return null;
        }

        const requestOrdinal = index + 1;
        const targetStartCheckpointRef = await this.copyPrimaryCheckpointRefForFork(
          context.repositoryRoot,
          sourceRecord.startCheckpointRef,
          targetSessionId,
          requestOrdinal - 1,
          targetState.firstCheckpointRef,
        );
        const targetCompletedCheckpointRef = await this.copyPrimaryCheckpointRefForFork(
          context.repositoryRoot,
          sourceRecord.completedCheckpointRef,
          targetSessionId,
          requestOrdinal,
        );
        const additionalStartCheckpointRefs = await this.copyAdditionalCheckpointRefsForFork(
          sourceRecord.additionalStartCheckpointRefs,
          targetSessionId,
          requestOrdinal - 1,
        );
        const additionalCompletedCheckpointRefs = await this.copyAdditionalCheckpointRefsForFork(
          sourceRecord.additionalCompletedCheckpointRefs,
          targetSessionId,
          requestOrdinal,
        );

        const additionalRepositoryRoots = this.normalizeAdditionalRepositoryRoots([
          ...(sourceRecord.additionalRepositoryRoots ?? []),
          ...Object.keys(additionalStartCheckpointRefs ?? {}),
          ...Object.keys(additionalCompletedCheckpointRefs ?? {}),
        ], context.repositoryRoot);

        targetState.checkpoints.push({
          checkpointId: sourceRecord.checkpointId,
          requestId: sourceRecord.requestId,
          ...(sourceRecord.turnId ? { turnId: sourceRecord.turnId } : {}),
          label: sourceRecord.label,
          ...(additionalRepositoryRoots.length > 0 ? { additionalRepositoryRoots } : {}),
          requestOrdinal,
          ...(targetStartCheckpointRef ? { startCheckpointRef: targetStartCheckpointRef } : {}),
          ...(targetCompletedCheckpointRef ? { completedCheckpointRef: targetCompletedCheckpointRef } : {}),
          ...(additionalStartCheckpointRefs ? { additionalStartCheckpointRefs } : {}),
          ...(additionalCompletedCheckpointRefs ? { additionalCompletedCheckpointRefs } : {}),
          createdAt: sourceRecord.createdAt,
          ...(sourceRecord.completedAt ? { completedAt: sourceRecord.completedAt } : {}),
        });

        if (targetCompletedCheckpointRef) {
          targetState.lastCheckpointRef = targetCompletedCheckpointRef;
        }
      }

      this.saveState(targetState);
      return targetState.checkpoints.map(record => this.toCheckpointRefMetadata(targetContext, record));
    });
  }

  async buildRestorePlan(checkpointId: string): Promise<RestorePlan | null> {
    await this.waitForPendingCheckpointMutations();

    const gitPlan = await this.buildPlanFromGitCheckpoint(checkpointId, 'restore');
    if (gitPlan) {
      return gitPlan;
    }

    return await Promise.resolve(this.fallbackProvider?.buildRestorePlan(checkpointId) ?? null);
  }

  async buildRedoPlan(checkpointId: string): Promise<RestorePlan | null> {
    await this.waitForPendingCheckpointMutations();

    const gitPlan = await this.buildPlanFromGitCheckpoint(checkpointId, 'redo');
    if (gitPlan) {
      return gitPlan;
    }

    return await Promise.resolve(this.fallbackProvider?.buildRedoPlan(checkpointId) ?? null);
  }

  async applyRestorePlan(plan: RestorePlan): Promise<RollbackResult | null> {
    if (plan.applyMetadata?.kind !== 'git-checkpoint') {
      return await Promise.resolve(this.fallbackProvider?.applyRestorePlan?.(plan) ?? {
        rolledBackFiles: 0,
        errors: ['workspace checkpoint provider 缺少 timeline restore plan 应用器'],
        rolledBackOnError: true,
      });
    }

    const context = await this.resolveRepositoryContext();
    if (!context || context.repositoryRoot !== plan.applyMetadata.repositoryRoot) {
      return {
        rolledBackFiles: 0,
        errors: ['git-backed checkpoint restore plan 无法由 workspace checkpoint provider 应用'],
        rolledBackOnError: true,
      };
    }

    const pathUtil = AilyHost.get().path;
    const fs = AilyHost.get().fs;
    const tmpDir = pathUtil.join(
      context.workspaceRoot,
      '.aily',
      'workspace-checkpoints',
      '.tmp',
      `${context.sessionId}-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const checkpointIndexFile = pathUtil.join(tmpDir, 'apply.index');

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const appliedTargets: Array<{ repositoryRoot: string; commitOid: string }> = [];

    try {
      const checkpointTargets: GitCheckpointApplyTarget[] = [
        {
          repositoryRoot: plan.applyMetadata.repositoryRoot,
          targetRef: plan.applyMetadata.targetRef,
        },
        ...(plan.applyMetadata.additionalTargets ?? []),
      ];
      const preparedTargets: Array<GitCheckpointApplyTarget & { currentCommitOid: string }> = [];

      for (const checkpointTarget of checkpointTargets) {
        const targetContext = {
          ...context,
          repositoryRoot: checkpointTarget.repositoryRoot,
        };
        const currentCommitOid = await this.captureWorkspaceSnapshotCommit(targetContext);
        preparedTargets.push({
          ...checkpointTarget,
          currentCommitOid,
        });
        appliedTargets.push({ repositoryRoot: checkpointTarget.repositoryRoot, commitOid: currentCommitOid });
      }

      for (const [index, checkpointTarget] of preparedTargets.entries()) {
        const targetCommitOid = (await this.runGit(['rev-parse', checkpointTarget.targetRef], checkpointTarget.repositoryRoot)).trim();
        const env = { GIT_INDEX_FILE: index === 0 ? checkpointIndexFile : AilyHost.get().path.join(tmpDir, `apply.${index}.index`) };

        await this.runGit(['read-tree', checkpointTarget.currentCommitOid], checkpointTarget.repositoryRoot, env);
        await this.runGit(['read-tree', '--reset', '-u', targetCommitOid], checkpointTarget.repositoryRoot, env);
      }

      return {
        rolledBackFiles: plan.files.length,
        errors: [],
        emergencyRollback: async () => this.rollbackAppliedCheckpointTargetsWithTempDir(
          appliedTargets.map(target => ({ ...target })),
          context.workspaceRoot,
          context.sessionId,
          plan.files.length,
        ),
      };
    } catch (error: any) {
      const rollbackErrors = await this.rollbackAppliedCheckpointTargets(appliedTargets, tmpDir).catch(rollbackError => [String(rollbackError)]);
      return {
        rolledBackFiles: 0,
        errors: [`checkpoint git apply 失败: ${error?.message || String(error)}`],
        ...(rollbackErrors.length === 0 ? { rolledBackOnError: true, rollbackErrors: [] } : { rolledBackOnError: false, rollbackErrors }),
      };
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  private async rollbackAppliedCheckpointTargetsWithTempDir(
    appliedTargets: readonly { repositoryRoot: string; commitOid: string }[],
    workspaceRoot: string,
    sessionId: string,
    fileCount: number,
  ): Promise<RollbackResult> {
    const pathUtil = AilyHost.get().path;
    const fs = AilyHost.get().fs;
    const tmpDir = pathUtil.join(
      workspaceRoot,
      '.aily',
      'workspace-checkpoints',
      '.tmp',
      `${sessionId}-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    try {
      const rollbackErrors = await this.rollbackAppliedCheckpointTargets(appliedTargets, tmpDir);
      return {
        rolledBackFiles: rollbackErrors.length === 0 ? fileCount : 0,
        errors: rollbackErrors,
        rolledBackOnError: rollbackErrors.length === 0,
        rollbackErrors,
      };
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  private async rollbackAppliedCheckpointTargets(
    appliedTargets: readonly { repositoryRoot: string; commitOid: string }[],
    tmpDir: string,
  ): Promise<string[]> {
    const rollbackErrors: string[] = [];

    for (const [index, checkpointTarget] of appliedTargets.entries()) {
      try {
        const env = { GIT_INDEX_FILE: index === 0 ? AilyHost.get().path.join(tmpDir, 'rollback.index') : AilyHost.get().path.join(tmpDir, `rollback.${index}.index`) };
        await this.runGit(['read-tree', checkpointTarget.commitOid], checkpointTarget.repositoryRoot, env);
        await this.runGit(['read-tree', '--reset', '-u', checkpointTarget.commitOid], checkpointTarget.repositoryRoot, env);
      } catch (rollbackError: any) {
        rollbackErrors.push(`checkpoint git rollback 失败 (${checkpointTarget.repositoryRoot}): ${rollbackError?.message || String(rollbackError)}`);
      }
    }

    return rollbackErrors;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queued
      .catch(() => undefined)
      .then(operation);
    this.queued = next.then(() => undefined, () => undefined);
    return next;
  }

  private async waitForPendingCheckpointMutations(): Promise<void> {
    await this.queued.catch(() => undefined);
  }

  private async resolveRepositoryContext(): Promise<{ sessionId: string; workspaceRoot: string; repositoryRoot: string } | null> {
    const sessionId = this.sessionId;
    return sessionId ? this.resolveRepositoryContextForSession(sessionId) : null;
  }

  private async resolveRepositoryContextForSession(sessionId: string): Promise<{ sessionId: string; workspaceRoot: string; repositoryRoot: string } | null> {
    const normalizedSessionId = sessionId.trim();
    const workspaceRoot = this.workspaceRoot ?? AilyHost.get().project.currentProjectPath ?? null;
    if (!normalizedSessionId || !workspaceRoot) {
      this.logCheckpointDiagnostic('warn', `resolveRepositoryContext skipped: session=${normalizedSessionId || '(empty)'}; workspaceRoot=${workspaceRoot ?? '(empty)'}`);
      return null;
    }

    if (this.repositoryRootCache.has(workspaceRoot)) {
      const cached = this.repositoryRootCache.get(workspaceRoot);
      this.logCheckpointDiagnostic(
        cached ? 'info' : 'warn',
        `resolveRepositoryContext cache hit: session=${normalizedSessionId}; workspaceRoot=${workspaceRoot}; repositoryRoot=${cached ?? '(none)'}`,
      );
      return cached ? { sessionId: normalizedSessionId, workspaceRoot, repositoryRoot: cached } : null;
    }

    try {
      this.logCheckpointDiagnostic('info', `resolveRepositoryContext probe start: session=${normalizedSessionId}; workspaceRoot=${workspaceRoot}`);
      const inside = (await this.runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)).trim();
      this.logCheckpointDiagnostic('info', `resolveRepositoryContext git inside-work-tree=${inside}; workspaceRoot=${workspaceRoot}`);
      if (inside !== 'true') {
        this.repositoryRootCache.set(workspaceRoot, null);
        this.setAvailabilityDetail(workspaceRoot, {
          mode: this.getFallbackPresentationMode(),
          reason: 'not-git-repository',
          message: '当前工作区不是 Git 仓库，使用本地 timeline checkpoint',
        });
        return null;
      }

      const repositoryRoot = (await this.runGit(['rev-parse', '--show-toplevel'], workspaceRoot)).trim();
      this.logCheckpointDiagnostic('info', `resolveRepositoryContext git repositoryRoot=${repositoryRoot || '(empty)'}; workspaceRoot=${workspaceRoot}`);
      this.repositoryRootCache.set(workspaceRoot, repositoryRoot || null);
      this.setAvailabilityDetail(workspaceRoot, repositoryRoot
        ? { mode: 'git' }
        : {
          mode: this.getFallbackPresentationMode(),
          reason: 'not-git-repository',
          message: '当前工作区无法解析 Git 仓库根目录，使用本地 timeline checkpoint',
        });
      return repositoryRoot ? { sessionId: normalizedSessionId, workspaceRoot, repositoryRoot } : null;
    } catch (error) {
      this.repositoryRootCache.set(workspaceRoot, null);
      const detail = this.buildGitProbeFailureDetail(error);
      this.setAvailabilityDetail(workspaceRoot, detail);
      this.logCheckpointDiagnostic(
        'error',
        `resolveRepositoryContext probe failed: session=${normalizedSessionId}; workspaceRoot=${workspaceRoot}; reason=${detail.reason ?? 'unknown'}; message=${detail.message ?? ''}`,
        error,
      );
      return null;
    }
  }

  private setAvailabilityDetail(
    workspaceRoot: string | null,
    detail: WorkspaceCheckpointAvailabilityDetail,
  ): void {
    if (!workspaceRoot) {
      return;
    }
    this.availabilityDetailByWorkspaceRoot.set(workspaceRoot, detail);
    this.logCheckpointDiagnostic(
      detail.mode === 'git' ? 'info' : 'warn',
      `availability detail updated: workspaceRoot=${workspaceRoot}; mode=${detail.mode}; reason=${detail.reason ?? 'none'}; message=${detail.message ?? ''}`,
    );
  }

  private logCheckpointDiagnostic(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
    try {
      const logger = AilyHost.get().log;
      if (level === 'error') {
        logger?.error?.(`[AilyChat][GitCheckpoint] ${message}`, error);
        return;
      }
      logger?.[level]?.(`[AilyChat][GitCheckpoint] ${message}`);
    } catch {
      // Diagnostics must not affect checkpoint behavior.
    }
  }

  private buildGitProbeFailureDetail(error: unknown): WorkspaceCheckpointAvailabilityDetail {
    const message = error instanceof Error && error.message ? error.message : String(error ?? '');
    const lowerMessage = message.toLowerCase();
    if (
      lowerMessage.includes('enoent')
      || lowerMessage.includes('not recognized')
      || lowerMessage.includes('command not found')
      || lowerMessage.includes('commandnotfoundexception')
      || (message.includes('无法将') && message.includes('识别'))
      || message.includes('不是内部或外部命令')
      || lowerMessage.includes('git command host is unavailable')
    ) {
      return {
        mode: this.getFallbackPresentationMode(),
        reason: 'git-not-found',
        message: '未找到 git 命令，使用本地 timeline checkpoint',
      };
    }

    if (
      lowerMessage.includes('dubious ownership')
      || lowerMessage.includes('safe.directory')
      || lowerMessage.includes('detected dubious')
    ) {
      return {
        mode: this.getFallbackPresentationMode(),
        reason: 'git-safe-directory',
        message,
      };
    }

    if (
      lowerMessage.includes('not a git repository')
      || lowerMessage.includes('not inside a work tree')
    ) {
      return {
        mode: this.getFallbackPresentationMode(),
        reason: 'not-git-repository',
        message: '当前工作区不是 Git 仓库，使用本地 timeline checkpoint',
      };
    }

    return {
      mode: this.getFallbackPresentationMode(),
      reason: 'git-probe-failed',
      message,
    };
  }

  private createEmptyState(context: { sessionId: string; workspaceRoot: string; repositoryRoot: string }): PersistedWorkspaceCheckpointState {
    const now = Date.now();
    return {
      version: 1,
      sessionId: context.sessionId,
      workspaceRoot: context.workspaceRoot,
      repositoryRoot: context.repositoryRoot,
      checkpoints: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async ensureCheckpointRecord(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    descriptor: WorkspaceCheckpointDescriptor,
    existingState?: PersistedWorkspaceCheckpointState,
  ): Promise<PersistedWorkspaceCheckpointState> {
    const state = existingState ?? this.loadState(context) ?? this.createEmptyState(context);
    const existing = state.checkpoints.find(checkpoint => checkpoint.checkpointId === descriptor.checkpointId);
    if (existing) {
      const additionalRepositoryRoots = this.normalizeAdditionalRepositoryRoots(descriptor.additionalRepositoryRoots, context.repositoryRoot);
      existing.requestId = descriptor.requestId;
      existing.turnId = descriptor.turnId;
      existing.label = descriptor.label;
      existing.additionalRepositoryRoots = additionalRepositoryRoots.length > 0
        ? [...additionalRepositoryRoots]
        : undefined;
      existing.additionalStartCheckpointRefs = this.filterAdditionalCheckpointRefs(existing.additionalStartCheckpointRefs, additionalRepositoryRoots);
      existing.additionalCompletedCheckpointRefs = this.filterAdditionalCheckpointRefs(existing.additionalCompletedCheckpointRefs, additionalRepositoryRoots);
      await this.ensureAdditionalCheckpointStartRefs(context, state, existing, descriptor.additionalRepositoryRoots);
      state.updatedAt = Date.now();
      return state;
    }

    if (!state.firstCheckpointRef) {
      const baselineRef = await this.createGitCheckpoint(context, 0);
      state.firstCheckpointRef = baselineRef;
      state.lastCheckpointRef = baselineRef;
    }

    const record: PersistedWorkspaceCheckpointRecord = {
      ...descriptor,
      requestOrdinal: state.checkpoints.length + 1,
      startCheckpointRef: state.lastCheckpointRef ?? state.firstCheckpointRef,
      createdAt: Date.now(),
    };
    state.checkpoints.push(record);
    await this.ensureAdditionalCheckpointStartRefs(context, state, record, descriptor.additionalRepositoryRoots);
    state.updatedAt = Date.now();
    return state;
  }

  private toCheckpointRefMetadata(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    record: PersistedWorkspaceCheckpointRecord,
  ): WorkspaceCheckpointRefMetadata {
    return {
      checkpointId: record.checkpointId,
      sessionResource: context.sessionId,
      requestId: record.requestId,
      ...(record.turnId ? { turnId: record.turnId } : {}),
      checkpointNamespace: `${CHECKPOINT_REF_PREFIX}${context.sessionId}`,
      turnIndex: record.requestOrdinal,
      ...(record.startCheckpointRef ? { startCheckpointRef: record.startCheckpointRef } : {}),
      ...(record.completedCheckpointRef ? { checkpointRef: record.completedCheckpointRef } : {}),
      ...(record.additionalStartCheckpointRefs ? { additionalStartCheckpointRefs: { ...record.additionalStartCheckpointRefs } } : {}),
      ...(record.additionalCompletedCheckpointRefs ? { additionalCheckpointRefs: { ...record.additionalCompletedCheckpointRefs } } : {}),
      createdAt: record.createdAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    };
  }

  private async ensureAdditionalCheckpointStartRefs(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    state: PersistedWorkspaceCheckpointState,
    record: PersistedWorkspaceCheckpointRecord,
    additionalRepositoryRoots: readonly string[] | undefined,
  ): Promise<void> {
    const repositoryRoots = this.normalizeAdditionalRepositoryRoots(additionalRepositoryRoots, context.repositoryRoot);
    if (repositoryRoots.length === 0) {
      return;
    }

    const additionalStartCheckpointRefs = {
      ...(record.additionalStartCheckpointRefs ?? {}),
    };
    let changed = false;
    const currentCheckpointIndex = state.checkpoints.findIndex(checkpoint => checkpoint.checkpointId === record.checkpointId);
    const previousCheckpoint = currentCheckpointIndex > 0
      ? state.checkpoints[currentCheckpointIndex - 1]
      : undefined;
    for (const repositoryRoot of repositoryRoots) {
      if (additionalStartCheckpointRefs[repositoryRoot]) {
        continue;
      }

      const immediateParentCheckpointRef = previousCheckpoint?.additionalCompletedCheckpointRefs?.[repositoryRoot];
      if (immediateParentCheckpointRef) {
        additionalStartCheckpointRefs[repositoryRoot] = immediateParentCheckpointRef;
        changed = true;
        continue;
      }

      const hasHistoricalOwnerBeforeGap = state.checkpoints.some((checkpoint, index) => (
        index < currentCheckpointIndex
        && (checkpoint.additionalStartCheckpointRefs?.[repositoryRoot] || checkpoint.additionalCompletedCheckpointRefs?.[repositoryRoot])
      ));
      if (hasHistoricalOwnerBeforeGap) {
        continue;
      }

      additionalStartCheckpointRefs[repositoryRoot] = await this.createGitCheckpoint({ ...context, repositoryRoot }, 0);
      changed = true;
    }

    if (changed) {
      record.additionalStartCheckpointRefs = additionalStartCheckpointRefs;
    }
  }

  private async copyPrimaryCheckpointRefForFork(
    repositoryRoot: string,
    sourceRef: string | undefined,
    targetSessionId: string,
    targetTurnNumber: number,
    existingTargetRef?: string,
  ): Promise<string | undefined> {
    if (!sourceRef) {
      return existingTargetRef;
    }

    const targetRef = this.getCheckpointRef(targetSessionId, targetTurnNumber);
    await this.copyGitRef(repositoryRoot, sourceRef, targetRef);
    return targetRef;
  }

  private async copyAdditionalCheckpointRefsForFork(
    sourceRefs: Record<string, string> | undefined,
    targetSessionId: string,
    targetTurnNumber: number,
  ): Promise<Record<string, string> | undefined> {
    const entries = Object.entries(sourceRefs ?? {})
      .map(([repositoryRoot, sourceRef]) => [repositoryRoot.trim(), sourceRef.trim()] as const)
      .filter(([repositoryRoot, sourceRef]) => repositoryRoot.length > 0 && sourceRef.length > 0);
    if (entries.length === 0) {
      return undefined;
    }

    const targetRef = this.getCheckpointRef(targetSessionId, targetTurnNumber);
    const copiedRefs: Record<string, string> = {};
    for (const [repositoryRoot, sourceRef] of entries) {
      await this.copyGitRef(repositoryRoot, sourceRef, targetRef);
      copiedRefs[repositoryRoot] = targetRef;
    }
    return copiedRefs;
  }

  private async copyGitRef(repositoryRoot: string, sourceRef: string, targetRef: string): Promise<void> {
    const commitOid = (await this.runGit(['rev-parse', sourceRef], repositoryRoot)).trim();
    await this.runGit(['update-ref', targetRef, commitOid], repositoryRoot);
  }

  private normalizeAdditionalRepositoryRoots(
    repositoryRoots: readonly string[] | undefined,
    primaryRepositoryRoot: string,
  ): string[] {
    return [...new Set((repositoryRoots ?? [])
      .map(repositoryRoot => repositoryRoot.trim())
      .filter(repositoryRoot => repositoryRoot.length > 0 && repositoryRoot !== primaryRepositoryRoot))]
      .sort((left, right) => left.localeCompare(right));
  }

  private filterAdditionalCheckpointRefs(
    checkpointRefs: Record<string, string> | undefined,
    additionalRepositoryRoots: readonly string[],
  ): Record<string, string> | undefined {
    if (!checkpointRefs || additionalRepositoryRoots.length === 0) {
      return undefined;
    }

    const filteredEntries = additionalRepositoryRoots
      .map(repositoryRoot => [repositoryRoot, checkpointRefs[repositoryRoot]] as const)
      .filter(([, checkpointRef]) => !!checkpointRef);
    return filteredEntries.length > 0
      ? Object.fromEntries(filteredEntries)
      : undefined;
  }

  private async buildPlanFromGitCheckpoint(checkpointId: string, mode: 'restore' | 'redo'): Promise<RestorePlan | null> {
    const context = await this.resolveRepositoryContext();
    if (!context) {
      return null;
    }

    const state = this.loadState(context);
    if (!state) {
      return null;
    }

    const record = state.checkpoints.find(checkpoint => checkpoint.checkpointId === checkpointId);
    if (!record) {
      return null;
    }

    const targetRef = mode === 'restore'
      ? record.startCheckpointRef
      : record.completedCheckpointRef;
    if (!targetRef) {
      throw new Error(`git-backed checkpoint ${mode} 缺少 durable ref anchor: ${checkpointId}`);
    }

    const additionalCheckpointRefs = mode === 'restore'
      ? record.additionalStartCheckpointRefs
      : record.additionalCompletedCheckpointRefs;
    for (const repositoryRoot of this.listAdditionalCheckpointRepositoryRoots(record, context.repositoryRoot)) {
      if (!additionalCheckpointRefs?.[repositoryRoot]) {
        throw new Error(`git-backed checkpoint ${mode} 缺少 additional durable ref anchor: ${checkpointId} (${repositoryRoot})`);
      }
    }

    const additionalTargets = this.toAdditionalCheckpointTargets(
      additionalCheckpointRefs,
      context.repositoryRoot,
    );

    const currentCommitOid = await this.captureWorkspaceSnapshotCommit(context);
    return this.buildPlanFromCheckpointRefs(
      context,
      checkpointId,
      targetRef,
      currentCommitOid,
      mode === 'restore' ? Math.max(0, record.requestOrdinal - 1) : record.requestOrdinal,
      additionalTargets,
    );
  }

  private async buildPlanFromCheckpointRefs(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    checkpointId: string,
    targetRef: string,
    currentCommitOid: string,
    epoch: number,
    additionalTargets: GitCheckpointApplyTarget[] = [],
  ): Promise<RestorePlan> {
    const files = await this.buildPlanFilesForTarget(context, targetRef, currentCommitOid, epoch);
    for (const additionalTarget of additionalTargets) {
      const additionalContext = {
        ...context,
        repositoryRoot: additionalTarget.repositoryRoot,
      };
      const additionalCurrentCommitOid = await this.captureWorkspaceSnapshotCommit(additionalContext);
      files.push(...await this.buildPlanFilesForTarget(additionalContext, additionalTarget.targetRef, additionalCurrentCommitOid, epoch));
    }

    return {
      checkpointId,
      epoch,
      files: files.sort((left, right) => left.uri.localeCompare(right.uri)),
      applyMetadata: {
        kind: 'git-checkpoint',
        repositoryRoot: context.repositoryRoot,
        targetRef,
        ...(additionalTargets.length > 0 ? { additionalTargets } : {}),
      },
    } satisfies RestorePlan;
  }

  private async buildPlanFilesForTarget(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    targetRef: string,
    currentCommitOid: string,
    epoch: number,
  ): Promise<RestorePlan['files']> {
    return this.withMaterializedTree(context, targetRef, 'target', async targetDir => (
      this.withMaterializedTree(context, currentCommitOid, 'current', async currentDir => {
        const targetFiles = this.collectRelativeFiles(targetDir);
        const currentFiles = this.collectRelativeFiles(currentDir);
        const allRelativePaths = [...new Set([...targetFiles.keys(), ...currentFiles.keys()])].sort();

        return allRelativePaths.map(relativePath => {
          const targetPath = targetFiles.get(relativePath);
          if (!targetPath) {
            const currentPath = currentFiles.get(relativePath);
            const currentBytes = currentPath
              ? normalizeBytes(AilyHost.get().fs.readFileSync(currentPath))
              : undefined;
            return {
              uri: this.toWorkspaceFileUri(context.repositoryRoot, relativePath),
              exists: false,
              contentKind: this.inferContentKind(relativePath, currentBytes),
              contentRef: null,
              sourceEpoch: epoch,
            };
          }

          const { contentKind, contentRef } = this.captureMaterializedFile(context, targetPath, relativePath);
          return {
            uri: this.toWorkspaceFileUri(context.repositoryRoot, relativePath),
            exists: true,
            contentKind,
            contentRef,
            sourceEpoch: epoch,
          };
        });
      })
    ));
  }

  private toAdditionalCheckpointTargets(
    additionalCheckpointRefs: Record<string, string> | undefined,
    primaryRepositoryRoot: string,
  ): GitCheckpointApplyTarget[] {
    return Object.entries(additionalCheckpointRefs ?? {})
      .filter(([repositoryRoot, targetRef]) => !!repositoryRoot && !!targetRef && repositoryRoot !== primaryRepositoryRoot)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([repositoryRoot, targetRef]) => ({ repositoryRoot, targetRef }));
  }

  private listAdditionalCheckpointRepositoryRoots(
    record: PersistedWorkspaceCheckpointRecord,
    primaryRepositoryRoot: string,
  ): string[] {
    return this.normalizeAdditionalRepositoryRoots([
      ...(record.additionalRepositoryRoots ?? []),
      ...Object.keys(record.additionalStartCheckpointRefs ?? {}),
      ...Object.keys(record.additionalCompletedCheckpointRefs ?? {}),
    ], primaryRepositoryRoot);
  }

  private loadState(context: { sessionId: string; workspaceRoot: string; repositoryRoot: string }): PersistedWorkspaceCheckpointState | null {
    const path = this.getStatePath(context.workspaceRoot, context.sessionId);
    if (!AilyHost.get().fs.existsSync(path)) {
      return null;
    }

    try {
      const raw = AilyHost.get().fs.readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedWorkspaceCheckpointState;
      if (parsed?.version !== 1) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private saveState(state: PersistedWorkspaceCheckpointState): void {
    const path = this.getStatePath(state.workspaceRoot, state.sessionId);
    const dir = AilyHost.get().path.dirname(path);
    if (!AilyHost.get().fs.existsSync(dir)) {
      AilyHost.get().fs.mkdirSync(dir, { recursive: true });
    }
    AilyHost.get().fs.writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  }

  private getStatePath(workspaceRoot: string, sessionId: string): string {
    return AilyHost.get().path.join(workspaceRoot, '.aily', 'workspace-checkpoints', `${sessionId}.json`);
  }

  private async captureWorkspaceSnapshotCommit(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
  ): Promise<string> {
    return this.createCheckpointCommit(context, `Session ${context.sessionId} - current workspace snapshot`, undefined);
  }

  private async createCheckpointCommit(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    message: string,
    parentCheckpointRef?: string,
  ): Promise<string> {
    const pathUtil = AilyHost.get().path;
    const fs = AilyHost.get().fs;
    const tmpDir = pathUtil.join(
      context.workspaceRoot,
      '.aily',
      'workspace-checkpoints',
      '.tmp',
      `${context.sessionId}-capture-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const checkpointIndexFile = pathUtil.join(tmpDir, 'checkpoint.index');

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    try {
      const parentCommitOid = parentCheckpointRef
        ? (await this.runGit(['rev-parse', parentCheckpointRef], context.repositoryRoot)).trim()
        : undefined;
      const env = { GIT_INDEX_FILE: checkpointIndexFile };
      await this.runGit(['read-tree', parentCommitOid ?? 'HEAD'], context.repositoryRoot, env);
      await this.runGit(['add', '-A', '--', '.'], context.repositoryRoot, env);
      const treeOid = (await this.runGit(['write-tree'], context.repositoryRoot, env)).trim();
      const commitArgs = [
        'commit-tree',
        treeOid,
        ...(parentCommitOid ? ['-p', parentCommitOid] : []),
        '-m',
        message,
      ];
      return (await this.runGit(commitArgs, context.repositoryRoot)).trim();
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  private async createGitCheckpoint(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    turnNumber: number,
    parentCheckpointRef?: string,
  ): Promise<string> {
    const pathUtil = AilyHost.get().path;
    const fs = AilyHost.get().fs;
    const tmpDir = pathUtil.join(
      context.workspaceRoot,
      '.aily',
      'workspace-checkpoints',
      '.tmp',
      `${context.sessionId}-${turnNumber}-${Date.now()}`,
    );
    const checkpointIndexFile = pathUtil.join(tmpDir, 'checkpoint.index');
    const checkpointRef = this.getCheckpointRef(context.sessionId, turnNumber);

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    try {
      const commitOid = await this.createCheckpointCommit(
        context,
        `Session ${context.sessionId} - checkpoint turn ${turnNumber}`,
        parentCheckpointRef,
      );
      await this.runGit(['update-ref', checkpointRef, commitOid], context.repositoryRoot);
      return checkpointRef;
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  private async withMaterializedTree<T>(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    refOrCommit: string,
    label: string,
    callback: (materializedDir: string) => Promise<T>,
  ): Promise<T> {
    const pathUtil = AilyHost.get().path;
    const fs = AilyHost.get().fs;
    const tmpDir = pathUtil.join(
      context.workspaceRoot,
      '.aily',
      'workspace-checkpoints',
      '.tmp',
      `${context.sessionId}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const checkpointIndexFile = pathUtil.join(tmpDir, 'materialize.index');
    const materializedDir = pathUtil.join(tmpDir, 'tree');
    if (!fs.existsSync(materializedDir)) {
      fs.mkdirSync(materializedDir, { recursive: true });
    }

    try {
      const commitOid = (await this.runGit(['rev-parse', refOrCommit], context.repositoryRoot)).trim();
      const env = { GIT_INDEX_FILE: checkpointIndexFile };
      await this.runGit(['read-tree', commitOid], context.repositoryRoot, env);
      await this.runGit(['checkout-index', '--all', '--force', `--prefix=${this.toCheckoutPrefix(materializedDir)}`], context.repositoryRoot, env);
      return await callback(materializedDir);
    } finally {
      this.cleanupTempDir(tmpDir);
    }
  }

  private collectRelativeFiles(rootDir: string): Map<string, string> {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const files = new Map<string, string>();

    const visit = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) {
        return;
      }

      for (const entry of fs.readdirSync(dirPath)) {
        const fullPath = pathUtil.join(dirPath, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          visit(fullPath);
          continue;
        }

        const relativePath = this.normalizeRelativePath(pathUtil.relative(rootDir, fullPath));
        files.set(relativePath, fullPath);
      }
    };

    visit(rootDir);
    return files;
  }

  private captureMaterializedFile(
    context: { sessionId: string; workspaceRoot: string; repositoryRoot: string },
    absolutePath: string,
    relativePath: string,
  ): { contentKind: 'text' | 'binary' | 'notebook'; contentRef: ReturnType<EditingContentStore['putText']> } | { contentKind: 'text' | 'binary' | 'notebook'; contentRef: ReturnType<EditingContentStore['putBinary']> } {
    const fs = AilyHost.get().fs;
    const rawContent = fs.readFileSync(absolutePath);
    const bytes = normalizeBytes(rawContent);
    const contentKind = this.inferContentKind(relativePath, bytes);

    if (contentKind === 'binary') {
      return {
        contentKind,
        contentRef: this.contentStore.putBinary(context.workspaceRoot, context.sessionId, bytes),
      };
    }

    const textContent = typeof rawContent === 'string'
      ? rawContent
      : this.readTextContent(absolutePath, bytes);
    return {
      contentKind,
      contentRef: this.contentStore.putText(context.workspaceRoot, context.sessionId, textContent),
    };
  }

  private readTextContent(absolutePath: string, bytes: Uint8Array): string {
    const rawText = AilyHost.get().fs.readFileSync(absolutePath, 'utf-8');
    if (typeof rawText === 'string') {
      return rawText;
    }

    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return '';
    }
  }

  private inferContentKind(relativePath: string, bytes?: Uint8Array): 'text' | 'binary' | 'notebook' {
    const normalizedPath = relativePath.toLowerCase();
    if (normalizedPath.endsWith('.ipynb')) {
      return 'notebook';
    }

    if (bytes && bytes.some(byte => byte === 0)) {
      return 'binary';
    }

    return 'text';
  }

  private toWorkspaceFileUri(workspaceRoot: string, relativePath: string): string {
    const segments = relativePath.split('/').filter(Boolean);
    return segments.length > 0
      ? AilyHost.get().path.join(workspaceRoot, ...segments)
      : workspaceRoot;
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private toCheckoutPrefix(materializedDir: string): string {
    return materializedDir.endsWith('/') || materializedDir.endsWith('\\')
      ? materializedDir
      : `${materializedDir}/`;
  }

  private cleanupTempDir(tmpDir: string): void {
    const fs = AilyHost.get().fs;
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmdirSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup failures
    }
  }

  private async listCheckpointRefs(context: { sessionId: string; workspaceRoot: string; repositoryRoot: string }): Promise<string[]> {
    const output = await this.runGit(
      ['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}${context.sessionId}/checkpoints/turn/`],
      context.repositoryRoot,
    );

    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .sort((left, right) => this.getTurnNumberFromRef(left) - this.getTurnNumberFromRef(right));
  }

  private getCheckpointRef(sessionId: string, turnNumber: number): string {
    return `${CHECKPOINT_REF_PREFIX}${sessionId}/checkpoints/turn/${turnNumber}`;
  }

  private getTurnNumberFromRef(ref: string): number {
    const tail = ref.split('/').pop() ?? '0';
    const parsed = Number.parseInt(tail, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private runGit(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
    return runHostGitCommand(args, cwd, env);
  }
}

function normalizeBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (Array.isArray(content)) {
    return new Uint8Array(content);
  }
  if (content && typeof content === 'object' && 'buffer' in (content as any)) {
    const view = content as { buffer: ArrayBufferLike; byteOffset?: number; byteLength?: number };
    return new Uint8Array(view.buffer, view.byteOffset ?? 0, view.byteLength ?? 0);
  }
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  return new Uint8Array();
}
