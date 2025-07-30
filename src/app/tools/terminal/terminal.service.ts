// 这个函数用于通过electron端控制终端

import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class TerminalService {

  isLocked = false;

  currentPid;

  constructor(
  ) { }

  async create(opts) {
    const { pid } = await window['terminal'].init({
      cols: 120,
      rows: 200,
      cwd: opts.cwd
    })
    this.currentPid = pid;
  }

  close() {
    window['terminal'].close({ pid: this.currentPid });
  }

  resize(opts) {
    window['terminal'].resize({ pid: this.currentPid, cols: opts.cols, rows: opts.rows });
  }

  send(input: string) {
    window['terminal'].sendInput({ pid: this.currentPid, input });
  }

  // sendCmd(cmd: string) {
  //   window['terminal'].sendInput({ pid: this.currentPid, input: cmd + '\r' });
  // }

  async sendCmd(input: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
      window['terminal'].sendInputAsync({ pid: this.currentPid, input: input + '\r' })
        .then(output => {
          // console.log('执行结果:', output);
          resolve(output);
        })
        .catch(err => {
          console.error('执行错误:', err);
          reject(err);
        });
    });
  }

  async startStream(): Promise<string> {
    if (!this.currentPid) {
      throw new Error('终端未初始化');
    }

    const { streamId } = await window['terminal'].startStream(this.currentPid);
    return streamId;
  }

  async stopStream(streamId: string): Promise<any> {
    if (!this.currentPid) {
      throw new Error('终端未初始化');
    }

    await window['terminal'].stopStream(this.currentPid, streamId);
  }

  // 使用流式输出执行命令
  async executeWithStream(
    input: string,
    streamId: string,
    lineCallback: (line: string) => void,
    completeCallback?: () => void
  ): Promise<any> {
    // 状态变量，用于处理回车符
    let currentBuffer = '';

    // 处理原始数据的函数
    const processRawData = (data: string) => {
      // 检测 Ctrl+C (ASCII 3)
      if (data.includes('\u0003')) {
        console.log('检测到 Ctrl+C 命令');
        // 将 Ctrl+C 信号直接传递给回调函数
        lineCallback('\u0003');
      }
  
      // 处理包含回车符的数据
      if (data.includes('\r')) {
        // 分割回车符
        const parts = data.split('\r');

        for (let i = 0; i < parts.length; i++) {
          if (i === 0 && parts[i].trim().length > 0) {
            // 第一部分追加到当前缓冲区
            currentBuffer += parts[i];

            // 如果只有一个部分且没有回车符结尾，则不处理
            if (parts.length === 1 && !data.endsWith('\r')) {
              continue;
            }

            // 传递当前行给回调
            lineCallback(currentBuffer);
          } else if (parts[i].trim().length > 0) {
            // 新行，直接处理
            lineCallback(parts[i]);
          }

          // 更新缓冲区
          currentBuffer = parts[i];
        }
      }
      // 处理常规换行数据
      else if (data.includes('\n')) {
        // 分割换行符
        const lines = data.split('\n');

        // 处理除最后一行外的所有行
        for (let i = 0; i < lines.length - 1; i++) {
          const line = currentBuffer + lines[i];
          if (line.trim().length > 0) {
            lineCallback(line);
          }
          currentBuffer = '';
        }

        // 最后一行可能是不完整的
        currentBuffer = lines[lines.length - 1];

        // 如果数据以换行符结束，则处理缓冲区并清空它
        if (data.endsWith('\n')) {
          if (currentBuffer.trim().length > 0) {
            lineCallback(currentBuffer);
          }
          currentBuffer = '';
        }
      }
      // 没有特殊字符的情况，追加到缓冲区
      else {
        currentBuffer += data;
      }
    };

    // 注册监听器
    const removeListener = window['terminal'].onStreamData(
      streamId,
      (rawData: string[], complete: boolean) => {
        // 处理每块原始数据
        rawData.forEach(data => processRawData(data));

        // 如果完成，处理任何剩余的缓冲区数据
        if (complete) {
          if (currentBuffer.trim().length > 0) {
            lineCallback(currentBuffer);
          }
          currentBuffer = '';

          if (completeCallback) {
            completeCallback();
          }
          // 清理监听器
          removeListener();
        }
      }
    );

    try {
      await window['terminal'].sendInput({ pid: this.currentPid, input: input + '\r' });

      // // 在固定时间后停止流（如果未正常结束）
      // setTimeout(() => {
      //   console.log('执行超时，停止流');
      //   window['terminal'].stopStream(this.currentPid, streamId);
      //   removeListener();
      //   if (completeCallback) completeCallback();
      // }, 600000); // 10分钟超时
    } catch (error) {
      // 出错时清理资源
      window['terminal'].stopStream(this.currentPid, streamId);
      removeListener();
      throw error;
    }
  }

  /**
 * 中断当前执行的命令
 */
  interrupt(): Promise<any> {
    if (!this.currentPid) {
      return Promise.reject('终端未初始化');
    }
    return window['terminal'].interrupt(this.currentPid);
  }

  /**
   * 强制终止指定进程
   * @param processName 可选，进程名称，如 'aily-arduino-cli.exe'
   */
  killProcess(processName?: string): Promise<any> {
    if (!this.currentPid) {
      return Promise.reject('终端未初始化');
    }
    return window['terminal'].killProcess(this.currentPid, processName);
  }
}
