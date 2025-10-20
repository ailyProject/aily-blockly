import { Injectable } from "@angular/core";
import { ProjectService } from "../../../services/project.service";
import { SerialService } from "../../../services/serial.service";
import { NzMessageService } from "ng-zorro-antd/message";
import { _BuilderService } from "./builder.service";
import { NoticeService } from "../../../services/notice.service";
import { NzModalService } from "ng-zorro-antd/modal";
import { CmdOutput, CmdService } from "../../../services/cmd.service";
import { LogService } from "../../../services/log.service";
import { NpmService } from "../../../services/npm.service";
import { SerialMonitorService } from "../../../tools/serial-monitor/serial-monitor.service";
import { ActionState } from "../../../services/ui.service";
import { SerialDialogComponent } from "../../../main-window/components/serial-dialog/serial-dialog.component";
import { ActionService } from "../../../services/action.service";
import { arduinoGenerator } from "../components/blockly/generators/arduino/arduino";
import { BlocklyService } from "./blockly.service";
import { findFile } from '../../../utils/builder.utils';
import { error } from "console";

@Injectable()
export class _UploaderService {

  constructor(
    private projectService: ProjectService,
    private serialService: SerialService,
    private message: NzMessageService,
    private _builderService: _BuilderService,
    private noticeService: NoticeService,
    private modal: NzModalService,
    private cmdService: CmdService,
    private logService: LogService,
    private npmService: NpmService,
    private serialMonitorService: SerialMonitorService,
    private actionService: ActionService,
    private blocklyService: BlocklyService
  ) { }

  uploadInProgress = false;
  private streamId: string | null = null;
  private uploadCompleted = false;
  private isErrored = false;
  cancelled = false;
  private commandName: string | null = null;
  
  private initialized = false; // 防止重复初始化

  // 定义正则表达式，匹配常见的进度格式
  progressRegexPatterns = [
    // Writing | ################################################## | 78% 0.12s
    /\|\s*#+\s*\|\s*\d+%.*$/,
    // [==============================] 84% (11/13 pages)
    /\[\s*={1,}>*\s*\]\s*\d+%.*$/,
    // Writing | ████████████████████████████████████████████████▉  | 98% 
    /\|\s*\d+%\s*$/,
    // Writing at 0x00a2b8d7 [============================> ]  97.1% 196608/202563 bytes...
    /Writing\s+at\s+0x[0-9a-f]+\s+\[.*?\]\s+(\d+(?:\.\d+)?)%/i,
    // Writing at 0x0005446e... (18 %)
    // Writing at 0x0002d89e... (40 %)
    // Writing at 0x0003356b... (50 %)
    /Writing\s+at\s+0x[0-9a-f]+\.\.\.\s+\(\d+\s*%\)/i,
    // Wrote and verified address 0x08001700 (79.31%)
    /Wrote\s+and\s+verified\s+address\s+0x[0-9a-f]+\s+\((\d+(?:\.\d+)?)%\)/i,
    // 或者只是数字+百分号（例如：[====>    ] 70%）
    /\b(\d+(?:\.\d+)?)%\b/,
    // 70% 13/18
    /^(\d+)%\s+\d+\/\d+/,
    // 标准格式：数字%（例如：70%）
    /(?:进度|Progress)[^\d]*?(\d+)%/i,
    // 带空格的格式（例如：70 %）
    /(?:进度|Progress)[^\d]*?(\d+)\s*%/i,
  ];

