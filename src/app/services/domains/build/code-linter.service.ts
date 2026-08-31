// import { Injectable } from '@angular/core';
// import { Observable, from, BehaviorSubject } from 'rxjs';
// import { map, catchError } from 'rxjs/operators';

// export interface LintError {
//   line: number;
//   column: number;
//   message: string;
//   severity: 'error' | 'warning' | 'info';
//   code?: string;
//   source: string;
// }

// export interface LintResult {
//   isValid: boolean;
//   errors: LintError[];
//   warnings: LintError[];
//   duration: number;
//   language: string;
//   toolUsed: string;
// }

// export interface LintOptions {
//   language: 'cpp' | 'arduino' | 'javascript' | 'typescript' | 'python';
//   includes?: string[];
//   defines?: string[];
//   std?: string;
//   enableWarnings?: boolean;
//   strictMode?: boolean;
//   timeout?: number;
// // Arduino/嵌入式特定配置
//   board?: string;                    // 开发板类型 (esp32, esp8266, arduino_uno等)
//   coreLibraryPath?: string;          // 自定义核心库路径
//   thirdPartyLibraries?: string[];    // 第三方库路径列表
//   platformDefines?: string[];        // 平台特定宏定义
//   autoDetectPaths?: boolean;         // 是否自动检测Arduino路径 (默认true)
//   projectPath?: string;              // 项目路径 (用于aily-project自动检测)
// }

// @Injectable({
//   providedIn: 'root'
// })
// export class CodeLinterService {
//   private isElectronApp = false;
//   private lintingSubject = new BehaviorSubject<boolean>(false);
//   public isLinting$ = this.lintingSubject.asObservable();

//   constructor() {
//     // 检测是否在Electron环境中
//     this.isElectronApp = !!(window as any).electronAPI;
    
//     if (!this.isElectronApp) {
//       console.warn('代码检查器需要在Electron环境中运行以获得完整功能');
//     }
//   }

//   private get electronApi() {
//     return this.isElectronApp ? (window as any).electronAPI : null;
//   }

//   /**
//    * 检查代码
//    * @param code 代码字符串
//    * @param options 检查选项
//    * @returns 检查结果的Observable
//    */
//   async lintCode(code: string, options: LintOptions): Promise<LintResult> {
//     if (!code.trim()) {
//       return this.createEmptyResult(options.language);
//     }

//     this.lintingSubject.next(true);
//     const startTime = Date.now();

//     try {
//       let result: LintResult;

//       switch (options.language) {
//         case 'cpp':
//         case 'arduino':
//           result = await this.lintCppCode(code, options);
//           break;
//         case 'javascript':
//           result = await this.lintJavaScriptCode(code, options);
//           break;
//         case 'typescript':
//           result = await this.lintTypeScriptCode(code, options);
//           break;
//         case 'python':
//           result = await this.lintPythonCode(code, options);
//           break;
//         default:
//           throw new Error(`不支持的语言类型: ${options.language}`);
//       }

//       const duration = Date.now() - startTime;
//       result.duration = duration;

//       return result;

//     } catch (error) {
//       console.error('代码检查失败:', error);
//       return this.createErrorResult(
//         options.language,
//         `代码检查失败: ${error instanceof Error ? error.message : String(error)}`,
//         Date.now() - startTime
//       );
//     } finally {
//       this.lintingSubject.next(false);
//     }
//   }

//   /**
//    * C++/Arduino 代码检查
//    */
//   private async lintCppCode(code: string, options: LintOptions): Promise<LintResult> {
//     if (!this.isElectronApp) {
//       return this.createWebFallbackResult('cpp', 'C++ linting requires Electron environment');
//     }

//     try {
//       // 调用 Electron 后端进行代码检查
//       const result = await (window as any).electronAPI.lintCode(code, options);
//       return result;
//     } catch (error) {
//       console.error('C++/Arduino 代码检查失败:', error);
//       return this.createErrorResult(
//         options.language,
//         `代码检查失败: ${error instanceof Error ? error.message : String(error)}`,
//         0
//       );
//     }
//   }

