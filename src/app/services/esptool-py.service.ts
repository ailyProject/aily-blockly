import { Injectable } from '@angular/core';
import { CmdService, CmdOutput } from './cmd.service';
import { firstValueFrom } from 'rxjs';
import { ESP32ProgressParser, isRealError, isSerialError, processOutputBuffer } from '../utils/esp-flash.utils';

/**
 * Python esptool 包信息
 */
export interface EsptoolPackageInfo {
  name: string;           // 包名称（如 @aily-project/tool-esptool_py）
  version: string;        // 版本号
  installed: boolean;     // 是否已安装
  esptoolPath?: string;   // esptool.py 或 esptool.exe 路径
  pythonPath?: string;    // Python 可执行文件路径
}

/**
 * 烧录文件项
 */
export interface FlashFileItem {
  data: string;     // 文件数据（二进制字符串）
  address: number;  // 烧录地址（十六进制，如 0x0, 0x400000）
}

/**
 * 烧录选项
 */
export interface FlashWithScriptOptions {
  port: string;                                          // 串口路径
  baudRate?: number;                                     // 波特率，默认 460800
  flashFiles: FlashFileItem[];                          // 烧录文件列表
  chip?: string;                                         // 芯片类型，默认 esp32s3
  beforeFlash?: 'default_reset' | 'no_reset';          // 烧录前操作
  afterFlash?: 'hard_reset' | 'no_reset';              // 烧录后操作
  progressCallback?: (progress: number, status: string) => void;  // 进度回调
}

/**
 * Python esptool 服务
 * 用于检测、安装和使用 Python esptool 进行 ESP32 烧录
 */
@Injectable({
  providedIn: 'root'
})
export class EsptoolPyService {
  private esptoolPackage: EsptoolPackageInfo | null = null;
  private tempDir: string = '';

  constructor(
    private cmdService: CmdService
  ) {
    this.initTempDir();
  }

  /**
   * 初始化临时目录
   */
  private initTempDir(): void {
    // 使用用户级别的缓存目录: AppData/Local/aily-builder/model
    const appDataPath = window['electron'] && window['electron'].app 
      ? window['electron'].app.getPath('userData').replace('aily-project', 'aily-builder')
      : window['path'].getAppDataPath().replace('aily-project', 'aily-builder');
    
    this.tempDir = window['path'].join(appDataPath, 'model');
    
    // console.log('[EsptoolPy] 模型缓存目录:', this.tempDir);
    
    if (!window['fs'].existsSync(this.tempDir)) {
      window['fs'].mkdirSync(this.tempDir, { recursive: true });
      // console.log('[EsptoolPy] 创建模型缓存目录');
    }
  }

