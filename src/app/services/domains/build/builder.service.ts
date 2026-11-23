import { Inject, Injectable, Optional } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import { ProjectService, CODER_EXECUTION_PORT, type CoderExecutionPort } from '@domain/project/public-api';
import {
  CmdService,
  CrossPlatformCmdService,
  ElectronService,
} from '@core/platform/public-api';
import { CompileService } from './compile.service';
import { isBuildCancelled } from './build-cancellation';
import { persistBuildResult, type BuildCheckpoint, type BuildResultSnapshot } from './build-result-snapshot';
import { BUILD_ACTION_PORT, type BuildActionPort } from './ports/build-action.port';
import { BLOCKLY_BUILD_PORT, type BlocklyBuildPort } from './ports/blockly-build.port';

export interface BuildFinishedEvent {
  projectPath?: string;
  success: boolean;
  result?: any;
  error?: any;
}

export interface ActiveBlocklyProjectBuildInput {
  projectPath: string;
  graphSemanticRevision: string;
  requestId: string;
}

@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  /** 编译流程结束（成功/失败/取消）后广播；订阅者用于刷新依赖产物路径的视图（如内嵌 Coder 的 main.hex）。 */
  readonly buildFinishedSubject = new Subject<BuildFinishedEvent>();

  constructor(
    @Inject(BUILD_ACTION_PORT)
    private actionService: BuildActionPort,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    private compileService: CompileService,
    @Optional() @Inject(CODER_EXECUTION_PORT) private coderExecution?: CoderExecutionPort,
    @Optional() @Inject(BLOCKLY_BUILD_PORT) private blocklyBuild?: BlocklyBuildPort,
  ) {
    this.init();
  }

  private init(): void {
    this.projectService.boardChangeSubject.subscribe(() => {
      try {
        this.actionService.dispatch('compile-reset', {}, result => {
          console.log('编译器已重置:', result);
        });
      } catch (error) {
        console.warn('编译器重置失败:', error);
      }

      this.clearCache(this.projectService.currentProjectPath).then(() => {
        console.log('编译缓存已清除');
      }).catch(err => {
        console.warn('清除编译缓存时出错:', err);
      });
    });
  }

  /*
   * 开始编译
   */
  async build(projectPath?: string, options: {
    preprocessOnly?: boolean;
    source?: BuildResultSnapshot['source'];
    requestId?: string;
    expectedProjectPath?: string;
    clearCache?: boolean;
  } = {}) {
    const activePath = this.projectService.currentProjectPath;
    const targetPath = projectPath || activePath;
    if (options.expectedProjectPath !== undefined && (activePath !== options.expectedProjectPath || targetPath !== activePath)) {
      throw Object.assign(new Error('The requested Blockly build project is no longer active.'), { buildOutcome: 'not-started' });
    }
    const coder = this.projectService.isAilyCodeProject(targetPath);
    if (this.coderExecution && coder && !this.projectService.isCoderProjectContext) return this.coderExecution.build(targetPath, options);
    if (!coder && (!activePath || targetPath !== activePath || this.projectService.isProjectOpening)) {
      throw Object.assign(new Error('The requested Blockly build project is no longer active.'), { buildOutcome: 'not-started' });
    }
    const finish = this.projectService.beginCoderOperation('build', targetPath);
    try {
      if (coder) return await this.buildFromProjectPath(targetPath, options);
      return await this.buildCurrentBlocklyProject(targetPath, {
        source: options.source, requestId: options.requestId, clearCache: options.clearCache,
        ...(options.preprocessOnly ? { preprocessOnly: true } : {}),
      });
    } finally {
      finish();
    }
  }

  /**
   * Build one exact active Blockly Project for a provider-owned request.
   * The request id is forwarded so cancellation cannot terminate an unrelated
   * manual build.
   */
  async buildActiveBlocklyProject(input: ActiveBlocklyProjectBuildInput) {
    const projectPath = String(input?.projectPath || '').trim();
    const activePath = this.projectService.currentProjectPath;
    const graphSemanticRevision = String(
      input?.graphSemanticRevision || '',
    );
    const requestId = String(input?.requestId || '');
    if (
      !projectPath
      || !/^[a-f0-9]{64}$/.test(graphSemanticRevision)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)
    ) {
      throw new Error('Active Blockly Project Build input is invalid.');
    }
    if (
      this.projectService.isProjectOpening
      || !this.isSameProjectPath(
        projectPath,
        activePath,
      )
      || this.projectService.isAilyCodeProject(projectPath)
      || !this.blocklyBuild?.isAvailable()
    ) {
      throw new Error('The requested Blockly Project is not active.');
    }
    return this.buildCurrentBlocklyProject(activePath, {
      source: 'ai',
      graphSemanticRevision,
      requestId,
    });
  }

  private async buildCurrentBlocklyProject(
    projectPath: string,
    payload: {
      source?: BuildResultSnapshot['source'];
      graphSemanticRevision?: string;
      requestId?: string;
      clearCache?: boolean;
      preprocessOnly?: boolean;
    },
  ) {
    let checkpoint: BuildCheckpoint | undefined;
    try {
      if (!this.blocklyBuild?.isAvailable()) {
        throw new Error('The active Blockly build executor is unavailable.');
      }
      const completion = await this.blocklyBuild.build({ projectPath, ...payload });

      checkpoint = completion.checkpoint;
      const buildResult = completion.result;
      const buildSuccess = completion.success === true
        && !!buildResult
        && buildResult?.state !== 'error';

      if (!buildSuccess) {
        // 编译失败，构造包含状态和错误详情的错误对象抛出
        const error: any = new Error(buildResult?.text || buildResult?.message || '编译失败');
        error.state = buildResult?.state || 'error';
        error.text = error.message;
        error.fullStdErr = buildResult?.fullStdErr;
        error.buildLog = buildResult?.buildLog;
        error.buildInput = (buildResult as any)?.buildInput;
        error.buildSnapshot = buildResult?.buildSnapshot;
        error.buildOutcome = (buildResult as any)?.buildOutcome;
        if (typeof (buildResult as any)?.code === 'string') error.code = (buildResult as any).code;
        error.buildResult = buildResult;
        if (isBuildCancelled(buildResult)) Object.assign(error, buildResult);
        throw error;
      }

      if (payload.preprocessOnly) return buildResult;
      this.notifyBuildCompletion(buildResult, true);
      if (checkpoint?.startedAt) persistBuildResult(projectPath, true, buildResult, undefined, checkpoint, payload.source);
      this.buildFinishedSubject.next({ projectPath, success: true, result: buildResult });
      return buildResult;
    } catch (error: any) {
      if (!error || typeof error !== 'object') error = new Error(String(error));
      // Editor admission (busy/stale/unmounted) does not attest a compiler exit.
      if (!checkpoint?.startedAt) error.buildOutcome = 'not-started';
      if (payload.preprocessOnly) throw error;
      // console.error('编译失败:', error);
      this.notifyBuildCompletion(error, false);
      if (checkpoint?.startedAt && error?.buildOutcome !== 'not-started') persistBuildResult(projectPath, false, error?.buildResult, error, checkpoint, payload.source);
      this.buildFinishedSubject.next({ projectPath, success: false, result: error?.buildResult, error });
      throw error;
    }
  }

  private isSameProjectPath(left: string, right: string): boolean {
    const normalize = (value: string) => String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/u, '')
      .toLowerCase();
    return normalize(left) === normalize(right);
  }

  private async buildFromProjectPath(projectPath: string, options: { preprocessOnly?: boolean; source?: BuildResultSnapshot['source']; requestId?: string } = {}) {
    let compileResult: Awaited<ReturnType<CompileService['runCompileFromDisk']>>;
    try {
      await this.persistActiveCoderProjectBeforeBuild(projectPath);
      compileResult = await this.compileService.runCompileFromDisk({ projectPath, ...options });
    } catch (error) {
      this.notifyBuildCompletion(error, false, options);
      throw error;
    }
    const buildResult = compileResult.result;
    if (!compileResult.success || buildResult?.state === 'error') {
      const error: any = new Error(buildResult?.text || 'Build failed');
      error.state = buildResult?.state || 'error';
      error.text = buildResult?.text || 'Build failed';
      error.fullStdErr = buildResult?.fullStdErr;
      error.buildLog = buildResult?.buildLog;
      error.buildInput = buildResult?.buildInput;
      error.buildOutcome = buildResult?.buildOutcome;
      error.buildResult = buildResult;
      if (isBuildCancelled(buildResult)) Object.assign(error, buildResult);
      if (!options.preprocessOnly && buildResult?.buildOutcome !== 'not-started') persistBuildResult(projectPath, false, buildResult, error, undefined, options.source);
      this.buildFinishedSubject.next({ projectPath, success: false, result: buildResult, error });
      this.notifyBuildCompletion(error, false, options);
      throw error;
    }

    if (!options.preprocessOnly) persistBuildResult(projectPath, true, buildResult, undefined, undefined, options.source);
    this.buildFinishedSubject.next({ projectPath, success: true, result: buildResult });
    this.notifyBuildCompletion(buildResult, true, options);
    return buildResult;
  }

  /** 编译结果由实际执行窗口提醒；预处理、取消和未启动不发送完成通知。 */
  private notifyBuildCompletion(result: any, success: boolean, options: { preprocessOnly?: boolean } = {}): void {
    const outcome = result?.buildOutcome || result?.buildResult?.buildOutcome;
    if (
      options.preprocessOnly
      || outcome === 'cancelled'
      || outcome === 'not-started'
      || result?.code === 'BUILD_CANCELLED'
      || this.electronService.isWindowFocused()
    ) return;
    void this.electronService.notify(
      '编译',
      result?.text || result?.message || (success ? '编译完成' : '编译失败'),
    );
  }

  /**
   * Coder compiles persistent source directly from sketch/. Flush the embedded
   * editor before the disk read so manual builds, uploads, and Agent builds
   * cannot compile an older editor revision. Blockly keeps its existing
   * compile-begin/project-save workflow and never enters this branch.
   */
  private async persistActiveCoderProjectBeforeBuild(projectPath: string): Promise<void> {
    if (
      !projectPath
      || !this.projectService.isAilyCodeProject(projectPath)
      || !this.projectService.coderProjects.some(project => this.isSameProjectPath(projectPath, project.path))
    ) {
      return;
    }

    const feedback = await firstValueFrom(
      this.actionService.dispatchWithFeedback(
        'project-save',
        { path: projectPath },
        15_000,
      ),
    );
    if (feedback?.success !== true) {
      throw new Error(
        feedback?.error
        || 'aily Coder source could not be saved to disk before compilation.',
      );
    }
  }

  /** 本地与云端复用都先把当前编辑器内容保存到磁盘。 */
  async canReuseBuildForUpload(projectPath: string, isCancelled: () => boolean = () => false): Promise<boolean> {
    if (!this.projectService.isAilyCodeProject(projectPath)) return false;
    const cloud = this.projectService.isCloudBuild(projectPath);
    if (!cloud && !window['builder']?.canReuseCoderUpload) return false;
    await this.persistActiveCoderProjectBeforeBuild(projectPath);
    if (isCancelled() || this.projectService.isCloudBuild(projectPath) !== cloud) return false;
    return cloud ? this.compileService.canReuseCloudBuildForUpload(projectPath, isCancelled)
      : this.compileService.canReuseLocalCoderBuildForUpload(projectPath, isCancelled);
  }

  /** 取消当前编译过程。 */
  cancel(projectPath = this.projectService.currentProjectPath) {
    if (this.coderExecution && this.projectService.isAilyCodeProject(projectPath) && !this.projectService.isCoderProjectContext) { this.coderExecution.cancel(projectPath, 'build'); return; }
    this.compileService.cancel();
    if (this.projectService.isCoderProjectContext) return;
    this.actionService.dispatch('compile-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }

  cancelActiveBlocklyProjectBuild(requestId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      return;
    }
    this.actionService.dispatch('compile-cancel', { requestId }, result => {
      if (!result.success) {
        console.warn('Scoped Blockly Build cancellation was rejected.', result);
      }
    });
  }

  /**
   * 触发预编译操作
   * 用于配置变更后触发自动预编译
   * @param reason 触发原因，用于日志记录
   */
  triggerPreprocess(reason: string = 'manual') {
    console.log(`触发预编译操作，原因: ${reason}`);
    this.actionService.dispatch('preprocess-trigger', { reason }, result => {
      if (result.success) {
        console.log('预编译触发成功');
      } else {
        console.warn('预编译触发失败:', result);
      }
    });
  }

  /** Only the mounted editor may admit a cache-mutating advisory request. */
  triggerPreprocessWithCacheClear(projectPath: string, reason: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.actionService.dispatch<Record<string, unknown>>(
        'preprocess-trigger', { reason, projectPath, clearCache: true }, feedback => {
          if (feedback.success && feedback.data?.['success'] === true) resolve();
          else reject(feedback.data?.['error'] ?? Object.assign(
            new Error(feedback.error || 'The active Blockly preprocessing executor is unavailable.'),
            { buildOutcome: 'not-started' },
          ));
        }, 0, { requireHandler: true },
      );
    });
  }

  usesSharedBuildCache(projectPath: string): boolean {
    return !!projectPath && window['builder']?.sharedBuildExecutionVersion === 1
      && !this.projectService.isAilyCodeProject(projectPath) && !this.projectService.isCloudBuild();
  }

  private async clearSharedBuildCache(projectPath: string, preserveSketch: boolean): Promise<void> {
    const bridge = window['builder'];
    if (typeof bridge?.clearSharedBuildCache !== 'function') {
      throw new Error('Shared build cache cleanup is unavailable.');
    }
    await bridge.clearSharedBuildCache(projectPath, { preserveSketch });
  }

  /**
   * 清除可安全重建的编译与本地库缓存，保留当前 Blockly 生成的 sketch。
   * 供需要在同一次调用中立即继续构建的流程使用。
   */
  async clearBuildCache(projectPath: string): Promise<void> {
    if (this.usesSharedBuildCache(projectPath)) return this.clearSharedBuildCache(projectPath, true);
    const buildPath = this.electronService.pathJoin(projectPath, '.build');
    const isAilyCode = this.projectService.isAilyCodeProject(projectPath);
    const librariesPath = this.electronService.pathJoin(projectPath, '.temp', 'libraries');
    const libraryCachePath = this.electronService.pathJoin(
      projectPath,
      isAilyCode ? 'sketch' : '.temp',
      'library-cache.json',
    );

    console.log('清除编译产物:', buildPath);
    await this.crossPlatformCmdService.removeItem(buildPath, true, true);

    if (!isAilyCode && window['fs'].existsSync(librariesPath)) {
      console.log('清除本地库物化缓存:', librariesPath);
      await this.crossPlatformCmdService.removeItem(librariesPath, true, true);
    }

    if (window['fs'].existsSync(libraryCachePath)) {
      console.log('清除本地库指纹缓存:', libraryCachePath);
      await this.crossPlatformCmdService.removeItem(libraryCachePath, false, true);
    }

    {
      const preprocessResultPath = this.electronService.pathJoin(
        projectPath,
        isAilyCode ? 'sketch' : '.temp',
        'preprocess.json',
      );
      if (window['fs'].existsSync(preprocessResultPath)) {
        console.log('清除 Coder 预处理结果:', preprocessResultPath);
        await this.crossPlatformCmdService.removeItem(
          preprocessResultPath,
          false,
          true,
        );
      }
    }
  }

  /**
   * 完整清除缓存。该操作会删除生成的 sketch，仅用于随后会重新预处理的流程。
   */
  async clearCache(projectPath: string) {
    if (this.usesSharedBuildCache(projectPath)) return this.clearSharedBuildCache(projectPath, false);
    try {
      const tempPath = projectPath + '/.temp';
      const buildPath = this.electronService.pathJoin(projectPath, '.build');
      console.log('编译缓存路径:', buildPath);
      await this.crossPlatformCmdService.removeItem(buildPath, true, true);

      if (this.projectService.isAilyCodeProject(projectPath)) {
        // sketch/src 与 sketch/libraries 是 Coder 的持久化工程内容，只移除可重建配置。
        for (const fileName of [
          'preprocess.json',
          'library-cache.json',
          'build-config.json',
          'upload-config.json',
        ]) {
          const generatedPath = this.electronService.pathJoin(projectPath, 'sketch', fileName);
          if (window['fs'].existsSync(generatedPath)) {
            await this.crossPlatformCmdService.removeItem(generatedPath, false, true);
          }
        }
        console.log('Coder 编译缓存已清除，sketch/src 与 sketch/libraries 已保留');
        return;
      }

      // 删除 Blockly 项目下的 .temp 文件夹。
      if (window['fs'].existsSync(tempPath)) {
        console.log('删除项目下的.temp文件夹:', tempPath);
        await this.crossPlatformCmdService.removeItem(tempPath, true, true);
      } else {
        console.log('.temp文件夹不存在，无需删除');
      }
      console.log('编译缓存清除完成');
    } catch (error) {
      console.log('清除编译缓存时发生错误:', error);
      // 不抛出异常，只记录日志
    }
  }
}