//   /**
//    * JavaScript 代码检查
//    */
//   private async lintJavaScriptCode(code: string, options: LintOptions): Promise<LintResult> {
//     if (!this.isElectronApp) {
//       return this.createWebFallbackResult('javascript', 'JavaScript linting requires Electron environment');
//     }

//     const tempFile = await this.createTempFile(code, '.js');
    
//     try {
//       // 使用 Node.js 进行语法检查
//       const args = ['--check', tempFile];
//       const result = await this.executeCommand('node', args, options.timeout || 3000);
      
//       return this.parseJavaScriptOutput(result, 'javascript');
//     } finally {
//       await this.deleteTempFile(tempFile);
//     }
//   }

//   /**
//    * TypeScript 代码检查
//    */
//   private async lintTypeScriptCode(code: string, options: LintOptions): Promise<LintResult> {
//     if (!this.isElectronApp) {
//       return this.createWebFallbackResult('typescript', 'TypeScript linting requires Electron environment');
//     }

//     const tempFile = await this.createTempFile(code, '.ts');
    
//     try {
//       // 使用 TypeScript 编译器进行检查
//       const args = ['--noEmit', '--strict', tempFile];
//       const result = await this.executeCommand('tsc', args, options.timeout || 5000);
      
//       return this.parseTypeScriptOutput(result, 'typescript');
//     } finally {
//       await this.deleteTempFile(tempFile);
//     }
//   }

//   /**
//    * Python 代码检查
//    */
//   private async lintPythonCode(code: string, options: LintOptions): Promise<LintResult> {
//     if (!this.isElectronApp) {
//       return this.createWebFallbackResult('python', 'Python linting requires Electron environment');
//     }

//     const tempFile = await this.createTempFile(code, '.py');
    
//     try {
//       // 使用 Python 进行语法检查
//       const args = ['-m', 'py_compile', tempFile];
//       const result = await this.executeCommand('python', args, options.timeout || 3000);
      
//       return this.parsePythonOutput(result, 'python');
//     } finally {
//       await this.deleteTempFile(tempFile);
//     }
//   }

//   /**
//    * 构建 C++ 编译器参数
//    */
//   private async buildCppLintArgs(tempFile: string, options: LintOptions): Promise<string[]> {
//     const args = ['-fsyntax-only']; // 关键：只检查语法，不编译

//     // 添加警告标志
//     if (options.enableWarnings !== false) {
//       args.push('-Wall', '-Wextra');
//       if (options.strictMode) {
//         args.push('-Wpedantic', '-Werror');
//       }
//     }

//     // C++ 标准
//     args.push(`-std=${options.std || 'c++17'}`);

//     // Arduino 特定配置
//     if (options.language === 'arduino') {
//       const board = options.board || 'esp32';
      
//       // 获取开发板特定的宏定义
//       try {
//         const boardDefines = await this.getBoardDefines(board);
//         boardDefines.forEach(define => {
//           args.push(`-D${define}`);
//         });
//       } catch (error) {
//         console.warn('Failed to get board defines:', error);
//         // 回退到默认ESP32定义
//         args.push(
//           '-DARDUINO=10819',
//           '-DESP32',
//           '-DARDUINO_ARCH_ESP32'
//         );
//       }

//       // 获取包含路径
//       if (options.autoDetectPaths !== false) {
//         try {
//           let includePaths: string[] = [];
          
//           if (options.coreLibraryPath || options.thirdPartyLibraries?.length) {
//             // 使用自定义路径
//             const includeOptions = {
//               board,
//               customCorePath: options.coreLibraryPath,
//               thirdPartyLibs: options.thirdPartyLibraries || [],
//               projectPath: options.projectPath
//             };
//             includePaths = await this.getBoardIncludes(includeOptions);
//           } else {
//             // 检查是否为aily-project项目
//             if (options.projectPath) {
//               const includeOptions = {
//                 board,
//                 customCorePath: undefined,
//                 thirdPartyLibs: [],
//                 projectPath: options.projectPath
//               };
//               includePaths = await this.getBoardIncludes(includeOptions);
//             } else {
//               // 使用默认Arduino安装路径
//               includePaths = await this.getArduinoIncludes(board);
//             }
//           }
          
