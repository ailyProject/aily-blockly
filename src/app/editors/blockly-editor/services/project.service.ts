import { Injectable } from '@angular/core';
import { AILY_BLOCKLY_USED_LIBRARIES_FIELD, BlocklyProjectDocument, BlocklyService } from './blockly.service';
import { ActionService } from '../../../services/action.service';
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

  destroy() {
    this.actionService.unlisten('project-save-handler');
    this.actionService.unlisten('project-check-unsaved-handler');
    this.initialized = false; // 重置初始化状态
  }

  close() {

  }

  hasUnsavedChanges(): boolean {
    try {
      // 获取当前实际会保存到 project.abi 的数据；单页会保持旧版 workspace JSON 格式。
      const currentProjectAbi = this.blocklyService.getProjectAbiForSave();

      // 读取并解析已保存的 JSON 数据
      const savedJsonStr = window['fs'].readFileSync(`${this.currentProjectPath}/project.abi`, 'utf8');
      const savedJson = this.blocklyService.normalizeProjectAbi(JSON.parse(savedJsonStr));

      // 将当前工作区 JSON 和保存的 JSON 转为字符串进行比较
      const currentJsonStr = JSON.stringify(this.blocklyService.normalizeProjectAbi(currentProjectAbi));
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
    const projectDocument = this.blocklyService.getProjectDocument();
    const jsonData = this.blocklyService.getProjectAbiForSave(projectDocument);
    window['fs'].writeFileSync(`${path}/project.abi`, JSON.stringify(jsonData));
    this.syncUsedLibraryManifest(path, projectDocument);
    
    // 更新 codeHash 以反映当前代码状态
    // 这样当代码改变后同步时，服务器能够检测到代码已改变
    await this.updateCodeHash(path);
    
    // this.stateSubject.next('saved');
  }

  syncUsedLibraryManifest(path: string, projectDocument?: BlocklyProjectDocument): boolean {
    const packageJsonPath = `${path}/package.json`;
    try {
      if (!window['fs'].existsSync(packageJsonPath)) {
        return false;
      }

      const originalContent = window['fs'].readFileSync(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(originalContent);
      packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD] = this.blocklyService.getProjectUsedLibraryManifest(packageJson, projectDocument);
      const nextContent = JSON.stringify(packageJson, null, 2);
      if (nextContent !== originalContent) {
        window['fs'].writeFileSync(packageJsonPath, nextContent);
      }
      this.currentPackageData = packageJson;
      window['packageJson'] = packageJson;
      return nextContent !== originalContent;
    } catch (error) {
      console.error('更新项目使用库清单失败:', error);
      return false;
    }
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

      // 复用最近一次成功生成的代码；如果工作区已变更但防抖生成尚未完成，再同步生成一次。
      const code = this.blocklyService.getReusableGeneratedCode()
        ?? arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
      this.blocklyService.publishGeneratedCode(code);
      
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

}
