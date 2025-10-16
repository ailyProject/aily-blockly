import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { ActionState } from './ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../services/notice.service';
import { CmdOutput, CmdService } from './cmd.service';
import { ActionService } from './action.service';

import { getDefaultBuildPath, findFile } from '../utils/builder.utils';


@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
    private cmdService: CmdService,
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
  async build() {
    try {
      const result = await this.actionService.dispatchWithFeedback('compile-begin', {}, 600000).toPromise();
      console.log('>>>>> 编译结果:', result);
      return result.data?.result;
    } catch (error) {
      // console.error('编译失败:', error);
      throw error;
    }
  }

  /*
   * 取消当前编译过程
   */
  cancel() {
    this.actionService.dispatch('compile-cancel', {}, result => {
      if (result.success) {
      } else {
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
      await this.cmdService.runAsync(`Remove-Item -Path "${buildPath}" -Recurse -Force`)

      // 删除项目下的.temp文件夹，如果存在的话
      if (window['fs'].existsSync(tempPath)) {
        console.log('删除项目下的.temp文件夹:', tempPath);
        await this.cmdService.runAsync(`Remove-Item -Path "${tempPath}" -Recurse -Force`);
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