//           includePaths.forEach(include => {
//             args.push(`-I${include}`);
//           });
//         } catch (error) {
//           console.warn('Failed to get Arduino includes:', error);
//           // 回退到默认包含路径
//           const defaultIncludes = [
//             '/arduino/cores/esp32',
//             '/arduino/libraries',
//             '/arduino/tools/esp32/include'
//           ];
          
//           defaultIncludes.forEach(include => {
//             args.push(`-I${include}`);
//           });
//         }
//       }
      
//       // 添加平台特定的宏定义
//       if (options.platformDefines) {
//         options.platformDefines.forEach(define => {
//           args.push(`-D${define}`);
//         });
//       }
//     }

//     // 用户自定义包含路径
//     if (options.includes) {
//       options.includes.forEach(include => {
//         args.push(`-I${include}`);
//       });
//     }

//     // 用户自定义宏定义
//     if (options.defines) {
//       options.defines.forEach(define => {
//         args.push(`-D${define}`);
//       });
//     }

//     args.push(tempFile);
//     return args;
//   }

//   /**
//    * 解析 C++ 编译器输出
//    */
//   private parseCppOutput(result: { stdout: string; stderr: string; exitCode: number }, language: string): LintResult {
//     const errors: LintError[] = [];
//     const warnings: LintError[] = [];

//     if (result.exitCode === 0) {
//       return {
//         isValid: true,
//         errors,
//         warnings,
//         duration: 0,
//         language,
//         toolUsed: 'g++'
//       };
//     }

//     // 解析错误和警告
//     const lines = result.stderr.split('\n');
    
//     for (const line of lines) {
//       if (!line.trim()) continue;

//       // 匹配 GCC/Clang 错误格式
//       const match = line.match(/^([^:]+):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/);
      
//       if (match) {
//         const [, , lineNum, colNum, severity, message] = match;
        
//         const lintError: LintError = {
//           line: parseInt(lineNum),
//           column: parseInt(colNum),
//           message: message.trim(),
//           severity: severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info',
//           source: 'g++'
//         };

//         if (lintError.severity === 'error') {
//           errors.push(lintError);
//         } else if (lintError.severity === 'warning') {
//           warnings.push(lintError);
//         }
//       }
//     }

//     return {
//       isValid: errors.length === 0,
//       errors,
//       warnings,
//       duration: 0,
//       language,
//       toolUsed: 'g++'
//     };
//   }

//   /**
//    * 解析 JavaScript 输出
//    */
//   private parseJavaScriptOutput(result: { stdout: string; stderr: string; exitCode: number }, language: string): LintResult {
//     const errors: LintError[] = [];
    
//     if (result.exitCode === 0) {
//       return {
//         isValid: true,
//         errors,
//         warnings: [],
//         duration: 0,
//         language,
//         toolUsed: 'node'
//       };
//     }

//     // 解析 Node.js 语法错误
//     const errorMatch = result.stderr.match(/SyntaxError: (.+)/);
//     if (errorMatch) {
//       errors.push({
//         line: 1,
//         column: 1,
//         message: errorMatch[1],
//         severity: 'error',
//         source: 'node'
//       });
//     }

//     return {
//       isValid: false,
//       errors,
//       warnings: [],
//       duration: 0,
//       language,
//       toolUsed: 'node'
//     };
//   }

//   /**
//    * 解析 TypeScript 输出
//    */
//   private parseTypeScriptOutput(result: { stdout: string; stderr: string; exitCode: number }, language: string): LintResult {
//     const errors: LintError[] = [];
    
