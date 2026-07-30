import { Injectable } from '@angular/core';
import { AilyHost } from '../core/host';
import {
  syncArduinoProjectSourceToSketch,
  writeArduinoGeneratedArtifacts,
} from '../../../editors/blockly-editor/services/generated-code-artifacts';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import { normalizeArduinoGeneratedCode } from '../../../editors/blockly-editor/components/blockly/generators/arduino/arduino';
import { runWithPreparedActiveProjectGenerator } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';

// Arduino 代码检查器

function createLintCodeFingerprint(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Lint 检测模式
 */
export type LintMode = 'fast' | 'accurate' | 'auto';

/**
 * Lint 输出格式
 */
export type LintFormat = 'human' | 'diagnostic' | 'json';

type AilyBuilderLintFormat = 'human' | 'vscode' | 'json';

function toAilyBuilderLintFormat(format: LintFormat): AilyBuilderLintFormat {
  return format === 'diagnostic' ? 'vscode' : format;
}

function isArduinoLintTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceArduinoLint', [
    '__AILY_CHAT_TRACE_ARDUINO_LINT__',
    'AILY_CHAT_TRACE_ARDUINO_LINT',
  ]);
}

/**
 * Lint 检查选项
 */
export interface LintOptions {
  mode?: LintMode;           // 检测模式，默认 'fast'
  format?: LintFormat;       // 输出格式，默认 'json'
  timeout?: number;          // 超时时间，默认 10000ms，兼容字段；不强制中断可能较慢的 accurate 检查
  projectContext?: {
    projectPath?: string;
    packageJson?: any;
    boardJson?: any;
    boardPackageJson?: any;
  };
}

/**
 * Lint 检查结果（JSON格式）
 */
export interface LintResult {
  success: boolean;          // 是否检查成功
  errors: LintError[];       // 错误列表
  warnings: LintError[];     // 警告列表
  notes?: LintError[];       // 提示列表
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
  endLine?: number;          // 结束行号
  endColumn?: number;        // 结束列号
  message: string;           // 错误信息
  severity: 'error' | 'warning' | 'note'; // 严重程度
  code?: string;             // 诊断代码
  fix?: {
    range: [number, number];
    text: string;
  };
}

