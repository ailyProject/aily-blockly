import { Component, OnInit } from '@angular/core';
import { ProjectService } from '../../../../services/project.service';
import { ElectronService } from '../../../../services/electron.service';
import { BuilderService } from '../../../../services/builder.service';
import { ActionService } from '../../../../services/action.service';
import { WorkflowService, ProcessState } from '../../../../services/workflow.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { FormsModule } from '@angular/forms';
import { ConfigService } from '../../../../services/config.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';

@Component({
  selector: 'app-dev-tool',
  imports: [
    FormsModule,
    NzToolTipModule
  ],
  templateUrl: './dev-tool.component.html',
  styleUrl: './dev-tool.component.scss'
})
export class DevToolComponent implements OnInit {
  // 拖拽相关属性
  isDragging = false;
  dragStartX = 0;
  dragStartY = 0;
  currentX = 185; // 初始 left 值
  currentY = 1; // 初始 bottom 值
  offsetX = 0;
  offsetY = 0;

  private _autoSave: boolean = true;

  get autoSave(): boolean {
    return this._autoSave;
  }

  set autoSave(value: boolean) {
    this._autoSave = value;
    // 保存到配置
    // 检查 devmode 是否为旧格式的 boolean,如果是则转换为新格式
    if (typeof this.configService.data.devmode === 'boolean') {
      const oldValue = this.configService.data.devmode;
      this.configService.data.devmode = { enabled: oldValue, autoSave: true };
    } else if (!this.configService.data.devmode) {
      this.configService.data.devmode = { enabled: false, autoSave: true };
    }
    this.configService.data.devmode.autoSave = value;
    this.configService.save();
  }

  constructor(
    private projectService: ProjectService,
    private electronService: ElectronService,
    private messageService: NzMessageService,
    private configService: ConfigService,
    private builderService: BuilderService,
    private actionService: ActionService,
    private workflowService: WorkflowService
  ) {

  }

  ngOnInit() {
    // 从配置中读取 autoSave 状态，默认为 true
    // 检查 devmode 是否为旧格式的 boolean,如果是则转换为新格式
    if (typeof this.configService.data.devmode === 'boolean') {
      const oldValue = this.configService.data.devmode;
      this.configService.data.devmode = { enabled: oldValue, autoSave: true };
    } else if (!this.configService.data.devmode) {
      this.configService.data.devmode = { enabled: false, autoSave: true };
    }
    this._autoSave = this.configService.data.devmode.autoSave ?? true;
  }

  onDragStart(event: MouseEvent) {
    this.isDragging = true;
    this.dragStartX = event.clientX - this.currentX;
    this.dragStartY = event.clientY;
    this.offsetY = window.innerHeight - this.currentY; // 计算从顶部的偏移

    // 添加全局事件监听
    document.addEventListener('mousemove', this.onDrag);
    document.addEventListener('mouseup', this.onDragEnd);

    event.preventDefault();
  }

  onDrag = (event: MouseEvent) => {
    if (!this.isDragging) return;

    // 计算新位置
    this.currentX = event.clientX - this.dragStartX;
    this.currentY = window.innerHeight - event.clientY + (this.dragStartY - this.offsetY);

    // 限制在可视区域内
    const topExclusionZone = 70; // 顶部禁用区域高度
    const componentHeight = 40; // 假设组件高度约40px
    const componentWidth = 282; // 假设组件宽度约270px

    const maxX = window.innerWidth - componentWidth;
    const minY = 1; // 最小bottom值
    const maxY = window.innerHeight - topExclusionZone - componentHeight; // 不能进入顶部40px区域

    this.currentX = Math.max(0, Math.min(this.currentX, maxX));
    this.currentY = Math.max(minY, Math.min(this.currentY, maxY));
  }

  onDragEnd = () => {
    this.isDragging = false;

    // 移除全局事件监听
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.onDragEnd);
  }

  ngOnDestroy() {
    // 清理事件监听器
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.onDragEnd);
  }

  reload() {
    // 如果开启了自动保存,先保存项目
    if (this.autoSave) {
      this.projectService.save();
      // 给一点时间让保存完成
      // console.log('页面重载中...');
      setTimeout(() => {
        this.projectService.projectOpen();
      }, 100);
    } else {
      this.projectService.projectOpen();
    }
  }

  async clear() {
    // 检查是否正在编译或上传，如果是则禁止清除缓存
    const currentState = this.workflowService.currentState;
    if (currentState === ProcessState.BUILDING || currentState === ProcessState.UPLOADING) {
      this.messageService.warning('Cannot clear cache while compiling or uploading');
      return;
    }

    try {
      // 先停止预编译进程，避免删除文件时发生冲突
      await new Promise<void>((resolve) => {
        this.actionService.dispatch('preprocess-stop', {}, (feedback) => {
          if (feedback.success) {
            console.log('预编译进程已停止');
          }
          resolve();
        }, 3000);
      });

      const defaultBuildPath = await this.projectService.getBuildPath();
  
      // 检查目录是否存在
      if (window['fs'].existsSync(defaultBuildPath)) {
        // 删除buildPath目录
        console.log('Deleting build folder:', defaultBuildPath);
        this.electronService.deleteDir(defaultBuildPath);
      }

      // 检查.temp目录是否存在
      const tempDirPath = this.electronService.pathJoin(this.projectService.currentProjectPath, '.temp');
      if (this.electronService.exists(tempDirPath)) {
        console.log('Deleting .temp directory:', tempDirPath);
        this.electronService.deleteDir(tempDirPath);
      }

      this.messageService.success('Clear build folder success');
    } catch (error) {
      if (error.message && error.message.includes('EBUSY')) {
        console.warn('Clear build folder failed: Folder is busy');
        this.messageService.warning('Clear build folder failed: Folder is busy, wait a moment and try again.');
      } else {
        console.error('Clear build folder error:', error);
        this.messageService.error('Clear build folder failed: ' + error.message);
      }
    }
  }

  openWebDevTools() {
    // 打开开发者工具
    window['ipcRenderer'].send('open-dev-tools');
  }

  help() {

  }

  close() {

  }

  openResources() {
    this.electronService.openByExplorer(window['path'].getAppDataPath());
  }

  async openCompileFolder() {
    const buildPath = await this.projectService.getBuildPath();
    if (!this.electronService.exists(buildPath)) {
      this.messageService.warning('Compile folder does not exist');
      return;
    }
    this.electronService.openByExplorer(buildPath);
  }
}