//     if (result.exitCode === 0) {
//       return {
//         isValid: true,
//         errors,
//         warnings: [],
//         duration: 0,
//         language,
//         toolUsed: 'tsc'
//       };
//     }

//     // 解析 TypeScript 错误
//     const lines = result.stdout.split('\n');
//     for (const line of lines) {
//       const match = line.match(/^([^(]+)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/);
      
//       if (match) {
//         const [, , lineNum, colNum, severity, message] = match;
        
//         errors.push({
//           line: parseInt(lineNum),
//           column: parseInt(colNum),
//           message: message.trim(),
//           severity: severity as 'error' | 'warning',
//           source: 'tsc'
//         });
//       }
//     }

//     return {
//       isValid: false,
//       errors,
//       warnings: [],
//       duration: 0,
//       language,
//       toolUsed: 'tsc'
//     };
//   }

//   /**
//    * 解析 Python 输出
//    */
//   private parsePythonOutput(result: { stdout: string; stderr: string; exitCode: number }, language: string): LintResult {
//     const errors: LintError[] = [];
    
//     if (result.exitCode === 0) {
//       return {
//         isValid: true,
//         errors,
//         warnings: [],
//         duration: 0,
//         language,
//         toolUsed: 'python'
//       };
//     }

//     // 解析 Python 语法错误
//     const errorMatch = result.stderr.match(/line (\d+)/);
//     const messageMatch = result.stderr.match(/SyntaxError: (.+)/);
    
//     if (errorMatch && messageMatch) {
//       errors.push({
//         line: parseInt(errorMatch[1]),
//         column: 1,
//         message: messageMatch[1],
//         severity: 'error',
//         source: 'python'
//       });
//     }

//     return {
//       isValid: false,
//       errors,
//       warnings: [],
//       duration: 0,
//       language,
//       toolUsed: 'python'
//     };
//   }

//   /**
//    * 创建临时文件
//    */
//   private async createTempFile(content: string, extension: string): Promise<string> {
//     if (!this.isElectronApp) {
//       throw new Error('Creating temp files requires Electron environment');
//     }

//     try {
//       return await this.electronApi.codeLinter.createTempFile(content, extension);
//     } catch (error) {
//       throw new Error(`Failed to create temp file: ${error}`);
//     }
//   }

//   /**
//    * 删除临时文件
//    */
//   private async deleteTempFile(filePath: string): Promise<void> {
//     if (!this.isElectronApp) {
//       return;
//     }

//     try {
//       await this.electronApi.codeLinter.deleteTempFile(filePath);
//     } catch (error) {
//       console.warn(`Failed to delete temp file ${filePath}:`, error);
//     }
//   }

//   /**
//    * 执行命令
//    */
//   private async executeCommand(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
//     if (!this.isElectronApp) {
//       throw new Error('Command execution requires Electron environment');
//     }

//     try {
//       return await this.electronApi.codeLinter.executeCommand(command, args, timeout);
//     } catch (error) {
//       throw new Error(`Failed to execute command ${command}: ${error}`);
//     }
//   }

//   /**
//    * 创建空结果
//    */
//   private createEmptyResult(language: string): LintResult {
//     return {
//       isValid: true,
//       errors: [],
//       warnings: [],
//       duration: 0,
//       language,
//       toolUsed: 'none'
//     };
//   }

//   /**
//    * 创建错误结果
//    */
//   private createErrorResult(language: string, message: string, duration: number): LintResult {
//     return {
//       isValid: false,
//       errors: [{
//         line: 1,
//         column: 1,
//         message,
//         severity: 'error' as const,
//         source: 'linter'
//       }],
//       warnings: [],
//       duration,
//       language,
//       toolUsed: 'error'
//     };
//   }

//   /**
//    * Web 环境回退结果
//    */
//   private createWebFallbackResult(language: string, message: string): LintResult {
//     return {
//       isValid: false,
//       errors: [{
//         line: 1,
//         column: 1,
//         message,
//         severity: 'info' as const,
//         source: 'web-fallback'
//       }],
//       warnings: [],
//       duration: 0,
//       language,
//       toolUsed: 'web-fallback'
//     };
//   }

