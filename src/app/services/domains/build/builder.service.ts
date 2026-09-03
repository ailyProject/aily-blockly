import { Inject, Injectable } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import {
  CmdService,
  CrossPlatformCmdService,
  ElectronService,
} from '@core/platform/public-api';
import { CompileService } from './compile.service';
import { BUILD_ACTION_PORT, type BuildActionPort } from './ports/build-action.port';

export interface BuildFinishedEvent {
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
  async build(projectPath?: string) {
    if (projectPath) {
      return this.buildFromProjectPath(projectPath);
    }

    return this.buildCurrentBlocklyProject({});
  }

  /**
   * Build one exact active Blockly Project for a provider-owned request.
   * The request id is forwarded so cancellation cannot terminate an unrelated
   * manual build.
   */
  async buildActiveBlocklyProject(input: ActiveBlocklyProjectBuildInput) {
    const projectPath = String(input?.projectPath || '').trim();
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
        this.projectService.currentProjectPath,
      )
      || this.projectService.isAilyCodeProject(projectPath)
      || !this.actionService.hasListener('builder-compile-begin')
    ) {
      throw new Error('The requested Blockly Project is not active.');
    }
    return this.buildCurrentBlocklyProject({
      graphSemanticRevision,
      requestId,
    });
  }

  private async buildCurrentBlocklyProject(
    payload: {
      graphSemanticRevision?: string;
      requestId?: string;
    },
  ) {
    try {
      await this.persistActiveCoderProjectBeforeBuild(
        this.projectService.currentProjectPath,
      );
      // Pro / code-editor-pro 路由下 Blockly 未挂载，compile-begin 无监听者会一直等反馈；
      // Coder 工程改为直接走磁盘源码 + 同一套 preprocess/compile 脚本。
      let feedback: any;
      if (!this.actionService.hasListener('builder-compile-begin')) {
        const r = await this.compileService.runCompileFromDisk();
        feedback = {
          success: true,
          data: { success: r.success, result: r.result },
        };
      } else {
        feedback = await this.actionService.dispatchWithFeedback(
          'compile-begin',
          payload,
          600000,
        ).toPromise();
      }

      // listener handler 内部 catch 了编译错误，所以 feedback.success 总是 true
      // 需要检查 data.success 来判断编译是否真正成功
      const buildResult = feedback?.data?.result;
      const buildSuccess = feedback?.success !== false
        && feedback?.data?.success !== false
        && !!buildResult
        && buildResult?.state !== 'error';

      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('编译', buildResult?.text || '');
      }

      if (!buildSuccess) {
        // 编译失败，构造包含状态和错误详情的错误对象抛出
        const error: any = new Error(buildResult?.text || feedback?.error || '编译失败');
        error.state = buildResult?.state || 'error';
        error.text = buildResult?.text || feedback?.error || '编译失败';
        error.fullStdErr = buildResult?.fullStdErr;
        error.buildResult = buildResult;
        this.buildFinishedSubject.next({ success: false, result: buildResult, error });
        throw error;
      }

      this.buildFinishedSubject.next({ success: true, result: buildResult });
      return buildResult;
    } catch (error: any) {
      // console.error('编译失败:', error);
      if (!this.electronService.isWindowFocused()) {
        this.electronService.notify('编译', error?.text || error?.message || '编译失败');
      }
      // 上面 buildSuccess 分支已经发过一次；这里捕获的是其它异常路径，统一兜底
      if (!error?.__buildFinishedEmitted) {
        this.buildFinishedSubject.next({ success: false, error });
      }
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

  private async buildFromProjectPath(projectPath: string) {
    await this.persistActiveCoderProjectBeforeBuild(projectPath);
    const compileResult = await this.compileService.runCompileFromDisk({ projectPath });
    const buildResult = compileResult.result;
    if (!compileResult.success || buildResult?.state === 'error') {
      const error: any = new Error(buildResult?.text || 'Build failed');
      error.state = buildResult?.state || 'error';
      error.text = buildResult?.text || 'Build failed';
      error.fullStdErr = buildResult?.fullStdErr;
      error.buildResult = buildResult;
      this.buildFinishedSubject.next({ success: false, result: buildResult, error });
      throw error;
    }

    this.buildFinishedSubject.next({ success: true, result: buildResult });
    return buildResult;
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
      || !this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)
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
        || 'Aily Coder source could not be saved to disk before compilation.',
      );
    }
  }

  /*
   * 取消当前编译过程
   */
  cancel() {
    this.compileService.cancel();
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

  /**
   * 清除可安全重建的编译与本地库缓存，保留当前 Blockly 生成的 sketch。
   * 供需要在同一次调用中立即继续构建的流程使用。
   */
  async clearBuildCache(projectPath: string): Promise<void> {
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

    if (isAilyCode) {
      const preprocessResultPath = this.electronService.pathJoin(
        projectPath,
        'sketch',
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
