import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { SerialService } from './serial.service';
import { arduinoGenerator } from '../blockly/generators/arduino/arduino';
import { ActionState, UiService } from './ui.service';
import { BuilderService } from './builder.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BlocklyService } from '../blockly/blockly.service';
import { NoticeService } from '../services/notice.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { SerialDialogComponent } from '../main-window/components/serial-dialog/serial-dialog.component';
import { CmdOutput, CmdService } from './cmd.service';
import { LogService } from './log.service';
import { NpmService } from './npm.service';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private projectService: ProjectService,
    private serialService: SerialService,
    private message: NzMessageService,
    private blocklyService: BlocklyService,
    private builderService: BuilderService,
    private noticeService: NoticeService,
    private modal: NzModalService,
    private cmdService: CmdService,
    private logService: LogService,
    private npmService: NpmService,
  ) { }

  private uploadInProgress = false;
  private streamId: string | null = null;
  private uploadCompleted = false;
  private isErrored = false;
  cancelled = false;

  // 定义正则表达式，匹配常见的进度格式
  progressRegexPatterns = [
    // Writing | ################################################## | 78% 0.12s
    /\|\s*#+\s*\|\s*\d+%.*$/,
    // [==============================] 84% (11/13 pages)
    /\[\s*={1,}>*\s*\]\s*\d+%.*$/,
    // Writing | ████████████████████████████████████████████████▉  | 98% 
    /\|\s*\d+%\s*$/,
    // 或者只是数字+百分号（例如：[====>    ] 70%）
    /\b(\d+)%\b/,
    // Writing at 0x0005446e... (18 %)
    // Writing at 0x0002d89e... (40 %)
    // Writing at 0x0003356b... (50 %)
    /Writing\s+at\s+0x[0-9a-f]+\.\.\.\s+\(\d+\s*%\)/i,
    // 70% 13/18
    /^(\d+)%\s+\d+\/\d+/,
    // 标准格式：数字%（例如：70%）
    /(?:进度|Progress)[^\d]*?(\d+)%/i,
    // 带空格的格式（例如：70 %）
    /(?:进度|Progress)[^\d]*?(\d+)\s*%/i,
  ];

  // 添加这个错误处理方法
  private handleUploadError(errorMessage: string, title="上传失败") {
    console.error("handle errror: ", errorMessage);
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
  }

  async upload(): Promise<ActionState> {
    return new Promise<ActionState>(async (resolve, reject) => {
      try {
        if (this.uploadInProgress) {
          this.message.warning('上传中，请稍后');
          reject({ state: 'warn', text: '上传中，请稍后' });
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
        const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
        if (!this.builderService.passed || code !== this.builderService.lastCode || this.projectService.currentProjectPath !== this.builderService.currentProjectPath) {
          // 编译
          try {
            const buildResult = await this.builderService.build();
            console.log("build result:", buildResult);
            // 编译成功，继续上传流程
          } catch (error) {
            // 编译失败，处理错误
            console.error("编译失败:", error);
            // reject(error || { state: 'error', text: '编译失败，请检查代码' });
          }
        }

        if (this.builderService.cancelled) {
          this.uploadInProgress = false;
          this.noticeService.update({
            title: "编译已取消",
            text: '编译已取消',
            state: 'warn',
            setTimeout: 55000
          });
          reject({ state: 'warn', text: '编译已取消' });
          return;
        }

        if (!this.builderService.passed) {
          this.handleUploadError('编译失败，请检查代码', "编译失败");
          reject({ state: 'error', text: '编译失败，请检查代码' });
          return;
        }

        const buildPath = this.builderService.buildPath;

        // 判断buildPath是否存在
        if (!window['path'].isExists(buildPath)) {
          // 编译
          await this.builderService.build();
        }

        const boardJson = this.builderService.boardJson;

        let lastUploadText = `正在上传${boardJson.name}`;

        // 获取上传参数
        let uploadParam = boardJson.uploadParam;
        if (!uploadParam) {
          this.handleUploadError('缺少上传参数，请检查板子配置');
          reject({ state: 'error', text: '缺少上传参数' });
          return;
        }

        let uploadParamList = uploadParam.split(' ');
        uploadParamList = uploadParamList.map(param => {
          // 替换${serial}为当前串口号
          if (param.includes('${serial}')) {
            return param.replace('${serial}', this.serialService.currentPort);
          } else if (param.startsWith('aily:')) {
            return this.builderService.boardType;
          }
          return param;
        });

        uploadParam = uploadParamList.join(' ');
        const sdkPath = this.builderService.sdkPath;
        const toolsPath = this.builderService.toolsPath;

        // 上传
        // await this.uiService.openTerminal();

        const title = '上传中';
        const completeTitle = '上传完成';
        const errorTitle = '上传失败';
        const completeText = '上传完成';
        let lastProgress = 0;

        let errorText = '';

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
                  if (sectionKey == 'build') return;
                  if (sectionValue && typeof sectionValue === 'object') {
                    // 遍历具体的配置项
                    Object.entries(sectionValue).forEach(([key, value]: [string, any]) => {
                      buildPropertyParams.push(`--upload-property ${sectionKey}.${key}=${value}`);
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
        uploadParam += buildProperties;

        const uploadCmd = `aily-arduino-cli.exe ${uploadParam} --input-dir ${buildPath} --board-path ${sdkPath} --tools-path ${toolsPath} --verbose`;

        this.uploadInProgress = true;
        this.noticeService.update({ title: title, text: lastUploadText, state: 'doing', progress: 0, setTimeout: 0 });

        let bufferData = '';
        this.cmdService.run(uploadCmd, null, false).subscribe({
          next: (output: CmdOutput) => {
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
                          console.log("match: ", match);
                          let numericMatch = trimmedLine.match(/(\d+)%/);
                          if (!numericMatch) {
                            numericMatch = trimmedLine.match(/(\d+)\s*%/);
                          }
                          console.log("numericMatch: ", numericMatch);
                          if (numericMatch) {
                            progressValue = parseInt(numericMatch[1], 10);
                            if (lastProgress == 0 && progressValue > 100) {
                              progressValue = 0;
                            }
                            break; // 找到匹配后停止循环
                          }
                        }
                      }
                    }

                    if (progressValue && progressValue > lastProgress) {
                      console.log("progress: ", lastProgress);
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
            console.error("上传错误:", error);
            this.handleUploadError(error.message || '上传过程中发生错误');
            reject({ state: 'error', text: error.message || '上传失败' });
          },
          complete: () => {
            console.log("bufferData: ", bufferData);
            if(this.isErrored) {
              console.error("上传过程中发生错误，已取消");
              this.handleUploadError('上传过程中发生错误');
              // 终止Arduino CLI进程
              this.cmdService.killArduinoCli();
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
              // 终止Arduino CLI进程
              this.cmdService.killArduinoCli();
              reject({ state: 'warn', text: '上传已取消' });
            } else {
              console.warn("上传未完成，可能是由于超时或其他原因");
              this.noticeService.update({
                title: errorTitle,
                text: lastUploadText,
                detail: errorText,
                state: 'error',
                setTimeout: 600000
              });
              this.uploadInProgress = false;
              // 终止Arduino CLI进程
              this.cmdService.killArduinoCli();
              reject({ state: 'error', text: '上传未完成，请检查日志' });
            }
          }
        })
      } catch (error) {
        console.error("上传异常:", error);
        this.handleUploadError(error.message || '上传失败');
        reject({ state: 'error', text: error.message || '上传失败' });
      }
    });
  }

  /**
* 取消当前编译过程
*/
  cancel() {
    this.cancelled = true;
    this.cmdService.kill(this.streamId || '');
  }
}