  /**
   * 检测已安装的 esptool 包
   * 优先检查开发板依赖中是否包含 esptool
   * @param clearCache 是否清除文件系统缓存
   * @returns Promise<EsptoolPackageInfo | null>
   */
  async detectEsptool(clearCache: boolean = false): Promise<EsptoolPackageInfo | null> {
    try {
      const appDataPath = window['path'].getAppDataPath();
      const nodeModulesPath = window['path'].join(appDataPath, 'node_modules');
      const toolsPath = window['path'].join(appDataPath, 'tools');

      // console.log('[EsptoolPy] 检查包路径:', nodeModulesPath);
      // console.log('[EsptoolPy] 检查工具路径:', toolsPath);
      
      // 清除文件系统缓存（重要！）
      if (clearCache) {
        // console.log('[EsptoolPy] 清除文件系统缓存...');
        try {
          // 清除 stat 缓存
          if (window['fs'].clearCache) {
            window['fs'].clearCache();
          }
        } catch (e) {
          console.warn('[EsptoolPy] 清除缓存失败:', e);
        }
      }

      // 检查目录是否存在（使用同步方法前先异步检查一次，强制刷新）
      if (clearCache) {
        try {
          await window['fs'].exists(nodeModulesPath);
          await window['fs'].exists(toolsPath);
        } catch (e) {
          // 忽略错误
        }
      }

      if (!window['fs'].existsSync(nodeModulesPath)) {
        // console.log('[EsptoolPy] node_modules 目录不存在');
        return null;
      }

      // 1. 检查 @aily-project scope 目录中的包信息
      const ailyProjectPath = window['path'].join(nodeModulesPath, '@aily-project');
      if (!window['fs'].existsSync(ailyProjectPath)) {
        // console.log('[EsptoolPy] @aily-project 目录不存在');
        return null;
      }

      // 2. 扫描 @aily-project 下的所有工具包
      const scopedDirs = window['fs'].readDirSync(ailyProjectPath);
      // console.log('[EsptoolPy] @aily-project 下的目录:', scopedDirs.map((d: any) => d.name || d));
      
      for (const dir of scopedDirs) {
        const dirName = dir.name || dir;  // 兼容不同的返回格式
        
        // 查找 tool-esptool_py
        if (dirName === 'tool-esptool_py') {
          const packagePath = window['path'].join(ailyProjectPath, dirName);
          
          // console.log('[EsptoolPy] 找到 esptool_py 包:', packagePath);
          
          // 检查是否为目录
          if (!window['path'].isDir(packagePath)) {
            console.warn('[EsptoolPy] 不是目录，跳过');
            continue;
          }

          // 读取 package.json 获取版本信息
          const packageJsonPath = window['path'].join(packagePath, 'package.json');
          if (window['fs'].existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
            
            // console.log('[EsptoolPy] 包信息:', packageJson.name, packageJson.version);
            
            // 3. 在 tools 目录下查找实际的可执行文件
            // 路径格式: tools/esptool_py@版本号
            const toolDirName = `esptool_py@${packageJson.version}`;
            const actualToolPath = window['path'].join(toolsPath, toolDirName);
            
            // console.log('[EsptoolPy] 查找工具目录:', actualToolPath);
            
            if (window['fs'].existsSync(actualToolPath)) {
              // console.log('[EsptoolPy] 工具目录存在，查找可执行文件...');
              // 在实际工具目录中查找可执行文件
              const esptoolPath = await this.findEsptoolExecutable(actualToolPath);
              
              if (esptoolPath) {
                this.esptoolPackage = {
                  name: packageJson.name,
                  version: packageJson.version,
                  installed: true,
                  esptoolPath: esptoolPath
                };
                
                // console.log('[EsptoolPy] ✓ 检测到已安装的 esptool 包:', this.esptoolPackage);
                return this.esptoolPackage;
              } else {
                console.warn('[EsptoolPy] 找到工具目录但未找到可执行文件');
              }
            } else {
              console.warn('[EsptoolPy] 工具目录不存在:', actualToolPath);
            }
          } else {
            console.warn('[EsptoolPy] package.json 不存在');
          }
        }
      }

      // console.log('[EsptoolPy] 未检测到 esptool_py 包');
      return null;
    } catch (error) {
      console.error('[EsptoolPy] 检测 esptool 失败:', error);
      return null;
    }
  }

  /**
   * 查找 esptool 可执行文件
   * @param packagePath 包路径
   * @returns Promise<string | null>
   */
  private async findEsptoolExecutable(packagePath: string): Promise<string | null> {
    try {
      // console.log('[EsptoolPy] 查找可执行文件，包路径:', packagePath);
      // console.log('[EsptoolPy] 当前平台:', window['platform'].isWindows ? 'Windows' : 'macOS/Linux');
      
      // 列出包目录内容
      try {
        const files = window['fs'].readDirSync(packagePath);
        // console.log('[EsptoolPy] 包目录内容:', files.map((f: any) => f.name || f));
      } catch (e) {
        console.warn('[EsptoolPy] 无法列出目录内容:', e);
      }

      // Windows: 查找 esptool.exe
      if (window['platform'].isWindows) {
        // 直接在包根目录
        const exePath = window['path'].join(packagePath, 'esptool.exe');
        // console.log('[EsptoolPy] 检查 Windows 可执行文件:', exePath);
        if (window['fs'].existsSync(exePath)) {
          // console.log('[EsptoolPy] ✓ 找到 Windows 可执行文件');
          return exePath;
        }
        
        // 在 bin 子目录
        const binExePath = window['path'].join(packagePath, 'bin', 'esptool.exe');
        // console.log('[EsptoolPy] 检查 bin 目录:', binExePath);
        if (window['fs'].existsSync(binExePath)) {
          // console.log('[EsptoolPy] ✓ 找到 bin 目录中的可执行文件');
          return binExePath;
        }
      } else {
        // macOS/Linux: 查找 esptool (无后缀)
        const binPath = window['path'].join(packagePath, 'esptool');
        // console.log('[EsptoolPy] 检查 macOS/Linux 可执行文件:', binPath);
        if (window['fs'].existsSync(binPath)) {
          // console.log('[EsptoolPy] ✓ 找到 macOS/Linux 可执行文件');
          return binPath;
        }
        
        // 在 bin 子目录
        const binBinPath = window['path'].join(packagePath, 'bin', 'esptool');
        // console.log('[EsptoolPy] 检查 bin 目录:', binBinPath);
        if (window['fs'].existsSync(binBinPath)) {
          // console.log('[EsptoolPy] ✓ 找到 bin 目录中的可执行文件');
          return binBinPath;
        }
      }

      console.warn('[EsptoolPy] ✗ 未在包中找到 esptool 可执行文件');
      return null;
    } catch (error) {
      console.error('[EsptoolPy] 查找可执行文件失败:', error);
      return null;
    }
  }

