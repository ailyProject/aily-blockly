import { Injectable } from '@angular/core';
import { BlocklyService } from './blockly.service';
import { ActionService } from '../../../services/action.service';
import { HistoryService } from './history.service';
import { arduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { ElectronService } from '../../../services/electron.service';


@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  currentProjectPath;
  currentPackageData;
  private initialized = false; // 防止重复初始化

  constructor(
    private blocklyService: BlocklyService,
    private actionService: ActionService,
    private historyService: HistoryService,
    private electronService: ElectronService
  ) { }

  init() {
    if (this.initialized) {
      console.warn('_ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;

    this.actionService.listen('project-save', async (action) => {
      await this.save(action.payload.path);
    }, 'project-save-handler');
    this.actionService.listen('project-check-unsaved', (action) => {
      let result = this.hasUnsavedChanges();
      return { hasUnsavedChanges: result };
    }, 'project-check-unsaved-handler');
  }

  // 初始化历史服务（在设置 currentProjectPath 后调用）
  initHistory() {
    if (this.currentProjectPath) {
      this.historyService.init(this.currentProjectPath, this.blocklyService);
    }
  }

  destroy() {
    this.actionService.unlisten('project-save-handler');
    this.actionService.unlisten('project-check-unsaved-handler');
    this.historyService.destroy();
    this.initialized = false; // 重置初始化状态
  }

  close() {

  }

  hasUnsavedChanges(): boolean {
    try {
      // 获取当前工作区的 JSON 数据
      const currentWorkspaceJson = this.blocklyService.getWorkspaceJson();

      // 读取并解析已保存的 JSON 数据
      const savedJsonStr = window['fs'].readFileSync(`${this.currentProjectPath}/project.abi`, 'utf8');
      const savedJson = JSON.parse(savedJsonStr);

      // 将当前工作区 JSON 和保存的 JSON 转为字符串进行比较
      const currentJsonStr = JSON.stringify(currentWorkspaceJson);
      const normalizedSavedJsonStr = JSON.stringify(savedJson);

      // 比较两个 JSON 字符串是否相同
      return currentJsonStr !== normalizedSavedJsonStr;
    } catch (error) {
      console.error('检查未保存更改时出错:', error);
      // 出错时，保守地返回 true，表示可能有未保存的更改
      return true;
    }
  }

  async save(path: string, createHistory: boolean = true) {
    const jsonData = this.blocklyService.getWorkspaceJson();
    window['fs'].writeFileSync(`${path}/project.abi`, JSON.stringify(jsonData, null, 2));
    
    if (createHistory && this.currentProjectPath) {
      // 创建手动保存的历史版本
      this.historyService.createManualVersion();
    }
    
    // 更新 codeHash 以反映当前代码状态
    // 这样当代码改变后同步时，服务器能够检测到代码已改变
    await this.updateCodeHash(path);
    
    // this.stateSubject.next('saved');
  }

  /**
   * 更新 package.json 中的 codeHash
   * 用于在项目保存时记录当前代码的哈希值
   */
  private async updateCodeHash(path: string) {
    try {
      if (!arduinoGenerator || !this.blocklyService || !this.blocklyService.workspace) {
        console.warn('无法生成代码哈希，跳过更新');
        return;
      }

      // 生成当前代码
      const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
      
      // 计算哈希
      if (this.electronService && this.electronService.calculateHash) {
        const codeHash = await this.electronService.calculateHash(code);
          // 读取 package.json 并更新 codeHash
          const packageJsonPath = `${path}/package.json`;
          try {
            const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
            packageJson.codeHash = codeHash;
            window['fs'].writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
            console.log('✅ codeHash 已更新:', codeHash.substring(0, 8) + '...');
          } catch (error) {
            console.error('更新 codeHash 失败:', error);
          }
      }
    } catch (error) {
      console.error('更新代码哈希时出错:', error);
    }
  }

  restoreVersion(versionId: string) {
    this.historyService.restoreVersion(versionId, (path: string) => {
      // 保存到文件 (覆盖当前项目文件)
      this.save(path, false);
    });
  }
}