  init() {
    if (this.initialized) {
      console.warn('_UploaderService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;
    this.actionService.listen('upload-begin', async (action) => {
      try {
        const result = await this.upload();
        return { success: true, result };
      } catch (msg) {
        return { success: false, result: msg };
      }
    }, 'uploader-upload-begin');
    this.actionService.listen('upload-cancel', (action) => {
      this.cancel();
    }, 'uploader-upload-cancel');
  }

  destroy() {
    console.log("_UploaderService destroy");
    this.actionService.unlisten('uploader-upload-begin');
    this.actionService.unlisten('uploader-upload-cancel');
    this.initialized = false; // 重置初始化状态
  }

  /**
   * 处理上传参数，统一处理所有参数替换和文件查找逻辑
   * @param uploadParam 原始上传参数字符串
   * @param buildPath 构建路径
   * @param toolsPath 工具路径
   * @returns 处理后的参数列表、标志和命令信息
   */
  private async processUploadParams(uploadParam: string, buildPath: string, toolsPath: string, sdkPath: string, baudRate: string) {
    const flags = {
      use_1200bps_touch: false,
      wait_for_upload: false
    };

    // 第一步：分割参数并处理基本变量替换和标志提取
    // 使用正则先提取出以[]包裹的标志参数，并从原来的字符串中移除
    const flagParams = uploadParam.match(/\[([^\]]+)\]/g) || [];

    flagParams.forEach(flag => {
      if (flag.includes('--use_1200bps_touch')) {
        flags.use_1200bps_touch = true;
      }
      if (flag.includes('--wait_for_upload')) {
        flags.wait_for_upload = true;
      }
      if (flag.includes('--wait_for_upload_port')) {
        flags.wait_for_upload = true;
      }
    });

    // 移除标志参数后的上传参数字符串
    uploadParam = uploadParam.replace(/\[([^\]]+)\]/g, '').trim();

    let paramPromises = uploadParam.split(' ').map(async param => {
      if (param.includes('${baud}')) {
        return param.replace('${baud}', baudRate || '115200');
      } else if (param.includes('${bootloader}')) {
        const bootLoaderFile = await findFile(buildPath, '*.bootloader.bin', '');
        return param.replace('${bootloader}', bootLoaderFile);
      } else if (param.includes('${partitions}')) {
        const partitionsFile = await findFile(buildPath, '*.partitions.bin', '');
        return param.replace('${partitions}', partitionsFile);
      } else if (param.includes('${boot_app0}')) {
        return param.replace('${boot_app0}', `${sdkPath}/tools/partitions/boot_app0.bin`)
      }
      return param;
    });
    
    let paramList = (await Promise.all(paramPromises)).filter(param => param !== ""); // 过滤掉空字符串（标志参数）

    console.log("Processed upload params: ", paramList, flags);

    const boardPackageJson = await this.projectService.getBoardPackageJson();
    if (!boardPackageJson) {
      throw new Error('无法获取板子配置');
    }

    // 获取boardPackageJson中的boardDependencies，并筛选出以 'tool-' 或 '@aily-project/tool-' 开头的依赖
    const toolDependencies: { [key: string]: string } = {};
    Object.entries(boardPackageJson.boardDependencies || {})
      .filter(([key, value]) => key.startsWith('tool-') || key.startsWith('@aily-project/tool-'))
      .forEach(([key, value]) => {
        // 去掉可能的前缀 '@aily-project/tool-' 或 'tool-'
        let name = key;
        const prefixAily = '@aily-project/tool-';
        const prefixTool = 'tool-';
        if (name.startsWith(prefixAily)) {
          name = name.slice(prefixAily.length);
        } else if (name.startsWith(prefixTool)) {
          name = name.slice(prefixTool.length);
        }
        toolDependencies[name] = value as string;
      });

    console.log("Tool dependencies: ", toolDependencies);

    // 第二步：查找可执行文件的完整路径
    let toolVersion = toolDependencies[paramList[0]];
    if (!toolVersion) {
      // 对toolDependencies进行更宽松的匹配，只要key中包含paramList[0]就匹配
      const matchedTool = Object.keys(toolDependencies).find(key => {
        return key.toLowerCase().includes(paramList[0].toLowerCase());
      });

      if (matchedTool) {
        toolVersion = toolDependencies[matchedTool];
      }
    }

    console.log("Upload Tool version: ", toolVersion);

    let command = '';
    if (paramList.length > 0) {
      command = await findFile(toolsPath, paramList[0] + (window['platform'].isWindows ? '.exe' : ''), toolVersion || '');
    }
    console.log("Found command: ", command);
    // 替换命令为完整路径命令
    if (command) {
      paramList[0] = command;
    }

    this.commandName = window['path'].basename(paramList[0])

    // 第三步：处理 ${'filename'} 格式的文件路径参数
    for (let i = 0; i < paramList.length; i++) {
      const param = paramList[i];
      const match = param.match(/\$\{\'(.+?)\'\}/);
      if (match) {
        const fileName = match[1];
        
        // 获取fileName后缀
        const fileNameParts = fileName.split('.');
        const fileExtension = fileNameParts.length > 1 ? fileNameParts.pop() : '';

        let findRes = '';

        // 判断后缀是否为(bin|elf|hex|eep|img|uf2)之一
        if (!['bin', 'elf', 'hex', 'eep', 'img', 'uf2'].includes(fileExtension)) {
          findRes = await findFile(toolsPath, fileName, '');
          if (!findRes) {
            findRes = await findFile(sdkPath + "/tools", fileName, '');
          }
        } else {
          findRes = await findFile(buildPath, fileName, '');
        }

        paramList[i] = param.replace(`\$\{\'${fileName}\'\}`, findRes);
      }
    }

    return {
      processedParams: paramList,
      flags,
      command
    };
  }

  // 添加这个错误处理方法
  private handleUploadError(errorMessage: string, title = "上传失败") {
    // console.error("handle errror: ", errorMessage);
    this.noticeService.update({
      title: title,
      text: errorMessage,
      detail: errorMessage,
      state: 'error',
      setTimeout: 600000
    });

    this.cmdService.kill(this.streamId || '');
    this.isErrored = true;
    this.uploadInProgress = false;
    this._builderService.isUploading = false;
  }

  async upload(): Promise<ActionState> {
    return new Promise<ActionState>(async (resolve, reject) => {
      try {
        if (this.uploadInProgress) {
          this.message.warning('上传中，请稍后');
          reject({ state: 'warn', text: '上传中，请稍后' });
          return;
        }

        if (this._builderService.buildInProgress) {
          this.message.warning('正在编译，请稍后再试');
          reject({ state: 'warn', text: '正在编译，请稍后' });
          return;
        }

        if (this.npmService.isInstalling) {
          this.message.warning('相关依赖正在安装中，请稍后再试');
          reject({ state: 'warn', text: '依赖安装中，请稍后' });
          return;
        }

        if (!this.serialService.currentPort) {
          this.message.warning('请先选择串口');
          this.uploadInProgress = false;
          this._builderService.isUploading = false;
          reject({ state: 'warn', text: '请先选择串口' });
          this.modal.create({
            nzTitle: null,
            nzFooter: null,
            nzClosable: false,
            nzBodyStyle: {
              padding: '0',
            },
            nzWidth: '320px',
            nzContent: SerialDialogComponent,
          });
          return;
        }

        this.isErrored = false;
        this.cancelled = false;
        this.uploadCompleted = false;

        // 重置ESP32上传状态，防止进度累加
        this['esp32UploadState'] = {
          currentRegion: 0,
          totalRegions: 0,
          detectedRegions: false,
          completedRegions: 0
        };

        this.uploadInProgress = true;
        this.noticeService.clear()

        // 对比代码是否有变化
        this._builderService.cancelled = false;
        const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
        if (!this._builderService.passed || code !== this._builderService.lastCode || this.projectService.currentProjectPath !== this._builderService.currentProjectPath) {
          // 编译
          try {
            const buildResult = await this._builderService.build();
            console.log("build result:", buildResult);
            // 编译成功，继续上传流程
          } catch (error) {
            // 编译失败，处理错误
            // console.error("编译失败:", error);
            // reject(error || { state: 'error', text: '编译失败，请检查代码' });
          }
        }

        if (this._builderService.cancelled) {
          this.uploadInProgress = false;
          this._builderService.isUploading = false;
          this.noticeService.update({
            title: "编译已取消",
            text: '编译已取消',
            state: 'warn',
            setTimeout: 55000
          });
          reject({ state: 'warn', text: '编译已取消' });
          return;
        }

        if (!this._builderService.passed) {
          this.handleUploadError('编译失败，请检查代码', "编译失败");
          reject({ state: 'error', text: '编译失败，请检查代码' });
          return;
        }

        // 辨识上传中
        this._builderService.isUploading = true;

        const buildPath = this._builderService.buildPath;
        const sdkPath = this._builderService.sdkPath;
        const toolsPath = this._builderService.toolsPath;

        // 判断buildPath是否存在
        if (!window['path'].isExists(buildPath)) {
          // 编译
          await this._builderService.build();
        }

        const boardJson = this._builderService.boardJson;

        let lastUploadText = `正在上传${boardJson.name}`;

        let uploadParam = '';
        let uploadParamList: string[] = [];

        let baudRate = '';

        // 获取上传参数
        uploadParam = boardJson.uploadParam;
        if (!uploadParam) {
          this.handleUploadError('缺少上传参数，请检查板子配置');
          reject({ state: 'error', text: '缺少上传参数' });
          return;
        }

        try {
          const projectConfig = await this.projectService.getProjectConfig();
          console.log("Project config: ", projectConfig);
          if (projectConfig) {
            baudRate = projectConfig?.UploadSpeed || '';
          }
        } catch (error) {
          console.warn('没有额外的自定义配置');
        }

        // 解析和处理上传参数
        let processedParams: string[];
        let flags: { use_1200bps_touch: boolean; wait_for_upload: boolean };
        let command: string;
        
        try {
          const result = await this.processUploadParams(uploadParam, buildPath, toolsPath, sdkPath, baudRate);
          processedParams = result.processedParams;
          flags = result.flags;
          command = result.command;
        } catch (error) {
          this.handleUploadError(error.message || '参数处理失败');
          reject({ state: 'error', text: error.message || '参数处理失败' });
          return;
        }

        uploadParamList = processedParams;
        const use_1200bps_touch = flags.use_1200bps_touch;
        const wait_for_upload = flags.wait_for_upload;

        if (!command) {
          this.handleUploadError('上传工具未找到，请检查安装');
          reject({ state: 'error', text: '上传工具未找到' });
          return;
        }

        // 上传预处理
        if (use_1200bps_touch) {
          await this.serialMonitorService.connect({ path: this.serialService.currentPort || '', baudRate: 1200 });
          // await new Promise(resolve => setTimeout(resolve, 250));
          this.serialMonitorService.disconnect();
        }

        console.log("Wait for upload:", wait_for_upload);

        if (wait_for_upload) {
          const portList = await this.serialMonitorService.getPortsList();
          await this.serialMonitorService.connect({ path: this.serialService.currentPort });
          await new Promise(resolve => setTimeout(resolve, 5000));
          this.serialMonitorService.disconnect();
          const currentPortList = await this.serialMonitorService.getPortsList();

          // 对比portList和currentPortList, 找出新增的port
          const newPorts = currentPortList.filter(port => !portList.some(existingPort => existingPort.path === port.path));
          if (newPorts.length > 0) {
            this.serialService.currentPort = newPorts[0].path;
          } else {
            console.log("没有检测到新串口，继续使用旧串口");
          }
        }

        const title = '上传中';
        const completeTitle = '上传完成';
        const errorTitle = '上传失败';
        const completeText = '上传完成';
        let lastProgress = 0;

        let errorText = '';

        // // 获取和解析项目编译参数
        // let buildProperties = '';
        // try {
        //   const projectConfig = await this.projectService.getProjectConfig();
        //   if (projectConfig) {
        //     const buildPropertyParams: string[] = [];

        //     // 遍历配置对象，解析编译参数
        //     Object.values(projectConfig).forEach((configSection: any) => {
        //       if (configSection && typeof configSection === 'object') {
        //         // 遍历每个配置段（如 build、upload 等）
        //         Object.entries(configSection).forEach(([sectionKey, sectionValue]: [string, any]) => {
        //           // 排除upload等非编译相关的配置段
        //           if (sectionKey == 'build') return;
        //           if (sectionValue && typeof sectionValue === 'object') {
        //             // 遍历具体的配置项
        //             Object.entries(sectionValue).forEach(([key, value]: [string, any]) => {
        //               buildPropertyParams.push(`--upload-property ${sectionKey}.${key}=${value}`);
        //             });
        //           }
        //         });
        //       }
        //     });

        //     buildProperties = buildPropertyParams.join(' ');
            
        //     if (buildProperties) {
        //       buildProperties = ' ' + buildProperties; // 在前面添加空格
        //     }
        //   }
        // } catch (error) {
        //   console.warn('获取项目配置失败:', error);
        // }

        // 将buildProperties添加到compilerParam中
        // uploadParam += buildProperties;
        // const uploadCmd = uploadParam;

        const buildProperties = '';

        let uploadCmd = `${command} ${uploadParamList.slice(1).join(' ')}${buildProperties}`;
        console.log("Upload cmd: ", uploadCmd);

        uploadCmd = uploadCmd.replace('${serial}', this.serialService.currentPort || '');

        console.log("Final upload cmd: ", uploadCmd);

        this.uploadInProgress = true;
        this.noticeService.update({ title: title, text: lastUploadText, state: 'doing', progress: 0, setTimeout: 0 });

        let bufferData = '';
        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: async (output: CmdOutput) => {
            // console.log('编译命令输出:', output);
            this.streamId = output.streamId;

            if (output.data) {
              const data = output.data;
              if (data.includes('\r\n') || data.includes('\n') || data.includes('\r')) {
                // 分割成行，同时处理所有三种换行符情况
                const lines = (bufferData + data).split(/\r\n|\n|\r/);
                // 最后一个可能不完整的行保留为新的bufferData
                bufferData = lines.pop() || '';
                // 处理完整的行
                // const completeLines = lines.join('\n');

                lines.forEach((line: string) => {
                  const trimmedLine = line.trim();
                  if (trimmedLine) {
                    errorText = trimmedLine;

                    // 检查是否有错误信息
                    if (trimmedLine.toLowerCase().includes('error:') ||
                      trimmedLine.toLowerCase().includes('failed') ||
                      trimmedLine.toLowerCase().includes('a fatal error occurred') ||
                      trimmedLine.toLowerCase().includes("can't open device")) {
                      
                      this.handleUploadError(trimmedLine);
                      // return;
                    }

                    if (this.isErrored) {
                      this.logService.update({ "detail": line, "state": "error" });
                      return;
                    } else {
                      this.logService.update({ "detail": line });
                    }

                    // 使用通用提取方法获取进度
                    // const progressValue = this.extractProgressFromLine(trimmedLine);
                    // console.log("trimmedLine: ", trimmedLine);
                    // ESP32特定进度跟踪
                    let isESP32Format = /Writing\s+at\s+0x[0-9a-f]+\.\.\.\s+\(\d+\s*%\)/i.test(trimmedLine);
                    // 使用静态变量跟踪ESP32上传状态
                    if (!this['esp32UploadState']) {
                      this['esp32UploadState'] = {
                        currentRegion: 0,
                        totalRegions: 0,
                        detectedRegions: false,
                        completedRegions: 0
                      };
                    }

                    // 检测擦除区域的数量来确定总区域
                    if (!this['esp32UploadState'].detectedRegions &&
                      trimmedLine.includes('Flash will be erased from')) {
                      this['esp32UploadState'].totalRegions++;
                    }

                    // 检测到"Compressed"字样表示开始新区域
                    if (trimmedLine.includes('Compressed') &&
                      trimmedLine.includes('bytes to')) {
                      this['esp32UploadState'].detectedRegions = true;
                      this['esp32UploadState'].currentRegion++;
                    }

                    // 检测到"Hash of data verified"表示一个区域完成
                    if (trimmedLine.includes('Hash of data verified')) {
                      this['esp32UploadState'].completedRegions++;
                    }

                    let progressValue = 0;

                    // 优先处理ESP32格式
                    if (isESP32Format) {
                      const numericMatch = trimmedLine.match(/\((\d+)\s*%\)/);
                      if (numericMatch) {
                        const regionProgress = parseInt(numericMatch[1], 10);

                        // 计算整体进度
                        if (this['esp32UploadState'].totalRegions > 0) {
                          // 已完成区域贡献100%，当前区域贡献按比例
                          const completedPortion = this['esp32UploadState'].completedRegions /
                            this['esp32UploadState'].totalRegions * 100;
                          const currentPortion = regionProgress /
                            this['esp32UploadState'].totalRegions;

                          progressValue = Math.floor(completedPortion + currentPortion);

                          // 进度强制显示，无论是否增加
                          lastProgress = progressValue - 1; // 确保更新
                        } else {
                          progressValue = regionProgress;
                        }
                      }
                    } else {
                      for (const regex of this.progressRegexPatterns) {
                        const match = trimmedLine.match(regex);
                        if (match) {
                          // 提取数字部分
                          // console.log("match: ", match);
                          let numericMatch = trimmedLine.match(/(\d+(?:\.\d+)?)%/);
                          if (!numericMatch) {
                            numericMatch = trimmedLine.match(/(\d+(?:\.\d+)?)\s*%/);
                          }
                          // console.log("numericMatch: ", numericMatch);
                          if (numericMatch) {
                            progressValue = parseFloat(numericMatch[1]);
                            // 转换为整数，因为进度条通常使用整数
                            progressValue = Math.floor(progressValue);
                            if (lastProgress == 0 && progressValue > 100) {
                              progressValue = 0;
                            }
                            break; // 找到匹配后停止循环
                          }
                        }
                      }
                    }

                    if (progressValue && progressValue > lastProgress) {
                      // console.log("progress: ", lastProgress);
                      lastProgress = progressValue;
                      this.noticeService.update({
                        title: title,
                        text: lastUploadText,
                        state: 'doing',
                        progress: lastProgress,
                        setTimeout: 0,
                        stop: () => {
                          this.cancel()
                        }
                      });
                    }

                    // 进度为100%时标记完成
                    if (lastProgress === 100) {
                      this.uploadCompleted = true;
                    }

                    // 处理特定的完成标志: Wrote 198144 bytes to E:/NEW.UF2
                    if (trimmedLine.includes('Wrote') && trimmedLine.includes('bytes to')) {
                      this.uploadCompleted = true;
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
            console.log("上传命令错误:", error);
            this.handleUploadError(error.message || '上传过程中发生错误');
            reject({ state: 'error', text: error.message || '上传失败' });
          },
          complete: () => {
            console.log("上传命令完成");
            if (this.isErrored) {
              this.handleUploadError('上传过程中发生错误');
              // 终止Arduino CLI进程

              reject({ state: 'error', text: errorText });
            } else if (this.uploadCompleted) {
              console.log("上传完成");
              this.noticeService.update({
                title: completeTitle,
                text: completeText,
                state: 'done',
                setTimeout: 55000
              });
              this.uploadInProgress = false;
              this._builderService.isUploading = false;
              resolve({ state: 'done', text: '上传完成' });
            } else if (this.cancelled) {
              console.warn("上传中断");
              this.noticeService.update({
                title: "上传已取消",
                text: '上传已取消',
                state: 'warn',
                setTimeout: 55000
              });
              this.uploadInProgress = false;
              this._builderService.isUploading = false;

              reject({ state: 'warn', text: '上传已取消' });
            } else {
              console.warn("上传未完成，可能是由于超时或其他原因");
              this.noticeService.update({
                title: errorTitle,
                text: lastUploadText,
                detail: "超时或其他原因",
                state: 'error',
                setTimeout: 600000
              });
              this.uploadInProgress = false;
              this._builderService.isUploading = false;
              // 终止Arduino CLI进程

              reject({ state: 'error', text: '上传未完成，请检查日志' });
            }
          }
        })
      } catch (error) {
        // console.error("上传异常:", error);
        this.handleUploadError(error.message || '上传失败');
        reject({ state: 'error', text: error.message || '上传失败' });
      }
    });
  }

  /**
* 取消当前编译过程
*/
  cancel() {
    if (!this.uploadInProgress) {
      return;
    }
    this.cancelled = true;
    this.cmdService.kill(this.streamId || '');
    console.log("取消command: ", this.commandName);
    this.cmdService.killByName(this.commandName || '');
  }
}