  /**
   * 安装 esptool 包
   * @returns Promise<boolean>
   */
  async installEsptool(): Promise<boolean> {
    try {
      // console.log('[EsptoolPy] 开始安装 esptool...');
      
      // 使用 cmdService.runAsync 执行 npm 安装，等待命令完成
      const appDataPath = window['path'].getAppDataPath();
      const command = 'npm install @aily-project/tool-esptool_py@latest';
      
      // console.log('[EsptoolPy] 执行命令:', command);
      // console.log('[EsptoolPy] 工作目录:', appDataPath);
      
      // 使用 runAsync 等待安装完成
      const result = await this.cmdService.runAsync(command, appDataPath, true);
      
      // console.log('[EsptoolPy] 安装命令执行完成');
      // console.log('[EsptoolPy] 退出码:', result.code);
      
      // 检查是否成功（退出码为 0）
      if (result.code === 0) {
        // console.log('[EsptoolPy] esptool 安装成功');
        
        // 等待一下文件系统同步
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // 重新检测（清除缓存）
        // console.log('[EsptoolPy] 开始检测 esptool...');
        const detected = await this.detectEsptool(true);
        
        if (detected) {
          // console.log('[EsptoolPy] 检测成功');
          return true;
        } else {
          console.warn('[EsptoolPy] 安装成功但检测失败，再等待 2 秒重试...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          const detected2 = await this.detectEsptool(true);
          
          if (detected2) {
            // console.log('[EsptoolPy] 第二次检测成功');
            return true;
          } else {
            console.error('[EsptoolPy] 两次检测均失败');
            return false;
          }
        }
      } else {
        console.error('[EsptoolPy] esptool 安装失败，退出码:', result.code);
        if (result.data) {
          console.error('[EsptoolPy] 错误信息:', result.data);
        }
        return false;
      }
    } catch (error) {
      console.error('[EsptoolPy] 安装 esptool 异常:', error);
      return false;
    }
  }

  /**
   * 获取当前 esptool 包信息
   */
  getEsptoolPackage(): EsptoolPackageInfo | null {
    return this.esptoolPackage;
  }

  /**
   * 使用 Python esptool 烧录单个文件
   * @param file 烧录文件
   * @param port 串口路径
   * @param options 烧录选项
   * @returns { promise: Promise<{ success: boolean }>, streamIdPromise: Promise<string> }
   */
  flashSingleFile(
    file: FlashFileItem,
    port: string,
    options?: {
      chip?: string;
      baudRate?: number;
      beforeFlash?: 'default_reset' | 'no_reset';
      afterFlash?: 'hard_reset' | 'no_reset';
      progressCallback?: (progress: number, status: string) => void;
    }
  ): { promise: Promise<{ success: boolean }>, streamIdPromise: Promise<string> } {
    let streamIdResolver: (value: string) => void;
    const streamIdPromise = new Promise<string>((resolve) => {
      streamIdResolver = resolve;
    });
    
    const promise = new Promise<{ success: boolean }>(async (resolve, reject) => {
      let tempFilePath = '';
      let uploadCompleted = false;
      let hasError = false;
      let bufferData = '';
      
      // 创建进度解析器
      const progressParser = new ESP32ProgressParser();
      
      try {
        if (!this.esptoolPackage || !this.esptoolPackage.esptoolPath) {
          reject(new Error('esptool 未安装或未检测到'));
          return;
        }

        // 1. 将烧录文件写入磁盘
        const fileName = `flash_0x${file.address.toString(16)}.bin`;
        tempFilePath = window['path'].join(this.tempDir, fileName);
        
        // 将二进制字符串转换为 Uint8Array
        const length = file.data.length;
        const uint8Array = new Uint8Array(length);
        for (let j = 0; j < length; j++) {
          uint8Array[j] = file.data.charCodeAt(j) & 0xff;
        }
        
        // 写入文件
        window['fs'].writeFileSync(tempFilePath, uint8Array);
        
        // console.log(`[EsptoolPy] 写入文件:`, tempFilePath, `(${length} bytes)`);

        // 2. 构建 esptool 命令
        const chip = options?.chip || 'esp32s3';
        const baudRate = options?.baudRate || 460800;
        const beforeFlash = options?.beforeFlash || 'default_reset';
        const afterFlash = options?.afterFlash || 'hard_reset';
        
        const address = `0x${file.address.toString(16)}`;
        
        // 使用 & 符号调用命令（PowerShell 支持）
        const command = `& "${this.esptoolPackage.esptoolPath}" --chip ${chip} --port ${port} --baud ${baudRate} --before ${beforeFlash} --after ${afterFlash} write_flash -z --flash_mode dio --flash_freq 80m --flash_size detect ${address} "${tempFilePath}"`;

        // console.log('[EsptoolPy] 执行烧录命令:', command);

        // 3. 执行命令
        this.cmdService.run(command, undefined, false).subscribe({
          next: (output: CmdOutput) => {
            const sid = output.streamId;
            
            // 第一次获取到 streamId 时立即 resolve Promise
            if (sid && streamIdResolver) {
              streamIdResolver(sid);
              streamIdResolver = null as any;  // 防止重复 resolve
            }

            if (output.data) {
              const data = output.data;
              
              // 处理换行符，确保按行处理
              const { lines, remainingBuffer } = processOutputBuffer(bufferData, data);
              bufferData = remainingBuffer;
              
              lines.forEach((line: string) => {
                const trimmedLine = line.trim();
                if (!trimmedLine) return;
                
                // 使用工具类解析进度
                const progressResult = progressParser.parseLine(trimmedLine);
                if (progressResult) {
                  if (progressResult.completed) {
                    uploadCompleted = true;
                    // console.log('[EsptoolPy] 烧录成功，数据校验通过');
                  }
                  
                  if (options?.progressCallback && !progressResult.completed) {
                    options.progressCallback(progressResult.progress, progressResult.message);
                  }
                }
                
                // 使用工具类检查错误
                if (isRealError(trimmedLine)) {
                  console.error('[EsptoolPy] 烧录错误:', trimmedLine);
                  hasError = true;
                }
                
                // 检查串口连接错误
                if (isSerialError(trimmedLine)) {
                  console.error('[EsptoolPy] 串口连接错误:', trimmedLine);
                  hasError = true;
                }
              });
            }
          },
          error: (error) => {
            console.error('[EsptoolPy] 烧录命令执行失败:', error);
            this.cleanupSingleFile(tempFilePath);
            reject(error);
          },
          complete: () => {
            // console.log('[EsptoolPy] 烧录命令执行完成');
            this.cleanupSingleFile(tempFilePath);
            
            // 如果有真正的错误（不是 PowerShell 的 CommandNotFoundException）
            if (hasError) {
              reject(new Error('烧录过程中检测到错误'));
            } else if (uploadCompleted) {
              // 检测到完成标志
              // console.log('[EsptoolPy] 烧录成功完成');
              resolve({ success: true });
            } else {
              // 没有明确的完成标志，但也没有错误，视为成功
              // console.log('[EsptoolPy] 烧录命令结束，未检测到错误，视为成功');
              resolve({ success: true });
            }
          }
        });

      } catch (error) {
        console.error('[EsptoolPy] 烧录异常:', error);
        if (tempFilePath) {
          this.cleanupSingleFile(tempFilePath);
        }
        reject(error);
      }
    });
    
    return {
      promise,
      streamIdPromise
    };
  }

  /**
   * 使用 Python esptool 烧录固件（已废弃，请使用 flashSingleFile）
   * @deprecated 使用 flashSingleFile 代替
   */
  async flashWithScript(options: FlashWithScriptOptions): Promise<{ success: boolean, streamId: string }> {
    // 如果只有一个文件，直接调用 flashSingleFile
    if (options.flashFiles.length === 1) {
      const result = this.flashSingleFile(options.flashFiles[0], options.port, {
        chip: options.chip,
        baudRate: options.baudRate,
        beforeFlash: options.beforeFlash,
        afterFlash: options.afterFlash,
        progressCallback: options.progressCallback
      });
      
      // 等待烧录完成和 streamId
      const [promiseResult, streamId] = await Promise.all([result.promise, result.streamIdPromise]);
      return {
        success: promiseResult.success,
        streamId
      };
    }
    
    // 多个文件时，依次烧录
    throw new Error('请使用 flashSingleFile 分别烧录固件和模型');
  }

  /**
   * 清理临时文件
   * @param tempFiles 临时文件列表
   */
  private cleanupTempFiles(tempFiles: Array<{ path: string, address: string }>): void {
    for (const file of tempFiles) {
      try {
        if (window['fs'].existsSync(file.path)) {
          window['fs'].unlinkSync(file.path);
        }
      } catch (e) {
        console.warn('[EsptoolPy] 清理临时文件失败:', e);
      }
    }
  }

  /**
   * 清理单个临时文件
   * @param filePath 文件路径
   */
  private cleanupSingleFile(filePath: string): void {
    try {
      if (filePath && window['fs'].existsSync(filePath)) {
        window['fs'].unlinkSync(filePath);
        // console.log('[EsptoolPy] 清理临时文件:', filePath);
      }
    } catch (e) {
      console.warn('[EsptoolPy] 清理临时文件失败:', e);
    }
  }

  /**
   * 取消烧录（通过 kill 进程）
   * @param streamId 流ID
   */
  cancelFlash(streamId: string): void {
    try {
      this.cmdService.kill(streamId);
      // console.log('[EsptoolPy] 已请求取消烧录');
    } catch (error) {
      console.error('[EsptoolPy] 取消烧录失败:', error);
    }
  }
}
