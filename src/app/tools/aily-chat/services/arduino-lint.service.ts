import { Injectable } from '@angular/core';
import { CmdService } from '../../../services/cmd.service';
import { CrossPlatformCmdService } from '../../../services/cross-platform-cmd.service';
import { ProjectService } from '../../../services/project.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { PlatformService } from "../../../services/platform.service";

// Arduino 代码检查器
declare const arduinoGenerator: any;

/**
 * Lint 检测模式
 */
export type LintMode = 'fast' | 'accurate' | 'auto' | 'ast-grep';

/**
 * Lint 输出格式
 */
export type LintFormat = 'human' | 'vscode' | 'json';

/**
 * Lint 检查选项
 */
export interface LintOptions {
  mode?: LintMode;           // 检测模式，默认 'auto'
  format?: LintFormat;       // 输出格式，默认 'json'
  timeout?: number;          // 超时时间，默认 10000ms
}

/**
 * Lint 检查结果（JSON格式）
 */
export interface LintResult {
  success: boolean;          // 是否检查成功
  errors: LintError[];       // 错误列表
  warnings: LintError[];     // 警告列表
  executionTime: number;     // 执行时间（毫秒）
  mode?: string;             // 实际使用的检测模式
}

/**
 * Lint 错误信息
 */
export interface LintError {
  file: string;              // 文件路径
  line: number;              // 行号
  column: number;            // 列号
  message: string;           // 错误信息
  severity: 'error' | 'warning'; // 严重程度
}

/**
 * Arduino Lint 服务
 * 基于 aily-builder 的 lint 功能，提供简化的代码语法检查
 */
@Injectable({
  providedIn: 'root'
})
export class ArduinoLintService {

  private lintInProgress = false;
  private lintSessionCount = 0; // 跟踪lint会话次数
  private readonly CLEANUP_INTERVAL = 10; // 每10次lint后执行一次清理
  
  // 当前项目路径 - 像 BuilderService 一样在方法开始时赋值，确保路径一致性
  private currentProjectPath = "";
  
  // 库缓存机制 - 避免重复处理
  private libraryCache = new Map<string, {
    timestamp: number;
    targetNames: string[];
  }>();

  constructor(
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private platformService: PlatformService,
  ) {
    // 将服务实例注册到全局对象，以便 ArduinoSyntaxTool 可以访问
    (window as any)['arduinoLintService'] = this;
    // console.log('🔧 ArduinoLintService 已注册到全局对象');
  }

  /**
   * 检查库缓存是否有效 - 参考 BuilderService.isLibraryCacheValid
   * @param lib 库名称
   * @param sourcePath 源码路径
   * @returns 缓存是否有效
   */
  private isLibraryCacheValid(lib: string, sourcePath: string): boolean {
    const cached = this.libraryCache.get(lib);
    if (!cached) return false;

    try {
      if (!window['fs'].existsSync(sourcePath)) return false;
      const stat = window['fs'].statSync(sourcePath);
      return stat.mtime.getTime() <= cached.timestamp;
    } catch {
      return false;
    }
  }