/**
 * Arduino Lint 服务
 * 基于独立的 aily-linter CLI，提供简化的代码语法检查
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
  private currentProjectContext: NonNullable<LintOptions['projectContext']> | null = null;

  // 库缓存机制 - 避免重复处理
  private libraryCache = new Map<string, {
    timestamp: number;
    targetNames: string[];
  }>();

  constructor() {
    // 将服务实例注册到全局对象，以便 ArduinoSyntaxTool 可以访问
    (window as any)['arduinoLintService'] = this;
    // console.log('🔧 ArduinoLintService 已注册到全局对象');
  }

  // 通过 AilyHost 访问外部服务的便捷 getter
  private get cmdService(): any { return AilyHost.get().cmd; }
  private get crossPlatformCmdService(): any { return AilyHost.get().crossPlatformCmd; }
  private get projectService(): any { return AilyHost.get().project; }
  private get blocklyService(): any { return AilyHost.get().blockly; }
  private get platformService(): any { return AilyHost.get().platform; }

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
      if (!AilyHost.get().fs.existsSync(sourcePath)) return false;
      const stat = AilyHost.get().fs.statSync(sourcePath);
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
      mode = 'fast',
      format = 'json'
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
      this.currentProjectContext = options.projectContext ?? null;
      this.currentProjectPath = this.resolveCurrentProjectPath(options.projectContext);

      if (isArduinoLintTraceEnabled()) {
        console.info('[ArduinoLintService] checkSyntax start', {
          projectPath: this.currentProjectPath,
          mode,
          format,
          length: code.length,
          fingerprint: createLintCodeFingerprint(code),
        });
      }

      // console.log(`🔍 开始 Arduino 语法检查 (模式: ${mode}, 格式: ${format})...`);

      // 验证输入
      if (!code || code.trim().length === 0) {
        throw new Error('代码内容为空');
      }

      // 准备临时环境
      const tempEnv = await this.prepareTempEnvironment(code);
      
      try {
        // 执行 lint 检查
        const result = await this.executeLint(tempEnv, mode, format);
        
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
      this.currentProjectContext = null;
    }
  }

  private resolveCurrentProjectPath(projectContext?: LintOptions['projectContext']): string {
    const scopedPath = typeof projectContext?.projectPath === 'string'
      ? projectContext.projectPath.trim()
      : '';
    if (scopedPath) {
      return scopedPath;
    }
    return typeof this.projectService?.currentProjectPath === 'string'
      ? this.projectService.currentProjectPath.trim()
      : '';
  }

  private async getProjectPackageJson(): Promise<any> {
    if (this.currentProjectContext?.packageJson && typeof this.currentProjectContext.packageJson === 'object') {
      return this.currentProjectContext.packageJson;
    }
    return await this.projectService.getPackageJson();
  }

  private async getProjectBoardJson(): Promise<any> {
    if (this.currentProjectContext?.boardJson && typeof this.currentProjectContext.boardJson === 'object') {
      return this.currentProjectContext.boardJson;
    }
    return await this.projectService.getBoardJson();
  }

  private async getProjectBoardPackageJson(): Promise<any> {
    if (this.currentProjectContext?.boardPackageJson && typeof this.currentProjectContext.boardPackageJson === 'object') {
      return this.currentProjectContext.boardPackageJson;
    }
    return await this.projectService.getBoardPackageJson();
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
      const projectPath = this.currentProjectPath;
      const projectDocument = this.blocklyService.getProjectDocument();
      const generated = await runWithPreparedActiveProjectGenerator(
        this.blocklyService.workspace,
        (generator) => ({
          code: normalizeArduinoGeneratedCode(
            generator.workspaceToCode(this.blocklyService.workspace),
          ),
          generator,
        }),
        projectDocument,
      );
      const { code, generator } = generated;
      await writeArduinoGeneratedArtifacts(projectPath, generator);
      
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
          mode: options.mode || 'fast'
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
      if (!AilyHost.get().path.isExists(tempPath)) {
        await this.crossPlatformCmdService.createDirectory(tempPath, true);
        // console.log(`✅ 创建临时目录: ${tempPath}`);
      } else {
        // console.log(`♻️ 复用现有临时目录: ${tempPath}`);
      }
      
      if (!AilyHost.get().path.isExists(sketchPath)) {
        await this.crossPlatformCmdService.createDirectory(sketchPath, true);
        // console.log(`✅ 创建 sketch 目录: ${sketchPath}`);
      }
      
      if (!AilyHost.get().path.isExists(librariesPath)) {
        await this.crossPlatformCmdService.createDirectory(librariesPath, true);
        // console.log(`✅ 创建 libraries 目录: ${librariesPath}`);
      }

      // 准备项目库文件（新增：关键的库准备步骤）
      await this.prepareProjectLibraries(librariesPath);

      // 高效写入代码到 sketch.ino 文件（覆盖模式，无需预先删除）
      await AilyHost.get().fs.writeFileSync(sketchFilePath, code);
      syncArduinoProjectSourceToSketch(this.currentProjectPath, sketchPath);
      if (isArduinoLintTraceEnabled()) {
        console.info('[ArduinoLintService] lint sketch prepared', {
          sketchFilePath,
          length: code.length,
          fingerprint: createLintCodeFingerprint(code),
        });
      }
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
   * 执行 aily-linter 检查
   */
  private async executeLint(
    env: { tempPath: string; sketchPath: string; sketchFilePath: string; librariesPath: string; },
    mode: LintMode,
    format: LintFormat
  ): Promise<string> {
    try {
      const { command, args } = await this.buildLintInvocation(env, mode, format);

      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error);
          } else {
            resolve(stdout);
          }
        };

        this.cmdService.spawn(command, args, { cwd: env.tempPath }, true).subscribe({
          next: (output) => {
            if (output.type === 'stdout' && output.data) {
              stdout += output.data;
            } else if (output.type === 'stderr' && output.data) {
              stderr += output.data;
            } else if (output.type === 'error') {
              finish(new Error(output.error || 'aily-linter 启动失败'));
            } else if (output.type === 'close') {
              // aily-linter 发现代码问题时会返回退出码 1，但 stdout 中仍有完整 JSON。
              if (stdout.trim()) {
                finish();
              } else {
                finish(new Error(stderr.trim() || `aily-linter exited with ${output.code ?? 'unknown'}`));
              }
            }
          },
          error: (error) => {
            finish(new Error(`aily-linter 执行失败: ${error.message || error}`));
          },
          complete: () => {
            if (!settled) {
              finish(new Error(stderr.trim() || 'aily-linter 未返回检查结果'));
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
   * 构建 aily-linter CLI 调用。该 CLI 没有 lint 子命令。
   */
  private async buildLintInvocation(
    env: { sketchFilePath: string; librariesPath: string; },
    mode: LintMode,
    format: LintFormat
  ): Promise<{ command: string; args: string[] }> {
    // 获取项目配置
    const packageJson = await this.getProjectPackageJson();
    const boardJson = await this.getProjectBoardJson();

    if (!boardJson) {
      throw new Error('未找到板子信息(board.json)');
    }

    const compilerParam = boardJson.compilerParam;
    if (!compilerParam) {
      throw new Error('未找到编译命令(compilerParam)');
    }

    const {
      boardType,
      buildProperties,
      boardOptions: compilerBoardOptions
    } = this.parseCompilerParams(compilerParam);

    const boardOptions = [...compilerBoardOptions];
    const projectConfig = packageJson?.projectConfig || {};
    for (const [key, value] of Object.entries(projectConfig)) {
      if (value !== null && value !== undefined && value !== '' && typeof value !== 'object') {
        boardOptions.push(`${key}=${String(value)}`);
      }
    }

    const toolVersions: string[] = [];
    let sdk = '';
    let sdkPath = '';
    let toolsPath = '';

    if (mode !== 'fast') {
      const boardDependencies = (await this.getProjectBoardPackageJson())?.boardDependencies || {};
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
          toolVersions.push(toolName + '@' + version);
        }
      });

      if (!sdk) {
        throw new Error('未找到 SDK 信息');
      }

      sdkPath = await window['env'].get('AILY_SDK_PATH') + `/${sdk}`;
      toolsPath = await window['env'].get('AILY_TOOLS_PATH');
    }

    if (!window['linter']?.waitForReady) {
      throw new Error('aily-linter 就绪服务不可用');
    }
    const linterState = await window['linter'].waitForReady();
    if (!linterState?.entryPath) {
      throw new Error('未找到 aily-linter CLI 入口');
    }

    const args = [
      linterState.entryPath,
      env.sketchFilePath,
      '--board', boardType,
      '--libraries-path', env.librariesPath
    ];
    for (const buildProperty of buildProperties) {
      args.push('--build-property', buildProperty);
    }
    for (const boardOption of boardOptions) {
      args.push('--board-options', boardOption);
    }
    if (mode !== 'fast') {
      args.push(
        '--sdk-path', sdkPath,
        '--tools-path', toolsPath
      );
      if (toolVersions.length > 0) {
        args.push('--tool-versions', toolVersions.join(','));
      }
    }
    args.push('--mode', mode, '--format', format);

    return { command: 'node', args };
  }

  private parseCompilerParams(compilerParam: string): {
    boardType: string;
    buildProperties: string[];
    boardOptions: string[];
  } {
    const tokens = this.splitCommandLine(compilerParam);
    if (tokens.shift() !== 'compile') {
      throw new Error('compilerParam 必须以 compile 开头');
    }

    let boardType = '';
    const buildProperties: string[] = [];
    const boardOptions: string[] = [];

    const readValue = (option: string, index: number): string => {
      const value = tokens[index + 1];
      if (!value) throw new Error(`${option} 缺少参数值`);
      return value;
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '-v' || token === '--verbose') {
        continue;
      }
      if (token === '-b' || token === '--board') {
        boardType = readValue(token, i++);
        continue;
      }
      if (token === '--build-property') {
        buildProperties.push(readValue(token, i++));
        continue;
      }
      if (token === '--board-options') {
        boardOptions.push(readValue(token, i++));
        continue;
      }
      if (token.startsWith('--board=')) {
        boardType = token.slice('--board='.length);
        continue;
      }
      if (token.startsWith('--build-property=')) {
        buildProperties.push(token.slice('--build-property='.length));
        continue;
      }
      if (token.startsWith('--board-options=')) {
        boardOptions.push(token.slice('--board-options='.length));
        continue;
      }
      throw new Error(`aily-linter 不支持 compilerParam 参数: ${token}`);
    }

    if (!boardType) {
      throw new Error('未找到板子类型');
    }

    return { boardType, buildProperties, boardOptions };
  }

  private splitCommandLine(command: string): string[] {
    const result: string[] = [];
    let current = '';
    let quote = '';

    for (const char of command) {
      if (quote) {
        if (char === quote) {
          quote = '';
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        if (current) {
          result.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (quote) {
      throw new Error('compilerParam 包含未闭合的引号');
    }
    if (current) result.push(current);

    return result;
  }

  /**
   * 解析 lint 检查结果
   */
  private parseResult(output: string, startTime: number, mode: LintMode, format: LintFormat): LintResult {
    const executionTime = Date.now() - startTime;

    try {
      if (format === 'json') {
        // JSON 模式下 aily-linter 的结构化结果写入 stdout。
        const jsonText = output.trim();
        if (!jsonText) {
          throw new Error('JSON 检查结果为空');
        }

        const jsonResult = JSON.parse(jsonText);
        return {
          success: jsonResult.success || false,
          errors: jsonResult.errors || [],
          warnings: jsonResult.warnings || [],
          notes: jsonResult.notes || [],
          executionTime: jsonResult.executionTime || executionTime,
          mode: jsonResult.mode || mode
        };
      } else if (format === 'diagnostic') {
        // 诊断定位格式解析
        return this.parseDiagnosticFormat(output, executionTime, mode);
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
        notes: [],
        executionTime,
        mode
      };
    }
  }

  /**
   * 解析诊断定位格式输出
   */
  private parseDiagnosticFormat(output: string, executionTime: number, mode: LintMode): LintResult {
    const errors: LintError[] = [];
    const warnings: LintError[] = [];
    const notes: LintError[] = [];

    if (!output || output.trim().length === 0) {
      return {
        success: true,
        errors: [],
        warnings: [],
        notes: [],
        executionTime,
        mode
      };
    }

    const lines = output.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // VS Code 格式: file(line,column[,endLine,endColumn]): severity [code]: message
      const match = trimmedLine.match(/^(.+)\((\d+),(\d+)(?:,(\d+),(\d+))?\):\s+(error|warning|note)(?:\s+([^:]+))?:\s+(.+)$/);
      if (match) {
        const [, file, lineStr, colStr, endLineStr, endColumnStr, severity, code, message] = match;
        
        const lintError: LintError = {
          file: file.trim(),
          line: parseInt(lineStr),
          column: parseInt(colStr),
          endLine: endLineStr ? parseInt(endLineStr) : undefined,
          endColumn: endColumnStr ? parseInt(endColumnStr) : undefined,
          message: message.trim(),
          severity: severity as LintError['severity'],
          code: code?.trim() || undefined
        };

        if (lintError.severity === 'error') {
          errors.push(lintError);
        } else if (lintError.severity === 'warning') {
          warnings.push(lintError);
        } else {
          notes.push(lintError);
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      notes,
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
    const notes: LintError[] = [];

    if (!output || output.trim().length === 0) {
      return {
        success: true,
        errors: [],
        warnings: [],
        notes: [],
        executionTime,
        mode
      };
    }

    const sections: Record<string, { items: LintError[]; severity: LintError['severity'] }> = {
      'Errors:': { items: errors, severity: 'error' },
      'Warnings:': { items: warnings, severity: 'warning' },
      'Notes:': { items: notes, severity: 'note' }
    };
    const lines = output.split(/\r?\n/);
    let section: { items: LintError[]; severity: LintError['severity'] } | undefined;

    for (let i = 0; i < lines.length; i++) {
      const trimmedLine = lines[i].trim();
      if (sections[trimmedLine]) {
        section = sections[trimmedLine];
        continue;
      }
      if (!section) continue;

      const location = trimmedLine.match(/^(.+):(\d+):(\d+)$/);
      if (!location) continue;

      const message = lines[i + 1]?.trim() || '未提供诊断信息';
      const codeMatch = lines[i + 2]?.trim().match(/^\[([^\]]+)\]$/);
      section.items.push({
        file: location[1].trim(),
        line: parseInt(location[2]),
        column: parseInt(location[3]),
        message,
        severity: section.severity,
        code: codeMatch?.[1]
      });
      i += codeMatch ? 2 : 1;
    }

    const passed = output.includes('Syntax check passed!');
    const failed = output.includes('Syntax check failed!');
    if (failed && errors.length === 0) {
      errors.push({
        file: 'sketch.ino',
        line: 1,
        column: 1,
        message: 'Syntax check failed!',
        severity: 'error'
      });
    }

    if (!passed && !failed && errors.length === 0 && warnings.length === 0 && notes.length === 0) {
      errors.push({
        file: 'sketch.ino',
        line: 1,
        column: 1,
        message: '无法识别 aily-linter 输出',
        severity: 'error'
      });
    }

    return {
      success: passed && errors.length === 0,
      errors,
      warnings,
      notes,
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
        
        if (AilyHost.get().path.isExists(sketchFilePath)) {
          await AilyHost.get().fs.unlinkSync(sketchFilePath);
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
      
      if (AilyHost.get().path.isExists(sketchFilePath)) {
        await AilyHost.get().fs.unlinkSync(sketchFilePath);
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
      return !!AilyHost.get().path && !!window['linter']?.waitForReady;
    } catch (error) {
      console.warn('检查 aily-linter 可用性失败:', error);
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
      version: 'aily-linter',
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
      const packageJson = await this.getProjectPackageJson();
      const dependencies = packageJson?.dependencies || {};

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
    
    if (!AilyHost.get().path.isExists(sourcePath)) {
      const sourceZipPath = `${this.currentProjectPath}/node_modules/${lib}/src.7z`;
      
      if (!AilyHost.get().path.isExists(sourceZipPath)) {
        return null;
      }
      
      try {
        await this.cmdService.runAsync(`${this.platformService.za7} x "${sourceZipPath}" -o"${sourcePath}" -y`, undefined, true, true);
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
    if (!AilyHost.get().fs.existsSync(sourcePath)) {
      return sourcePath;
    }
    
    try {
      const srcContents = AilyHost.get().fs.readDirSync(sourcePath);
      
      if (srcContents.length === 1) {
        const firstItem = srcContents[0];
        const itemName = typeof firstItem === 'object' && firstItem !== null ? firstItem.name : firstItem;

        if (itemName === 'src' && AilyHost.get().fs.isDirectory(`${sourcePath}/${itemName}`)) {
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
    if (!AilyHost.get().fs.existsSync(sourcePath)) {
      return false;
    }
    
    try {
      const files = AilyHost.get().fs.readDirSync(sourcePath);
      
      for (const file of files) {
        const fileName: string = typeof file === 'object' && file !== null ? file.name : file as any;
        
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

      if (!AilyHost.get().path.isExists(targetPath)) {
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

      if (!AilyHost.get().fs.existsSync(sourcePath)) {
        return { success: true, targetNames: [] };
      }

      const items = AilyHost.get().fs.readDirSync(sourcePath);

      for (const item of items) {
        const itemName: string = typeof item === 'object' && item !== null ? item.name : item as any;
        const fullSourcePath = `${sourcePath}/${itemName}`;

        if (AilyHost.get().fs.isDirectory(fullSourcePath)) {
          const targetPath = `${librariesPath}/${itemName}`;

          if (!AilyHost.get().path.isExists(targetPath)) {
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