//   /**
//    * 获取支持的语言列表
//    */
//   getSupportedLanguages(): string[] {
//     return ['cpp', 'arduino', 'javascript', 'typescript', 'python'];
//   }

//   /**
//    * 检查工具是否可用
//    */
//   async checkToolAvailability(tool: string): Promise<boolean> {
//     if (!this.isElectronApp) {
//       return false;
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.checkToolAvailability(tool);
//     } catch {
//       return false;
//     }
//   }

//   /**
//    * 获取Arduino包含路径
//    */
//   async getArduinoIncludes(board: string = 'esp32'): Promise<string[]> {
//     if (!this.isElectronApp) {
//       return [];
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.getArduinoIncludes(board);
//     } catch {
//       return [];
//     }
//   }

//   /**
//    * 获取开发板特定包含路径
//    */
//   async getBoardIncludes(options: { board: string, customCorePath?: string, thirdPartyLibs?: string[] }): Promise<string[]> {
//     if (!this.isElectronApp) {
//       return [];
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.getBoardIncludes(options);
//     } catch {
//       return [];
//     }
//   }

//   /**
//    * 获取开发板宏定义
//    */
//   async getBoardDefines(board: string): Promise<string[]> {
//     if (!this.isElectronApp) {
//       return [`BOARD_${board.toUpperCase()}`];
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.getBoardDefines(board);
//     } catch {
//       return [`BOARD_${board.toUpperCase()}`];
//     }
//   }

//   /**
//    * 获取支持的开发板列表
//    */
//   async getSupportedBoards(): Promise<{ id: string, name: string, platform: string }[]> {
//     if (!this.isElectronApp) {
//       return [
//         { id: 'esp32', name: 'ESP32 Dev Module', platform: 'ESP32' },
//         { id: 'esp8266', name: 'NodeMCU 1.0 (ESP-12E)', platform: 'ESP8266' }
//       ];
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.getSupportedBoards();
//     } catch {
//       return [];
//     }
//   }

//   /**
//    * 加载aily-project项目配置
//    */
//   async loadProjectConfig(projectPath: string): Promise<any> {
//     if (!this.isElectronApp) {
//       return { isAilyProject: false };
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.loadProjectConfig(projectPath);
//     } catch (error) {
//       console.error('Failed to load project config:', error);
//       return { isAilyProject: false };
//     }
//   }

//   /**
//    * 自动检测并加载项目配置到LintOptions
//    */
//   async autoLoadProjectConfig(projectPath: string): Promise<Partial<LintOptions>> {
//     try {
//       const projectConfig = await this.loadProjectConfig(projectPath);
      
//       if (!projectConfig.isAilyProject) {
//         console.log('非aily-project项目，使用默认配置');
//         return {};
//       }

//       console.log('检测到aily-project项目，自动加载配置');
      
//       // 从项目配置中解析开发板信息
//       const boardConfig = projectConfig.boardConfig?.[0];
//       if (!boardConfig) {
//         console.warn('项目配置中未找到开发板信息');
//         return { projectPath };
//       }

//       return {
//         language: 'arduino' as const,
//         board: boardConfig.boardType,
//         projectPath,
//         autoDetectPaths: true,
//         // 不设置coreLibraryPath和thirdPartyLibraries，让系统自动检测
//         platformDefines: [`${boardConfig.boardType.toUpperCase()}_VERSION="${boardConfig.version}"`]
//       };

//     } catch (error) {
//       console.error('自动加载项目配置失败:', error);
//       return {};
//     }
//   }

//   /**
//    * 获取系统信息
//    */
//   async getSystemInfo(): Promise<any> {
//     if (!this.isElectronApp) {
//       return null;
//     }

//     try {
//       return await (window as any).electronAPI.codeLinter.getSystemInfo();
//     } catch {
//       return null;
//     }
//   }
// }