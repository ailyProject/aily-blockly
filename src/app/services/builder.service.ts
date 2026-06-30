import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { ProjectService } from './project.service';
import { ActionState } from './ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../services/notice.service';
import { CmdOutput, CmdService } from './cmd.service';
import { CrossPlatformCmdService } from './cross-platform-cmd.service';
import { ActionService } from './action.service';
import { ElectronService } from './electron.service';
import { AilyCodeProCompileService } from './aily-code-pro-compile.service';

import { getDefaultBuildPath, findFile } from '../utils/builder.utils';


export interface BuildFinishedEvent {
  success: boolean;
  result?: any;
  error?: any;
}

@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  /** 编译流程结束（成功/失败/取消）后广播；订阅者用于刷新依赖产物路径的视图（如内嵌 Coder 的 main.hex）。 */
  readonly buildFinishedSubject = new Subject<BuildFinishedEvent>();

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    private ailyCodeProCompile: AilyCodeProCompileService,
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

    try {
      // Pro / code-editor-pro 路由下 Blockly 未挂载，compile-begin 无监听者会一直等反馈；
      // 含 project.aci 时改为直接走磁盘源码 + 同一套 preprocess/compile 脚本。
      let feedback: any;
      if (!this.actionService.hasListener('builder-compile-begin')) {
        const r = await this.ailyCodeProCompile.runCompileFromDisk();
        feedback = {
          success: true,
          data: { success: r.success, result: r.result },
        };
      } else {
        feedback = await this.actionService.dispatchWithFeedback('compile-begin', {}, 600000).toPromise();
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

  private async buildFromProjectPath(projectPath: string) {
    const compileResult = await this.ailyCodeProCompile.runCompileFromDisk({ projectPath });
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

  /*
   * 取消当前编译过程
   */
  cancel() {
    this.ailyCodeProCompile.cancel();
    this.actionService.dispatch('compile-cancel', {}, result => {
      if (result.success) {
      } else {
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
   * 清除缓存
   */
  async clearCache(projectPath: string) {
    try {
      const tempPath = projectPath + '/.temp';
      const sketchPath = tempPath + '/sketch';
      const sketchFilePath = await findFile(sketchPath, '*.ino');
      console.log('清除编译缓存:', sketchPath);
      const buildPath = await getDefaultBuildPath(sketchFilePath);
      console.log('编译缓存路径:', buildPath);
      await this.crossPlatformCmdService.removeItem(buildPath, true, true);

      // 删除项目下的.temp文件夹，如果存在的话
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
