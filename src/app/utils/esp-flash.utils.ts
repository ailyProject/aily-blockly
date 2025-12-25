/**
 * ESP 烧录工具类
 * 提供 ESP32/ESP8266 烧录相关的通用功能
 */

/**
 * ESP32 烧录状态追踪
 */
export interface ESP32UploadState {
  currentRegion: number;
  totalRegions: number;
  detectedRegions: boolean;
  completedRegions: 0;
}

/**
 * 进度解析结果
 */
export interface ProgressResult {
  progress: number;
  message: string;
  completed: boolean;
}

/**
 * ESP32 烧录进度解析器
 */
export class ESP32ProgressParser {
  private state: ESP32UploadState = {
    currentRegion: 0,
    totalRegions: 0,
    detectedRegions: false,
    completedRegions: 0
  };
  
  private lastProgress = 0;

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      currentRegion: 0,
      totalRegions: 0,
      detectedRegions: false,
      completedRegions: 0
    };
    this.lastProgress = 0;
  }

  /**
   * 解析单行输出，提取进度信息
   * @param line 命令输出的一行
   * @returns 进度结果，如果无进度信息则返回 null
   */
  parseLine(line: string): ProgressResult | null {
    const trimmedLine = line.trim();
    if (!trimmedLine) return null;

    let completed = false;
    let progress = this.lastProgress;

    // 1. 检测擦除区域数量
    if (!this.state.detectedRegions && trimmedLine.includes('Flash will be erased from')) {
      this.state.totalRegions++;
    }

    // 2. 检测开始新区域
    if (trimmedLine.includes('Compressed') && trimmedLine.includes('bytes to')) {
      this.state.detectedRegions = true;
      this.state.currentRegion++;
    }

    // 3. 检测区域完成
    if (trimmedLine.includes('Hash of data verified')) {
      this.state.completedRegions++;
      completed = true;
      progress = 100;
    }

    // 4. 检测 Leaving 标志（烧录完成）
    if (trimmedLine.includes('Leaving...')) {
      completed = true;
      progress = 100;
    }

    // 5. ESP32 特定进度格式：Writing at 0x00010000... (50 %)
    const esp32Match = trimmedLine.match(/Writing\s+at\s+0x[0-9a-f]+\.\.\.\s+\((\d+)\s*%\)/i);
    if (esp32Match) {
      const regionProgress = parseInt(esp32Match[1], 10);
      
      // 计算整体进度
      if (this.state.totalRegions > 0) {
        const completedPortion = this.state.completedRegions / this.state.totalRegions * 100;
        const currentPortion = regionProgress / this.state.totalRegions;
        progress = Math.floor(completedPortion + currentPortion);
      } else {
        progress = regionProgress;
      }
      
      if (progress > this.lastProgress) {
        this.lastProgress = progress;
        return {
          progress,
          message: ` ${progress}%`,
          completed: false
        };
      }
    }

    // 6. 其他进度格式：Writing at 0x00010000 [===>    ] 50.5% 1024/2048 bytes...
    const progressMatch = trimmedLine.match(/Writing\s+at\s+0x[0-9a-f]+\s+\[[^\]]*\]\s+(\d+(?:\.\d+)?)%/i);
    if (progressMatch) {
      progress = Math.floor(parseFloat(progressMatch[1]));
      
      if (progress > this.lastProgress) {
        this.lastProgress = progress;
        return {
          progress,
          message: ` ${progress}%`,
          completed: false
        };
      }
    }

    // 如果检测到完成标志，返回完成状态
    if (completed) {
      return {
        progress: 100,
        message: '烧录完成',
        completed: true
      };
    }

    return null;
  }

  /**
   * 获取当前进度
   */
  getCurrentProgress(): number {
    return this.lastProgress;
  }
}

/**
 * 检查是否为真正的错误（排除 PowerShell 的无关错误）
 * @param line 命令输出的一行
 * @returns 是否为真正的错误
 */
export function isRealError(line: string): boolean {
  const lowerLine = line.toLowerCase();
  const trimmedLine = line.trim();

  // 必须包含 error 或 failed
  if (!lowerLine.includes('error') && !lowerLine.includes('failed')) {
    return false;
  }

  // 排除 PowerShell 的命令未找到错误（fnm 等工具的错误）
  if (lowerLine.includes('commandnotfoundexception') ||
      lowerLine.includes('categoryinfo') ||
      lowerLine.includes('fullyqualifiederrorid') ||
      trimmedLine.startsWith('+')) {
    return false;
  }

  // 只关注 esptool 相关的错误
  if (!trimmedLine.includes('esptool') &&
      !lowerLine.includes('could not open') &&
      !lowerLine.includes('no serial data received') &&
      !lowerLine.includes('failed to connect')) {
    return false;
  }

  return true;
}

/**
 * 检查是否为串口连接错误
 * @param line 命令输出的一行
 * @returns 是否为串口连接错误
 */
export function isSerialError(line: string): boolean {
  const lowerLine = line.toLowerCase();
  return lowerLine.includes('could not open') ||
         lowerLine.includes('no serial data received') ||
         lowerLine.includes('failed to connect') ||
         lowerLine.includes("can't open device");
}

/**
 * 处理命令输出缓冲区，按行分割
 * @param buffer 当前缓冲区内容
 * @param newData 新数据
 * @returns 完整的行数组和剩余的缓冲区
 */
export function processOutputBuffer(buffer: string, newData: string): { lines: string[], remainingBuffer: string } {
  if (newData.includes('\r\n') || newData.includes('\n') || newData.includes('\r')) {
    const lines = (buffer + newData).split(/\r\n|\n|\r/);
    const remainingBuffer = lines.pop() || '';
    return { lines, remainingBuffer };
  } else {
    return { lines: [], remainingBuffer: buffer + newData };
  }
}
