import { Injectable } from '@angular/core';
import { arduinoGenerator } from '../blockly/generators/arduino/arduino';
import { BlocklyService } from '../blockly/blockly.service';
import { ProjectService } from './project.service';
import { ActionState, UiService } from './ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../services/notice.service';
import { CmdOutput, CmdService } from './cmd.service';
import { NpmService } from './npm.service';
import { LogService } from './log.service';
import { ConfigService } from './config.service';

@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  constructor(
    private blocklyService: BlocklyService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private message: NzMessageService,
    private noticeService: NoticeService,
    private logService: LogService,
    private npmService: NpmService,
    private configService: ConfigService,
  ) { }

  private buildInProgress = false;
  private streamId: string | null = null;
  private buildCompleted = false;
  private isErrored = false; // 标识是否为错误状态

  currentProjectPath = "";
  lastCode = "";
  passed = false;
  cancelled = false;
  boardType = "";
  sdkPath = "";
  toolsPath = "";
  compilerPath = "";
  boardJson: any = null;
  buildPath = "";

  // 添加这个错误处理方法
  private handleCompileError(errorMessage: string) {
    console.error("handle errror: ", errorMessage);
    this.noticeService.update({
      title: "编译失败",
      text: errorMessage,
      detail: errorMessage,
      state: 'error',
      setTimeout: 600000
    });

    this.passed = false;
    this.isErrored = true;
    this.buildInProgress = false;
  }

  async build(): Promise<ActionState> {
    return new Promise<ActionState>(async (resolve, reject) => {
      try {
        if (this.buildInProgress) {
          this.message.warning("编译正在进行中，请稍后再试");
          reject({ state: 'warn', text: '编译中，请稍后' });
          return;
        }

        if (this.npmService.isInstalling) {
          this.message.warning("相关依赖正在安装中，请稍后再试");
          reject({ state: 'warn', text: '依赖安装中，请稍后' });
          return;
        }

        this.noticeService.update({
          title: "编译准备中",
          text: "首次编译可能会等待较长时间",
          state: 'doing',
          progress: 0,
          setTimeout: 0,
          stop: () => {
            this.cancel();
          }
        });

        // this.noticeService.clear();
        this.currentProjectPath = this.projectService.currentProjectPath;
        const tempPath = this.currentProjectPath + '/.temp';
        const sketchPath = tempPath + '/sketch';
        const sketchFilePath = sketchPath + '/sketch.ino';
        const librariesPath = tempPath + '/libraries';

        this.buildPath = tempPath + '/build';

        this.buildCompleted = false;
        this.buildInProgress = true;
        this.streamId = "";
        this.isErrored = false; // 重置错误状态
        this.cancelled = false; // 重置取消状态

        // 创建临时文件夹
        if (!window['path'].isExists(tempPath)) {
          await this.cmdService.runAsync(`New-Item -Path "${tempPath}" -ItemType Directory -Force`);
        }
        if (!window['path'].isExists(sketchPath)) {
          await this.cmdService.runAsync(`New-Item -Path "${sketchPath}" -ItemType Directory -Force`);
        }
        if (!window['path'].isExists(librariesPath)) {
          await this.cmdService.runAsync(`New-Item -Path "${librariesPath}" -ItemType Directory -Force`);
        }

        // 生成sketch文件
        const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
        this.lastCode = code;
        await window['fs'].writeFileSync(sketchFilePath, code);

        // 加载项目package.json
        const packageJson = await this.projectService.getPackageJson();
        const dependencies = packageJson.dependencies || {};

        const libsPath = []
        Object.entries(dependencies).forEach(([key, version]) => {
          if (key.startsWith('@aily-project/lib-') && !key.startsWith('@aily-project/lib-core')) {
            libsPath.push(key)
          }
        });

        // 获取板子信息(board.json)
        const boardJson = await this.projectService.getBoardJson();

        if (!boardJson) {
          this.handleCompileError('未找到板子信息(board.json)');
          throw new Error('未找到板子信息(board.json)');
        }

        this.boardJson = boardJson;

        // 解压libraries到临时文件夹
        // 用于记录已复制的库文件夹名称
        const copiedLibraries: string[] = [];
        
        for (let lib of libsPath) {
          let sourcePath = `${this.currentProjectPath}/node_modules/${lib}/src`;
          if (!window['path'].isExists(sourcePath)) {
            // 如果没有src文件夹，则使用src.7z解压到临时文件夹
            let sourceZipPath = `${this.currentProjectPath}/node_modules/${lib}/src.7z`;
            if (!window['path'].isExists(sourceZipPath)) continue;
            await this.cmdService.runAsync(`7za x "${sourceZipPath}" -o"${sourcePath}" -y`);
          }

          // 判断src目录下是否有且仅有一个src目录，没有别的文件或文件夹
          if (window['fs'].existsSync(sourcePath)) {
            const srcContents = window['fs'].readDirSync(sourcePath);
            if (srcContents.length === 1 &&
              srcContents[0].name === 'src' &&
              window['fs'].isDirectory(`${sourcePath}/${srcContents[0].name}`)) {
              // 如果有且仅有一个src目录，则将复制源路径定位到src/src
              console.log(`库 ${lib} 检测到嵌套src目录，使用 ${sourcePath}/src 作为源路径`);
              sourcePath = `${sourcePath}/src`;
            }
          }

          // 判断src目录下是否包含.h文件
          let hasHeaderFiles = false;
          if (window['fs'].existsSync(sourcePath)) {
            // 获取sourcePath下的所有文件，排除文件夹
            const files = window['fs'].readDirSync(sourcePath, { withFileTypes: true });
            // 检查文件是否是对象数组或字符串数组
            hasHeaderFiles = Array.isArray(files) && files.some(file => {
              // 如果是文件对象
              if (typeof file === 'object' && file !== null && file.name) {
                return file.name.toString().endsWith('.h');
              }
              // 如果是字符串
              return typeof file === 'string' && file.endsWith('.h');
            });
            if (hasHeaderFiles) {
              console.log(`库 ${lib} 包含头文件`);
              let targetName = lib.split('@aily-project/')[1];
              let targetPath = `${librariesPath}/${targetName}`;

              if (window['path'].isExists(targetPath)) {
                if (this.configService.data.devmode || false) {
                  await this.cmdService.runAsync(`Remove-Item -Path "${targetPath}" -Recurse -Force`);
                } else {
                  continue
                }
              }
              // 直接复制src到targetPath
              await this.cmdService.runAsync(`Copy-Item -Path "${sourcePath}" -Destination "${targetPath}" -Recurse -Force`);
              // 记录已复制的文件夹名称
              copiedLibraries.push(targetName);
            } else {
              // For libraries without header files, copy each directory individually
              console.log(`库 ${lib} 不包含头文件，逐个复制目录`);
              // Get all directories in the source path
              if (window['fs'].existsSync(sourcePath)) {
                const items = window['fs'].readDirSync(sourcePath);

                // Process each directory
                for (const item of items) {
                  console.log("item: ", item);
                  const fullSourcePath = `${sourcePath}/${item.name}`;

                  // Check if it's a directory
                  if (window['fs'].isDirectory(fullSourcePath)) {
                    const targetPath = `${librariesPath}/${item.name}`;

                    // Delete target directory if it exists
                    if (window['path'].isExists(targetPath)) {
                      if (this.configService.data.devmode || false) {
                        await this.cmdService.runAsync(`Remove-Item -Path "${targetPath}" -Recurse -Force`);
                      } else {
                        // 如果不是debug模式，则跳过删除
                        continue;
                      }
                    }

                    // Copy directory
                    await this.cmdService.runAsync(`Copy-Item -Path "${fullSourcePath}" -Destination "${targetPath}" -Recurse -Force`);
                    // 记录已复制的文件夹名称
                    copiedLibraries.push(item.name);
                    // console.log(`目录 ${item.name} 已复制到 ${targetPath}`);
                  }
                }
              }
            }
          }
        }

        // 检查和清理libraries文件夹
        // 输出已复制的库文件夹名称
        console.log(`已复制的库文件夹: ${copiedLibraries.join(', ')}`);
        
        // 获取libraries文件夹中的所有文件夹
        let existingFolders: string[] = [];
        
        if (window['fs'].existsSync(librariesPath)) {
          const librariesItems = window['fs'].readDirSync(librariesPath);
          existingFolders = librariesItems
            .filter(item => window['fs'].isDirectory(`${librariesPath}/${item.name || item}`))
            .map(item => item.name || item);
          
          console.log(`libraries文件夹中现有文件夹: ${existingFolders.join(', ')}`);
          
          // 直接清理不在copiedLibraries列表中的文件夹
          if (existingFolders.length > 0) {
            console.log('开始清理未使用的库文件夹');
            
            for (const folder of existingFolders) {
              // 检查文件夹是否在已复制的列表中
              const shouldKeep = copiedLibraries.some(copiedLib => {
                return folder === copiedLib || folder.startsWith(copiedLib);
              });
              
              if (!shouldKeep) {
                const folderToDelete = `${librariesPath}/${folder}`;
                console.log(`删除未使用的库文件夹: ${folder}`);
                try {
                  await this.cmdService.runAsync(`Remove-Item -Path "${folderToDelete}" -Recurse -Force`);
                } catch (error) {
                  console.warn(`删除文件夹 ${folder} 失败:`, error);
                }
              }
            }
          }
        }

        // 获取编译器、sdk、tool的名称和版本
        let compiler = ""
        let sdk = ""

        const boardDependencies = (await this.projectService.getBoardPackageJson()).boardDependencies || {};

        Object.entries(boardDependencies).forEach(([key, version]) => {
          if (key.startsWith('@aily-project/compiler-')) {
            compiler = key.replace(/^@aily-project\/compiler-/, '') + '@' + version;
          } else if (key.startsWith('@aily-project/sdk-')) {
            sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
          }
        });

        if (!compiler || !sdk) {
          this.handleCompileError('未找到编译器或SDK信息');
          throw new Error('未找到编译器或SDK信息');
        }

        // 组合编译器、sdk、tools的路径
        this.compilerPath = await window["env"].get('AILY_COMPILERS_PATH') + `/${compiler}`;
        this.sdkPath = await window["env"].get('AILY_SDK_PATH') + `/${sdk}`;
        this.toolsPath = await window["env"].get('AILY_TOOLS_PATH');

        // 获取编译命令
        let compilerParam = boardJson.compilerParam;
        if (!compilerParam) {
          this.handleCompileError('未找到编译命令(compilerParam)');
          throw new Error('未找到编译命令(compilerParam)');
        }

        let compilerParamList = compilerParam.split(' ');
        compilerParamList = compilerParamList.map(param => {
          if (param.startsWith('aily:')) {
            let res;
            const parts = param.split(':');
            if (parts.length > 2) { // Ensure we have at least 3 parts (aily:avr:mega)
              parts[1] = sdk;
              res = parts.join(':');
            } else {
              res = param
            }
            this.boardType = res
            return res; // Return unchanged if format doesn't match
          } else {
            return param;
          }
        });

        compilerParam = compilerParamList.join(' ');

        // 获取和解析项目编译参数
        let buildProperties = '';
        try {
          const projectConfig = await this.projectService.getProjectConfig();
          if (projectConfig) {
            const buildPropertyParams: string[] = [];
            
            // 遍历配置对象，解析编译参数
            Object.values(projectConfig).forEach((configSection: any) => {
              if (configSection && typeof configSection === 'object') {
                // 遍历每个配置段（如 build、upload 等）
                Object.entries(configSection).forEach(([sectionKey, sectionValue]: [string, any]) => {
                  // 排除upload等非编译相关的配置段
                  if (sectionKey == 'upload') return;
                  if (sectionValue && typeof sectionValue === 'object') {
                    // 遍历具体的配置项
                    Object.entries(sectionValue).forEach(([key, value]: [string, any]) => {
                      buildPropertyParams.push(`--build-property ${sectionKey}.${key}=${value}`);
                    });
                  }
                });
              }
            });
            
            buildProperties = buildPropertyParams.join(' ');
            if (buildProperties) {
              buildProperties = ' ' + buildProperties; // 在前面添加空格
            }
          }
        } catch (error) {
          console.warn('获取项目配置失败:', error);
        }

        // 将buildProperties添加到compilerParam中
        compilerParam += buildProperties;

        const compileCommand = `aily-arduino-cli.exe ${compilerParam} --jobs 0 --libraries '${librariesPath}' --board-path '${this.sdkPath}' --compile-path '${this.compilerPath}' --tools-path '${this.toolsPath}' --output-dir '${this.buildPath}' --log-level debug '${sketchFilePath}'${buildProperties} --verbose`;
        
        const title = `编译 ${boardJson.name}`;
        const completeTitle = `编译完成`;

        let lastProgress = 0;
        let lastBuildText = '';
        let bufferData = '';
        let completeLines = '';
        let lastStdErr = '';
        let isBuildText = false;
        let outputComplete = false;
        let flashInfo = '';
        let ramInfo = '';
        let lastLogLines: string[] = [];

        this.cmdService.run(compileCommand, null, false).subscribe({
          next: (output: CmdOutput) => {
            console.log('编译命令输出:', output);
            this.streamId = output.streamId;

            if (!this.isErrored && output.type == 'stderr') {
              if (output.data) {
                lastStdErr = output.data.trim();
              }
            }

            if (output.data) {
              const data = output.data;
              if (data.includes('\r\n') || data.includes('\n') || data.includes('\r')) {
                // 分割成行，同时处理所有三种换行符情况
                const lines = (bufferData + data).split(/\r\n|\n|\r/);
                // 最后一个可能不完整的行保留为新的bufferData
                bufferData = lines.pop() || '';
                // 处理完整的行
                // completeLines = lines.join('\n');
                // this.logService.update({"detail": completeLines});

                lines.forEach((line: string) => {
                  // 处理每一行输出
                  let trimmedLine = line.trim();

                  if (!trimmedLine) return; // 如果行为空，则跳过处理

                  // const cleanLine = line.replace(/\[\d+(;\d+)*m/g, '');
                  // this.logService.update({ "detail": line });

                  // 检查是否有错误信息
                  if (/error:|error during build:|failed|fatal/i.test(trimmedLine)) {
                    console.error("检测到编译错误:", trimmedLine);
                    // 提取更有用的错误信息，避免过长
                    // const errorMatch = trimmedLine.match(/error:(.+?)($|(\s+at\s+))/i);
                    // const errorText = errorMatch ? errorMatch[1].trim() : trimmedLine;
                    // this.handleCompileError(errorText);
                    this.isErrored = true;
                    return;
                  }

                  if (output.type === 'stderr') {
                    return; // 如果是stderr输出，则不处理
                  }

                  // if (this.isErrored) {
                  //   // this.logService.update({ "detail": line, "state": "error" });
                  //   return;
                  // }

                  // 提取构建文本
                  if (trimmedLine.startsWith('BuildText:')) {
                    const lineContent = trimmedLine.replace('BuildText:', '').trim();
                    const buildText = lineContent.split(/[\n\r]/)[0];
                    lastBuildText = buildText;
                    isBuildText = true;
                  } else {
                    isBuildText = false;
                  }

                  // 提取进度信息
                  const progressInfo = trimmedLine.trim();
                  let progressValue = 0;
                  let isProgress = false;

                  // Match patterns like [========================================          ] 80%
                  const barProgressMatch = progressInfo.match(/\[.*?\]\s*(\d+)%/);
                  if (barProgressMatch) {
                    try {
                      progressValue = parseInt(barProgressMatch[1], 10);
                    } catch (error) {
                      progressValue = 0;
                      console.warn('进度解析错误:', error);
                    } finally {
                      isProgress = true;
                    }
                  }

                  if (progressValue > lastProgress) {
                    console.log("progress: ", lastProgress);
                    lastProgress = progressValue;
                    this.noticeService.update({
                      title: title,
                      text: lastBuildText,
                      state: 'doing',
                      progress: lastProgress,
                      setTimeout: 0,
                      stop: () => {
                        this.cancel();
                      }
                    });
                  }

                  // 进度为100%时标记完成
                  if (lastProgress === 100) {
                    this.buildCompleted = true;
                  }

                  if (!isProgress && !isBuildText) { 
                    // 如果不是进度信息，则直接更新日志
                    // 判断是否包含:Global variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.
                    if (trimmedLine.includes('Global variables use')) {
                      outputComplete = true;
                      this.logService.update({ "detail": trimmedLine, "state": "done" });
                    } else {
                      if (!outputComplete) {
                        this.logService.update({ "detail": trimmedLine, "state": "doing" });
                      }
                    }
                    
                    // 收集最后的几行日志用于提取固件信息
                    lastLogLines.push(trimmedLine);
                    if (lastLogLines.length > 30) {
                      lastLogLines.shift(); // 保持最后30行
                    }
                  }
                });
              } else {
                // 没有换行符，直接追加
                bufferData += data;
              }
            } else {
              bufferData += '';
            }
          },
          error: (error: any) => {
            console.error('编译过程中发生错误:', error);
            this.handleCompileError(error.message);
            reject({ state: 'error', text: error.message });
          },
          complete: () => {
            console.log('编译命令执行完成'); 
            if (this.isErrored) {
              console.error('编译过程中发生错误，编译未完成');
              this.noticeService.update({
                title: "编译失败",
                text: '编译失败',
                detail: lastStdErr,
                state: 'error',
                setTimeout: 600000
              });
              // this.logService.update({ title: "编译失败", detail: lastStdErr, state: 'error' });
              this.buildInProgress = false;
              this.passed = false;
              // 终止Arduino CLI进程
              this.cmdService.killArduinoCli();
              reject({ state: 'error', text: '编译失败' });
            } else if (this.buildCompleted) {
              console.log('编译命令执行完成');
              // 提取flash和ram信息
              const displayText = this.extractFirmwareInfo(lastLogLines);
              this.noticeService.update({ title: completeTitle, text: displayText, state: 'done', setTimeout: 600000 });
              this.buildInProgress = false;
              this.passed = true;
              resolve({ state: 'done', text: '编译完成' });
            } else if (this.cancelled) {
              console.warn("编译中断")
              this.noticeService.update({
                title: "编译已取消",
                text: '编译已取消',
                state: 'warn',
                setTimeout: 55000
              });
              this.buildInProgress = false;
              this.passed = false;
              // 终止Arduino CLI进程
              this.cmdService.killArduinoCli();
              reject({ state: 'warn', text: '编译已取消' });
            } else {
              console.warn('编译命令未完成，可能是由于超时或其他原因');
              this.noticeService.update({
                title: "编译失败",
                text: lastStdErr.slice(0, 30) + "..." || '编译未完成',
                detail: lastStdErr,
                state: 'error',
                setTimeout: 600000
              });
              this.buildInProgress = false;
              this.passed = false;
              // 终止Arduino CLI进程
              this.cmdService.killArduinoCli();
              reject({ state: 'warn', text: '编译未完成' });
            }
          }
        })
      } catch (error) {
        console.error('编译过程中发生错误:', error);
        this.handleCompileError(error.message);
        reject({ state: 'error', text: error.message });
      }
    });
  }

  /**
   * 从编译日志中提取固件信息
   * @param logLines 编译日志行数组
   * @returns 格式化的固件使用情况文本
   */
  private extractFirmwareInfo(logLines: string[]): string {
    // console.log("logLines: ", logLines);
    const logText = logLines.join(' ');    
    // 提取flash信息：Sketch uses 2706878 bytes (86%) of program storage space. Maximum is 3145728 bytes.
    const flashMatch = logText.match(/Sketch uses (\d+) bytes \((\d+)%\) of program storage space\.\s*Maximum is (\d+) bytes/);
    // 提取ram信息：Global variables use 47628 bytes (14%) of dynamic memory, leaving 280052 bytes for local variables. Maximum is 327680 bytes.
    const ramMatch = logText.match(/Global variables use (\d+) bytes \((\d+)%\) of dynamic memory.*?Maximum is (\d+) bytes/);
    
    if (flashMatch && ramMatch) {
      const flashUsed = flashMatch[1];
      const flashPercent = flashMatch[2];
      const flashMax = flashMatch[3];
      
      const ramUsed = ramMatch[1];
      const ramPercent = ramMatch[2];
      const ramMax = ramMatch[3];
      
      return `Flash use ${flashPercent}%   Ram use ${ramPercent}%`;
    }
    
    return "编译完成";
  }

  /**
 * 取消当前编译过程
 */
  cancel() {
    this.cancelled = true;
    this.cmdService.kill(this.streamId || '');
  }
}
