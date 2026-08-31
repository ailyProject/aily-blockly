import { Injectable } from '@angular/core';
import { AILY_BLOCKLY_USED_LIBRARIES_FIELD, BlocklyProjectDocument, BlocklyService } from './blockly.service';
import { ActionService } from '@core/app-shell/public-api';
import {
  normalizeArduinoGeneratedCode,
} from '../components/blockly/generators/arduino/arduino';
import {
  getActiveProjectGenerator,
  runWithPreparedActiveProjectGenerator,
} from './blockly-generator-runtime.service';
import { ElectronService } from '@core/platform/public-api';
import {
  projectDataRuntime,
  assertNoOversizedInlineValues,
  externalizeGenericProjectDataValues,
  materializePreparedGenericProjectDataValues,
} from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';
import { writeArduinoGeneratedArtifacts } from './generated-code-artifacts';


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
      const abi = this.getComparableAbiJson();
      return abi.memory !== abi.disk;
    } catch (error) {
      console.error('检查未保存更改时出错:', error);
      // 出错时，保守地返回 true，表示可能有未保存的更改
      return true;
    }
  }

  async getAbiRevisionSnapshot(): Promise<{
    algorithm: 'sha256';
    scope: 'normalized-materialized-project-abi';
    memoryHash: string;
    diskHash: string;
    changed: boolean;
  }> {
    const abi = this.getComparableAbiJson();
    const [memoryHash, diskHash] = await Promise.all([
      sha256Hex(abi.memory),
      sha256Hex(abi.disk),
    ]);

    return {
      algorithm: 'sha256',
      scope: 'normalized-materialized-project-abi',
      memoryHash,
      diskHash,
      changed: memoryHash !== diskHash,
    };
  }

  private getComparableAbiJson(): { memory: string; disk: string } {
    const memoryAbi = this.blocklyService.normalizeProjectAbi(
      this.blocklyService.getProjectAbiForSave(),
    );
    const diskExternalAbi = JSON.parse(
      window['fs'].readFileSync(`${this.currentProjectPath}/project.abi`, 'utf8'),
    );
    const diskAbi = this.blocklyService.normalizeProjectAbi(
      materializePreparedGenericProjectDataValues(
        diskExternalAbi,
        (ref) => projectDataRuntime.getPrepared(ref),
      ),
    );

    return {
      memory: JSON.stringify(memoryAbi),
      disk: JSON.stringify(diskAbi),
    };
  }

  async save(path: string, createHistory: boolean = true) {
    await projectDataRuntime.flushPending();
    const projectDocument = this.blocklyService.getProjectDocument();
    const inlineJsonData = this.blocklyService.getProjectAbiForSave(projectDocument);
    const { document: jsonData } = await externalizeGenericProjectDataValues(
      inlineJsonData,
      projectDataRuntime,
    );
    await projectDataRuntime.flushPending();
    assertNoOversizedInlineValues(jsonData);
    const refs = projectDataRuntime.getStore().collectReferences(jsonData);
    const validation = await projectDataRuntime.getStore().validateReferences(refs);
    if (!validation.valid) {
      throw new Error(`Project data validation failed: ${validation.issues.map((issue) => issue.error).join('; ')}`);
    }
    const abiPath = `${path}/project.abi`;
    const tempPath = `${abiPath}.tmp`;
    window['fs'].writeFileSync(tempPath, JSON.stringify(jsonData));
    window['fs'].renameSync(tempPath, abiPath);
    this.syncUsedLibraryManifest(path, projectDocument);
    
    // 更新 codeHash 以反映当前代码状态
    // 这样当代码改变后同步时，服务器能够检测到代码已改变
    await this.updateCodeHash(path, projectDocument);
    
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
  private async updateCodeHash(path: string, projectDocument?: BlocklyProjectDocument) {
    try {
      if (!getActiveProjectGenerator() || !this.blocklyService || !this.blocklyService.workspace) {
        console.warn('无法生成代码哈希，跳过更新');
        return;
      }

      // 复用最近一次成功生成的代码；如果工作区已变更但防抖生成尚未完成，再同步生成一次。
      const generated = await runWithPreparedActiveProjectGenerator(
        this.blocklyService.workspace,
        (generator) => ({
          code: this.blocklyService.getReusableGeneratedCode()
            ?? normalizeArduinoGeneratedCode(generator.workspaceToCode(this.blocklyService.workspace)),
          generator,
        }),
        projectDocument ?? this.blocklyService.getProjectDocument(),
      );
      const { code, generator } = generated;
      await writeArduinoGeneratedArtifacts(path, generator);
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