  /**
   * 检查 Arduino 代码语法
   * @param code Arduino 代码字符串
   * @param options 检查选项
   * @returns 检查结果
   */
  async checkSyntax(code: string, options: LintOptions = {}): Promise<LintResult> {
    const startTime = Date.now();
    
    // 设置默认选项
    const {
      mode = 'ast-grep',
      format = 'json',
      timeout = 10000
    } = options;

    try {
      if (this.lintInProgress) {
        // console.warn('⚠️ 检测到并发 lint 请求，重置状态后继续');
        this.lintInProgress = false; // 强制重置状态
        // 等待一小段时间确保之前的操作完成
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      this.lintInProgress = true;
      
      // 像 BuilderService 一样，在方法开始时统一赋值项目路径
      this.currentProjectPath = this.projectService.currentProjectPath;

      // console.log(`🔍 开始 Arduino 语法检查 (模式: ${mode}, 格式: ${format})...`);

      // 验证输入
      if (!code || code.trim().length === 0) {
        throw new Error('代码内容为空');
      }

      // 准备临时环境
      const tempEnv = await this.prepareTempEnvironment(code);
      
      try {
        // 执行 lint 检查
        const result = await this.executeLint(tempEnv, mode, format, timeout);
        
        // 解析结果
        const parsedResult = this.parseResult(result, startTime, mode, format);
        
        // console.log(`✅ Lint 检查完成: ${parsedResult.success ? '通过' : '失败'} (${parsedResult.executionTime}ms)`);
        
        return parsedResult;
        
      } finally {
        // 清理临时文件
        await this.cleanupTempFiles(tempEnv.tempPath);
      }

    } catch (error: any) {
      // console.warn('❌ Arduino 语法检查失败:', error);
      
      return {
        success: false,
        errors: [{
          file: 'sketch.ino',
          line: 1,
          column: 1,
          message: `语法检查失败: ${error.message}`,
          severity: 'error'
        }],
        warnings: [],
        executionTime: Date.now() - startTime,
        mode
      };
    } finally {
      this.lintInProgress = false;
    }
  }

  /**
   * 重置 lint 状态 (用于调试和错误恢复)
   */
  resetLintState(): void {
    // console.log('🔄 重置 Arduino lint 状态');
    this.lintInProgress = false;
  }

  /**
   * 检查当前 Blockly 工作区的代码
   * @param options 检查选项
   * @returns 检查结果
   */
  async checkCurrentWorkspace(options: LintOptions = {}): Promise<LintResult> {
    try {
      // 从 Blockly 工作区生成代码
      const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
      
      if (!code || code.trim().length === 0) {
        return {
          success: false,
          errors: [{
            file: 'workspace',
            line: 1,
            column: 1,
            message: '工作区为空，无法生成代码',
            severity: 'error'
          }],
          warnings: [],
          executionTime: 0,
          mode: options.mode || 'ast-grep'
        };
      }

      return await this.checkSyntax(code, options);
    } catch (error: any) {
      console.warn('检查当前工作区失败:', error);
      throw error;
    }
  }

  /**
   * 准备临时环境 - 复用项目的 .temp 目录，包含库准备
   */
  private async prepareTempEnvironment(code: string): Promise<{
    tempPath: string;
    sketchPath: string;
    sketchFilePath: string;
    librariesPath: string;
  }> {
    // 使用实例变量，确保与其他方法路径一致
    const tempPath = this.currentProjectPath + '/.temp';
    const sketchPath = tempPath + '/sketch';
    const sketchFilePath = sketchPath + '/sketch.ino';
    const librariesPath = tempPath + '/libraries';

    try {
      // 创建必要的目录结构（如果不存在）- 使用跨平台命令
      if (!window['path'].isExists(tempPath)) {
        await this.crossPlatformCmdService.createDirectory(tempPath, true);
        // console.log(`✅ 创建临时目录: ${tempPath}`);
      } else {
        // console.log(`♻️ 复用现有临时目录: ${tempPath}`);
      }
      
      if (!window['path'].isExists(sketchPath)) {
        await this.crossPlatformCmdService.createDirectory(sketchPath, true);
        // console.log(`✅ 创建 sketch 目录: ${sketchPath}`);
      }
      
      if (!window['path'].isExists(librariesPath)) {
        await this.crossPlatformCmdService.createDirectory(librariesPath, true);
        // console.log(`✅ 创建 libraries 目录: ${librariesPath}`);
      }

      // 准备项目库文件（新增：关键的库准备步骤）
      await this.prepareProjectLibraries(librariesPath);

      // 高效写入代码到 sketch.ino 文件（覆盖模式，无需预先删除）
      await window['fs'].writeFileSync(sketchFilePath, code);
      // console.log(`✅ 写入代码到: ${sketchFilePath} (${code.length} 字符)`);

      // console.log(`✅ 临时环境准备完成，复用项目 .temp 目录: ${tempPath}`);

      return {
        tempPath,
        sketchPath,
        sketchFilePath,
        librariesPath
      };
    } catch (error: any) {
      console.warn('准备 lint 环境失败:', error);
      throw new Error(`准备检查环境失败: ${error.message}`);
    }
  }

  /**
   * 执行 aily-builder lint 检查
   */
  private async executeLint(
    env: { tempPath: string; sketchPath: string; sketchFilePath: string; librariesPath: string; },
    mode: LintMode,
    format: LintFormat,
    timeout: number
  ): Promise<string> {
    try {
      // 构建 lint 命令
      const lintCommand = await this.buildLintCommand(env, mode, format);

      // console.log(`🚀 执行 lint 命令: ${lintCommand}`);

      // 收集所有输出
      let allOutput = '';
      let hasError = false;
      let errorMessage = '';

      return new Promise((resolve, reject) => {
        this.cmdService.run(lintCommand).subscribe({
          next: (output) => {
            // console.log('📋 cmdService 输出类型:', output.type);
            // console.log('📋 cmdService 输出数据:', output.data);
            
            if (output.type === 'stdout' && output.data) {
              allOutput += output.data;
            } else if (output.type === 'stderr' && output.data) {
              // stderr 也可能包含有效的 JSON 输出
              allOutput += output.data;
            } else if (output.type === 'error') {
              hasError = true;
              errorMessage = output.error || '命令执行失败';
            }
          },
          error: (error) => {
            console.warn('📋 cmdService 执行错误:', error);
            reject(new Error(`命令执行失败: ${error.message || error}`));
          },
          complete: () => {
            // console.log('📋 cmdService 执行完成，总输出:', allOutput);
            if (hasError && !allOutput.trim()) {
              reject(new Error(errorMessage));
            } else {
              resolve(allOutput);
            }
          }
        });
      });

    } catch (error: any) {
      console.warn('执行 lint 失败:', error);
      throw error;
    }
  }

  /**
   * 构建 aily-builder lint 命令
   */
  private async buildLintCommand(
    env: { sketchFilePath: string; librariesPath: string; },
    mode: LintMode,
    format: LintFormat
  ): Promise<string> {
    // 获取项目配置
    const packageJson = await this.projectService.getPackageJson();
    const boardJson = await this.projectService.getBoardJson();

    if (!boardJson) {
      throw new Error('未找到板子信息(board.json)');
    }

    // 获取编译参数并替换 compile 为 lint
    let compilerParam = boardJson.compilerParam;
    if (!compilerParam) {
      throw new Error('未找到编译命令(compilerParam)');
    }

    // 将 compile 替换为 lint，并清理不支持的参数
    let lintParam = compilerParam.replace(/\bcompile\b/g, 'lint');
    
    // 移除 lint 命令不支持的参数
    lintParam = lintParam.replace(/\s+-v\b/g, ''); // 移除 -v
    lintParam = lintParam.replace(/\s+--verbose\b/g, ''); // 移除已有的 --verbose
    
    // 添加 --verbose 以获取详细输出
    // lintParam += ' --verbose';

    // 提取板子类型
    let boardType = '';
    const compilerParamList = lintParam.split(' ');
    for (let i = 0; i < compilerParamList.length; i++) {
      if (compilerParamList[i] === '-b' || compilerParamList[i] === '--board') {
        if (i + 1 < compilerParamList.length) {
          boardType = compilerParamList[i + 1];
          break;
        }
      }
    }

    if (!boardType) {
      throw new Error('未找到板子类型');
    }

    // 获取工具版本信息
    const boardDependencies = (await this.projectService.getBoardPackageJson()).boardDependencies || {};
    const toolVersions: string[] = [];
    let sdk = '';

    Object.entries(boardDependencies).forEach(([key, version]) => {
      if (key.startsWith('@aily-project/compiler-')) {
        const compiler = key.replace(/^@aily-project\/compiler-/, '') + '@' + version;
        toolVersions.push(compiler);
      } else if (key.startsWith('@aily-project/sdk-')) {
        sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
      } else if (key.startsWith('@aily-project/tool-')) {
        let toolName = key.replace(/^@aily-project\/tool-/, '');
        if (toolName.startsWith('idf_')) {
          toolName = 'esp32-arduino-libs';
        }
        const tool = toolName + '@' + version;
        toolVersions.push(tool);
      }
    });

    if (!sdk) {
      throw new Error('未找到 SDK 信息');
    }

    // 构建路径
    const sdkPath = await window["env"].get('AILY_SDK_PATH') + `/${sdk}`;
    const toolsPath = await window["env"].get('AILY_TOOLS_PATH');

    // 构建完整的 lint 命令
    const lintCommandParts = [
      "node",
      `"${window['path'].getAilyBuilderPath()}/index.js"`,
      lintParam,
      `"${env.sketchFilePath}"`,
      '--board', `"${boardType}"`,
      '--libraries-path', `"${env.librariesPath}"`,
      '--sdk-path', `"${sdkPath}"`,
      '--tools-path', `"${toolsPath}"`,
      '--tool-versions', `"${toolVersions.join(',')}"`,
      '--mode', mode,
      '--format', format
    ];

    return lintCommandParts.join(' ');
  }

  /**
   * 解析 lint 检查结果
   */
  private parseResult(output: string, startTime: number, mode: LintMode, format: LintFormat): LintResult {
    const executionTime = Date.now() - startTime;

    try {
      if (format === 'json') {
        // 提取 JSON 部分 - aily-builder 输出可能包含日志信息
        // console.log('🔍 原始输出:', output);
        
        let jsonText = output;
        
        // 查找 JSON 对象的开始位置
        const jsonStart = output.indexOf('{');
        // console.log('📍 JSON 开始位置:', jsonStart);
        
        if (jsonStart !== -1) {
          // 从第一个 { 开始提取
          jsonText = output.substring(jsonStart);
          
          // 查找最后一个完整的 }
          let braceCount = 0;
          let jsonEnd = -1;
          for (let i = 0; i < jsonText.length; i++) {
            if (jsonText[i] === '{') braceCount++;
            if (jsonText[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                jsonEnd = i + 1;
                break;
              }
            }
          }
          
          if (jsonEnd !== -1) {
            jsonText = jsonText.substring(0, jsonEnd);
          }
        } else {
          // console.warn('⚠️ 未找到 JSON 开始标记，尝试直接解析整个输出');
        }
        
        // console.log('🔍 提取的 JSON 文本:', jsonText);
        // console.log('📏 JSON 文本长度:', jsonText.length);
        
        if (!jsonText.trim()) {
          throw new Error('提取的 JSON 文本为空');
        }
        
        // JSON 格式直接解析
        const jsonResult = JSON.parse(jsonText);
        return {
          success: jsonResult.success || false,
          errors: jsonResult.errors || [],
          warnings: jsonResult.warnings || [],
          executionTime: jsonResult.executionTime || executionTime,
          mode: jsonResult.mode || mode
        };
      } else if (format === 'vscode') {
        // VS Code 格式解析
        return this.parseVSCodeFormat(output, executionTime, mode);
      } else {
        // Human 格式解析
        return this.parseHumanFormat(output, executionTime, mode);
      }
    } catch (error) {
      console.warn('解析 lint 结果失败:', error);
      return {
        success: false,
        errors: [{
          file: 'sketch.ino',
          line: 1,
          column: 1,
          message: `结果解析失败: ${error.message}`,
          severity: 'error'
        }],
        warnings: [],
        executionTime,
        mode
      };
    }
  }

  /**
   * 解析 VS Code 格式输出
   */
  private parseVSCodeFormat(output: string, executionTime: number, mode: LintMode): LintResult {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];

    if (!output || output.trim().length === 0) {
      return {
        success: true,
        errors: [],
        warnings: [],
        executionTime,
        mode
      };
    }

    const lines = output.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // VS Code 格式: file(line,column): severity: message
      const match = trimmedLine.match(/^(.+)\((\d+),(\d+)\):\s+(error|warning|info):\s+(.+)$/);
      if (match) {
        const [, file, lineStr, colStr, severity, message] = match;
        
        const lintError: LintError = {
          file: file.trim(),
          line: parseInt(lineStr),
          column: parseInt(colStr),
          message: message.trim(),
          severity: severity.toLowerCase() === 'error' ? 'error' : 'warning'
        };

        if (lintError.severity === 'error') {
          errors.push(lintError);
        } else {
          warnings.push(lintError);
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      executionTime,
      mode
    };
  }

  /**
   * 解析 Human 格式输出
   */
  private parseHumanFormat(output: string, executionTime: number, mode: LintMode): LintResult {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];

    if (!output || output.trim().length === 0) {
      return {
        success: true,
        errors: [],
        warnings: [],
        executionTime,
        mode
      };
    }

    // 检查是否包含成功标识
    if (output.includes('✅ Syntax check passed!')) {
      return {
        success: true,
        errors: [],
        warnings: [],
        executionTime,
        mode
      };
    }

    // 检查是否包含失败标识
    if (output.includes('❌ Syntax check failed!')) {
      // 解析错误信息
      const lines = output.split('\n');
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // 尝试匹配错误格式: file:line:column
        const match = trimmedLine.match(/^(.+):(\d+):(\d+)\s+(.+)$/);
        if (match) {
          const [, file, lineStr, colStr, message] = match;
          
          errors.push({
            file: file.trim(),
            line: parseInt(lineStr),
            column: parseInt(colStr),
            message: message.trim(),
            severity: 'error'
          });
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      executionTime,
      mode
    };
  }

  /**
   * 清理临时文件 - 智能清理策略，避免频繁IO操作
   * 采用定期清理模式，只在特定条件下才执行实际清理
   */
  private async cleanupTempFiles(tempPath: string): Promise<void> {
    try {
      this.lintSessionCount++;
      
      // 智能清理策略：只在特定条件下执行清理
      const shouldCleanup = (
        this.lintSessionCount % this.CLEANUP_INTERVAL === 0 || // 每N次清理一次
        this.lintInProgress === false // 或者在非并发状态下
      );
      
      if (shouldCleanup) {
        const sketchFilePath = tempPath + '/sketch/sketch.ino';
        
        if (window['path'].isExists(sketchFilePath)) {
          await window['fs'].unlinkSync(sketchFilePath);
          // console.log(`🧹 定期清理临时文件: sketch.ino (第${this.lintSessionCount}次lint)`);
        }
      } else {
        // console.log(`✅ lint会话 #${this.lintSessionCount} 完成（跳过清理以提升性能）`);
      }
      
      // console.log('📝 临时文件保留策略: 减少IO开销，下次覆盖写入');
    } catch (error) {
      console.warn('清理检查失败:', error);
      // 不抛出错误，避免影响主要功能
    }
  }

  /**
   * 手动清理临时文件 - 提供给用户的显式清理方法
   */
  async forceCleanupTempFiles(): Promise<void> {
    try {
      // 使用实例变量
      const tempPath = this.currentProjectPath + '/.temp';
      const sketchFilePath = tempPath + '/sketch/sketch.ino';
      
      if (window['path'].isExists(sketchFilePath)) {
        await window['fs'].unlinkSync(sketchFilePath);
        // console.log('🧹 手动清理 lint 临时文件完成');
      }
      
      // 重置计数器
      this.lintSessionCount = 0;
    } catch (error) {
      console.warn('手动清理失败:', error);
      throw error;
    }
  }

  /**
   * 检查服务是否可用
   */
  isAvailable(): boolean {
    try {
      // console.log('🔍 检查 aily-builder 可用性...');
      
      // 检查 window['path'] 是否存在
      if (!window['path']) {
        // console.warn('❌ window.path 不存在');
        return false;
      }
      
      // 检查 getAilyBuilderPath 方法
      if (typeof window['path'].getAilyBuilderPath !== 'function') {
        // console.warn('❌ window.path.getAilyBuilderPath 方法不存在');
        return false;
      }
      
      const ailyBuilderPath = window['path'].getAilyBuilderPath();
      // console.log('- aily-builder 路径:', ailyBuilderPath);
      
      if (!ailyBuilderPath) {
        // console.warn('❌ aily-builder 路径为空');
        return false;
      }
      
      // 检查 isExists 方法
      if (typeof window['path'].isExists !== 'function') {
        // console.warn('❌ window.path.isExists 方法不存在');
        return false;
      }
      
      const indexJsExists = window['path'].isExists(ailyBuilderPath + '/index.js');
      // console.log('- index.js 存在:', indexJsExists);
      
      return indexJsExists;
    } catch (error) {
      console.warn('检查 aily-builder 可用性失败:', error);
      return false;
    }
  }

  /**
   * 获取服务状态
   */
  getStatus(): {
    available: boolean;
    inProgress: boolean;
    version: string;
    sessionCount: number;
    nextCleanupIn: number;
  } {
    return {
      available: this.isAvailable(),
      inProgress: this.lintInProgress,
      version: 'aily-builder-lint-optimized',
      sessionCount: this.lintSessionCount,
      nextCleanupIn: this.CLEANUP_INTERVAL - (this.lintSessionCount % this.CLEANUP_INTERVAL)
    };
  }

  /**
   * 准备项目库文件 - 优化版本，参考 BuilderService
   * 使用并行处理和符号链接提升性能
   */
  private async prepareProjectLibraries(librariesPath: string): Promise<void> {
    try {
      const packageJson = await this.projectService.getPackageJson();
      const dependencies = packageJson.dependencies || {};

      const libsList: string[] = [];
      Object.entries(dependencies).forEach(([key, version]) => {
        if (key.startsWith('@aily-project/lib-') && !key.startsWith('@aily-project/lib-core')) {
          libsList.push(key);
        }
      });

      if (libsList.length === 0) {
        return;
      }

      // 并行处理所有库
      const libraryTasks = libsList.map(lib => this.processLibraryForLint(lib, librariesPath));
      const results = await Promise.all(libraryTasks);

      // 检查失败的库
      const failedLibs = results
        .map((r, i) => ({ result: r, lib: libsList[i] }))
        .filter(item => !item.result.success)
        .map(item => item.lib);
        
      if (failedLibs.length > 0) {
        console.warn(`处理失败的库: ${failedLibs.join(', ')}`);
      }

    } catch (error: any) {
      console.warn('准备项目库文件失败:', error);
      throw new Error(`库准备失败: ${error.message}`);
    }
  }

  /**
   * 为lint处理单个库 - 优化版本，参考 BuilderService.processLibrary
   * 使用符号链接代替复制，提升性能
   * @param lib 库名称
   * @param librariesPath 目标libraries路径
   * @returns 处理结果
   */
  private async processLibraryForLint(lib: string, librariesPath: string): Promise<{
    success: boolean;
    error?: string;
    targetNames?: string[];
  }> {
    try {
      const sourcePath = `${this.currentProjectPath}/node_modules/${lib}/src`;
      
      // 检查缓存
      const cachedInfo = this.libraryCache.get(lib);
      if (cachedInfo && this.isLibraryCacheValid(lib, sourcePath)) {
        return {
          success: true,
          targetNames: cachedInfo.targetNames
        };
      }
      
      // 准备源码路径（包含解压和嵌套目录处理）
      const preparedSourcePath = await this.prepareLibrarySource(lib);
      if (!preparedSourcePath) {
        return { success: true, targetNames: [] };
      }

      // 检查是否包含头文件并链接
      const hasHeaderFiles = await this.checkForHeaderFiles(preparedSourcePath);
      
      if (hasHeaderFiles) {
        return await this.linkLibraryWithHeaders(lib, preparedSourcePath, librariesPath);
      } else {
        return await this.linkLibraryDirectories(lib, preparedSourcePath, librariesPath);
      }

    } catch (error: any) {
      console.warn(`处理库 ${lib} 失败:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 准备库源码路径 - 参考 BuilderService.prepareLibrarySource
   * 处理解压和嵌套src目录
   * @param lib 库名称
   * @returns 准备好的源码路径，失败返回null
   */
  private async prepareLibrarySource(lib: string): Promise<string | null> {
    let sourcePath = `${this.currentProjectPath}/node_modules/${lib}/src`;
    
    if (!window['path'].isExists(sourcePath)) {
      const sourceZipPath = `${this.currentProjectPath}/node_modules/${lib}/src.7z`;
      
      if (!window['path'].isExists(sourceZipPath)) {
        return null;
      }
      
      try {
        await this.cmdService.runAsync(`${this.platformService.za7} x "${sourceZipPath}" -o"${sourcePath}" -y`);
      } catch (error) {
        console.error(`解压库 ${lib} 失败:`, error);
        return null;
      }
    }

    sourcePath = this.resolveNestedSrcPath(sourcePath);
    return sourcePath;
  }

  /**
   * 解析嵌套的src目录结构
   */
  private resolveNestedSrcPath(sourcePath: string): string {
    if (!window['fs'].existsSync(sourcePath)) {
      return sourcePath;
    }
    
    try {
      const srcContents = window['fs'].readDirSync(sourcePath);
      
      if (srcContents.length === 1) {
        const firstItem = srcContents[0];
        const itemName = typeof firstItem === 'object' && firstItem !== null ? firstItem.name : firstItem;

        if (itemName === 'src' && window['fs'].isDirectory(`${sourcePath}/${itemName}`)) {
          return `${sourcePath}/src`;
        }
      }
    } catch (error) {
      console.warn(`解析嵌套src路径失败:`, error);
    }
    
    return sourcePath;
  }

  /**
   * 检查目录下是否包含头文件
   */
  private async checkForHeaderFiles(sourcePath: string): Promise<boolean> {
    if (!window['fs'].existsSync(sourcePath)) {
      return false;
    }
    
    try {
      const files = window['fs'].readDirSync(sourcePath);
      
      for (const file of files) {
        const fileName = typeof file === 'object' && file !== null ? file.name : file;
        
        if (fileName.endsWith('.h') || fileName.endsWith('.hpp')) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.warn('检查头文件失败:', error);
      return false;
    }
  }

  /**
   * 链接包含头文件的库 - 参考 BuilderService.processLibraryWithHeaders
   * 使用符号链接代替复制，大幅提升性能
   */
  private async linkLibraryWithHeaders(lib: string, sourcePath: string, librariesPath: string): Promise<{
    success: boolean;
    error?: string;
    targetNames?: string[];
  }> {
    try {
      const targetName = lib.split('@aily-project/')[1];
      const targetPath = `${librariesPath}/${targetName}`;

      if (!window['path'].isExists(targetPath)) {
        await this.crossPlatformCmdService.linkItem(sourcePath, targetPath);
      }

      // 更新缓存
      this.libraryCache.set(lib, {
        timestamp: Date.now(),
        targetNames: [targetName]
      });

      return {
        success: true,
        targetNames: [targetName]
      };
    } catch (error: any) {
      console.warn(`链接库 ${lib} 失败:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 链接不包含头文件的库（逐个目录）- 参考 BuilderService.processLibraryDirectories
   * 使用符号链接代替复制
   */
  private async linkLibraryDirectories(lib: string, sourcePath: string, librariesPath: string): Promise<{
    success: boolean;
    error?: string;
    targetNames?: string[];
  }> {
    try {
      const targetNames: string[] = [];

      if (!window['fs'].existsSync(sourcePath)) {
        return { success: true, targetNames: [] };
      }

      const items = window['fs'].readDirSync(sourcePath);

      for (const item of items) {
        const itemName = typeof item === 'object' && item !== null ? item.name : item;
        const fullSourcePath = `${sourcePath}/${itemName}`;

        if (window['fs'].isDirectory(fullSourcePath)) {
          const targetPath = `${librariesPath}/${itemName}`;

          if (!window['path'].isExists(targetPath)) {
            await this.crossPlatformCmdService.linkItem(fullSourcePath, targetPath);
          }
          
          targetNames.push(itemName);
        }
      }

      // 更新缓存
      this.libraryCache.set(lib, {
        timestamp: Date.now(),
        targetNames: targetNames
      });

      return {
        success: true,
        targetNames
      };
    } catch (error: any) {
      console.warn(`链接库目录 ${lib} 失败:`, error);
      return { success: false, error: error.message };
    }
  }
}