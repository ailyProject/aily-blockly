import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import SparkMD5 from 'spark-md5';
import { CmdService, CmdOutput } from './cmd.service';

import { API } from '../configs/api.config';

/**
 * 固件类型
 */
export enum FirmwareType {
  VISION = 'sscma_xiao_ai_s3',    // Vision 固件
  AUDIO = 'xiao_audio',            // Audio 固件
  VIBRATION = 'xiao_vibrate'       // Vibration 固件
}

/**
 * XIAO 设备类型
 */
export enum XiaoType {
  VISION = 0,      // Vision
  VIBRATION = 1,   // Vibration
  AUDIO = 2        // Audio
}

/**
 * 固件信息接口
 */
export interface FirmwareInfo {
  fwv: string;           // 固件版本
  filename: string;      // 文件名
  file_url: string;      // 文件下载地址
  resource_url: string;  // 资源配置地址
  [key: string]: any;
  url: string;        // 直接下载地址
}

/**
 * 固件响应接口
 */
export interface FirmwareResponse {
  code: number;
  data: {
    resource_url: string;
    [key: string]: any;
  };
}

/**
 * 烧录文件项
 */
export interface FlashFile {
  data: string;     // 文件数据（二进制字符串）
  address: number;  // 烧录地址
}

/**
 * 模型文件快照
 */
export interface ModelSnapshot {
  model_id: string;
  version: string;
  arguments: {
    url: string;
    [key: string]: any;
  };
  checksum?: string;
  model_format: string;
  ai_framwork: string;
  [key: string]: any;
}

/**
 * 模型详情接口
 */
export interface ModelDetailInfo {
  name: string;
  author_name: string;
  labels: Array<{ object_name: string }>;
  [key: string]: any;
}

/**
 * 固件服务
 */
@Injectable({
  providedIn: 'root'
})
export class FirmwareService {
  // API 地址配置
  private readonly portalApiUrl = 'https://sensecap.seeed.cc';  // 修正为 sensecap
  private readonly sensecraftApiUrl = 'https://sensecraft.seeed.cc/aiserverapi';

  constructor(
    private http: HttpClient,
    private cmdService: CmdService
  ) { }

  /**
   * 获取固件信息
   * @param firmwareType 固件类型
   * @param version 固件版本，null 表示获取最新版本
   * @returns Promise<FirmwareInfo | null>
   */
  async getFirmwareInfo(firmwareType: FirmwareType, version: string | null = null): Promise<FirmwareInfo | null> {
    try {
      // 使用正确的固件下载地址
      // const url = 'https://sensecap.seeed.cc/directapi/hardware/get_new_version';
      const url = API.firmwareInfo;
      const params: any = {
        firmwareType: firmwareType,
        version: version || '',
        appid: '131'
      };

      const response = await firstValueFrom(
        this.http.get<any>(url, { params })
      );

      // console.log('固件信息响应:', response);

      if (response.status !== 200 && response.status !== '200') {
        return null;
      }

      // 直接使用返回的数据，API 已经包含了完整的信息
      const firmwareData = response.data;

      // 确保有固件版本信息
      if (!firmwareData.fwv && firmwareData.version) {
        firmwareData.fwv = firmwareData.version;
      }

      // 构建文件下载地址
      if (firmwareData.resource_url) {
        // 处理 HTTPS 协议
        let resourceUrl = firmwareData.resource_url;
        if (window.location.protocol === 'https:' && resourceUrl.startsWith('http:')) {
          resourceUrl = resourceUrl.replace('http:', 'https:');
        }

        // 如果有 resource_url，尝试获取详细信息
        try {
          const detailResponse = await fetch(`${resourceUrl}?timestamp=${Date.now()}`);
          const detailData = await detailResponse.json();
          
          if (detailData.filename) {
            const urlArr = resourceUrl.split('/');
            urlArr.pop();
            const fileUrl = urlArr.join('/').replace(':/', '://');
            firmwareData.file_url = `${fileUrl}/${detailData.filename}`;
            firmwareData.filename = detailData.filename;
          }
        } catch (error) {
          console.warn('获取固件详细信息失败，使用基础信息:', error);
        }
      }

      // 如果没有 file_url，尝试从其他字段构建
      if (!firmwareData.file_url && firmwareData.url) {
        firmwareData.file_url = firmwareData.url;
      }

      // console.log('固件信息获取成功:', firmwareData);
      return firmwareData;
    } catch (error) {
      console.error('获取固件信息失败:', error);
      return null;
    }
  }

  /**
   * 下载固件文件（原方法，使用 fetch）
   * @param firmwareInfo 固件信息
   * @param deviceType 设备类型（32 表示 XIAO 设备）
   * @returns Promise<FlashFile[]>
   */
  async downloadFirmware(firmwareInfo: FirmwareInfo, deviceType: number = 32): Promise<FlashFile[]> {
    try {
      // const response = await fetch(`${firmwareInfo.file_url}?timestamp=${Date.now()}`);
      const response = await fetch(API.downloadFirmware + '?file_url=' + firmwareInfo.url);
      const blob = await response.blob();

      // XIAO 设备使用二进制字符串格式
      const data = await this.readFileAsBinaryString(blob);

      return [{
        data,
        address: 0  // 固件从 0x0 地址开始烧录
      }];
    } catch (error) {
      console.error('下载固件失败:', error);
      throw error;
    }
  }

  /**
   * 使用 PowerShell 脚本下载固件（支持中断）
   * @param firmwareInfo 固件信息
   * @param progressCallback 进度回调函数
   * @param deviceType 设备类型（32 表示 XIAO 设备）
   * @returns Promise<{ flashFiles: FlashFile[], streamId: string }>
   */
  async downloadFirmwareWithScript(
    firmwareInfo: FirmwareInfo,
    progressCallback?: (progress: number, status: string) => void,
    deviceType: number = 32
  ): Promise<{ flashFiles: FlashFile[], streamId: string }> {
    return new Promise((resolve, reject) => {
      try {
        // 生成临时文件路径
        const tempDir = window['path'].join(window['os'].tmpdir(), 'aily-firmware');
        if (!window['fs'].existsSync(tempDir)) {
          window['fs'].mkdirSync(tempDir, { recursive: true });
        }
        
        const fileName = firmwareInfo.filename || 'firmware.bin';
        const outputPath = window['path'].join(tempDir, fileName);
        
        // 如果文件已存在，先删除
        if (window['fs'].existsSync(outputPath)) {
          window['fs'].unlinkSync(outputPath);
        }
        
        // 构建 PowerShell 脚本路径
        const scriptPath = window['path'].join(process.cwd(), 'tools', 'download-firmware.ps1');
        
        // 检查脚本是否存在
        if (!window['fs'].existsSync(scriptPath)) {
          reject(new Error(`下载脚本不存在: ${scriptPath}`));
          return;
        }
        
        // 构建命令
        const command = `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}" -Url "${firmwareInfo.file_url}" -OutputPath "${outputPath}"`;
        
        // console.log('执行下载命令:', command);
        
        let streamId = '';
        let lastProgress = 0;
        
        // 执行命令
        this.cmdService.run(command, undefined, false).subscribe({
          next: (output: CmdOutput) => {
            streamId = output.streamId;
            
            if (output.data) {
              const line = output.data.trim();
              
              // 解析进度
              const progressMatch = line.match(/进度:\s*(\d+)%/);
              if (progressMatch) {
                const progress = parseInt(progressMatch[1], 10);
                if (progress !== lastProgress) {
                  lastProgress = progress;
                  if (progressCallback) {
                    progressCallback(progress, `正在下载固件: ${progress}%`);
                  }
                }
              }
              
              // 检查成功
              if (line.includes('SUCCESS')) {
                // console.log('固件下载成功:', outputPath);
              }
              
              // 检查错误
              if (line.startsWith('ERROR:')) {
                const errorMsg = line.substring(6).trim();
                console.error('下载错误:', errorMsg);
              }
            }
          },
          error: (error) => {
            console.error('下载命令执行失败:', error);
            reject(error);
          },
          complete: async () => {
            try {
              // 验证文件是否存在
              if (!window['fs'].existsSync(outputPath)) {
                reject(new Error('下载失败，文件不存在'));
                return;
              }
              
              // 读取文件为二进制字符串
              const fileBuffer = window['fs'].readFileSync(outputPath);
              const blob = new Blob([fileBuffer]);
              const data = await this.readFileAsBinaryString(blob);
              
              const flashFiles: FlashFile[] = [{
                data,
                address: 0  // 固件从 0x0 地址开始烧录
              }];
              
              // 清理临时文件
              try {
                window['fs'].unlinkSync(outputPath);
              } catch (e) {
                console.warn('清理临时文件失败:', e);
              }
              
              resolve({ flashFiles, streamId });
            } catch (error) {
              reject(error);
            }
          }
        });
      } catch (error) {
        console.error('下载固件异常:', error);
        reject(error);
      }
    });
  }

  /**
   * 使用 PowerShell 脚本下载模型文件（支持中断）
   * @param modelSnapshot 模型快照
   * @param xiaoType XIAO 设备类型
   * @param progressCallback 进度回调函数
   * @returns Promise<{ flashFile: FlashFile, streamId: string }>
   */
  async downloadModelFileWithScript(
    modelSnapshot: ModelSnapshot,
    xiaoType: XiaoType,
    progressCallback?: (progress: number, status: string) => void
  ): Promise<{ flashFile: FlashFile, streamId: string }> {
    return new Promise((resolve, reject) => {
      try {
        const downloadUrl = modelSnapshot.arguments.url;
        
        // 生成临时文件路径
        const tempDir = window['path'].join(window['os'].tmpdir(), 'aily-models');
        if (!window['fs'].existsSync(tempDir)) {
          window['fs'].mkdirSync(tempDir, { recursive: true });
        }
        
        const fileName = `model_${modelSnapshot.model_id}.bin`;
        const outputPath = window['path'].join(tempDir, fileName);
        
        // 如果文件已存在，先删除
        if (window['fs'].existsSync(outputPath)) {
          window['fs'].unlinkSync(outputPath);
        }
        
        // 构建 PowerShell 脚本路径
        const scriptPath = window['path'].join(process.cwd(), 'tools', 'download-firmware.ps1');
        
        // 检查脚本是否存在
        if (!window['fs'].existsSync(scriptPath)) {
          reject(new Error(`下载脚本不存在: ${scriptPath}`));
          return;
        }
        
        // 构建命令
        const command = `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}" -Url "${downloadUrl}" -OutputPath "${outputPath}"`;
        
        // console.log('执行模型下载命令:', command);
        
        let streamId = '';
        let lastProgress = 0;
        
        // 执行命令
        this.cmdService.run(command, undefined, false).subscribe({
          next: (output: CmdOutput) => {
            streamId = output.streamId;
            
            if (output.data) {
              const line = output.data.trim();
              
              // 解析进度
              const progressMatch = line.match(/进度:\s*(\d+)%/);
              if (progressMatch) {
                const progress = parseInt(progressMatch[1], 10);
                if (progress !== lastProgress) {
                  lastProgress = progress;
                  if (progressCallback) {
                    progressCallback(progress, `正在下载模型: ${progress}%`);
                  }
                }
              }
              
              // 检查成功
              if (line.includes('SUCCESS')) {
                // console.log('模型下载成功:', outputPath);
              }
              
              // 检查错误
              if (line.startsWith('ERROR:')) {
                const errorMsg = line.substring(6).trim();
                console.error('下载错误:', errorMsg);
              }
            }
          },
          error: (error) => {
            console.error('下载命令执行失败:', error);
            reject(error);
          },
          complete: async () => {
            try {
              // 验证文件是否存在
              if (!window['fs'].existsSync(outputPath)) {
                reject(new Error('下载失败，文件不存在'));
                return;
              }
              
              // 读取文件为二进制字符串
              const fileBuffer = window['fs'].readFileSync(outputPath);
              const blob = new Blob([fileBuffer]);
              const data = await this.readFileAsBinaryString(blob);
              
              // 确定模型烧录地址
              const address = this.getModelAddress(xiaoType);
              
              const flashFile: FlashFile = {
                data,
                address
              };
              
              // 清理临时文件
              try {
                window['fs'].unlinkSync(outputPath);
              } catch (e) {
                console.warn('清理临时文件失败:', e);
              }
              
              resolve({ flashFile, streamId });
            } catch (error) {
              reject(error);
            }
          }
        });
      } catch (error) {
        console.error('下载模型异常:', error);
        reject(error);
      }
    });
  }

  /**
   * 获取模型文件
   * @param modelId 模型ID
   * @returns Promise<{ snapshot: ModelSnapshot, detail: ModelDetailInfo } | null>
   */
  async getModelFile(modelId: string): Promise<{ snapshot: ModelSnapshot, detail: ModelDetailInfo } | null> {
    try {
      // 1. 获取模型详情
      // const detailUrl = `${this.sensecraftApiUrl}/model/view_model`;
      const detailUrl = API.modelDetails;
      const detailResponse = await firstValueFrom(
        this.http.get<any>(detailUrl, { params: { model_id: modelId } })
      );

      if (detailResponse.status !== 200 && detailResponse.data !== '200') {
        console.error('获取模型详情失败:', detailResponse);
        return null;
      }

      // 直接根据 detailResponse.data 构建 ModelSnapshot（兼容不同 API 返回格式）
      const d = detailResponse.data || detailResponse;
      const snapshot: ModelSnapshot = {
        model_id: d.model_id || d.id || modelId,
        version: d.version || d.v || '',
        arguments: {
          url: d.file_url || d.url || '',
          icon: d.pic_url || d.icon || ''
        },
        checksum: d.checksum || d.md5 || undefined,
        model_format: d.model_format || d.format || '',
        ai_framwork: d.ai_framwork || d.ai_framework || ''
      } as any;

      return {
        snapshot,
        detail: detailResponse.data
      };
    } catch (error) {
      console.error('获取模型文件失败:', error);
      return null;
    }
  }

  /**
   * 下载模型文件
   * @param modelSnapshot 模型文件快照
   * @param xiaoType XIAO 设备类型
   * @returns Promise<FlashFile>
   */
  async downloadModelFile(modelSnapshot: ModelSnapshot, xiaoType: XiaoType): Promise<FlashFile> {
    try {
      const downloadUrl = modelSnapshot.arguments.url;

      // const response = await fetch(`${downloadUrl}?timestamp=${Date.now()}`);
      const response = await fetch(downloadUrl);
      const blob = await response.blob();

      // 读取为二进制字符串
      const data = await this.readFileAsBinaryString(blob);

      // 计算 MD5 校验和
      const checksum = await this.calculateMD5(blob);

      // 确定模型烧录地址
      const address = this.getModelAddress(xiaoType);

      return {
        data,
        address
      };
    } catch (error) {
      console.error('下载模型文件失败:', error);
      throw error;
    }
  }

  /**
   * 获取模型烧录地址
   * @param xiaoType XIAO 设备类型
   * @returns 烧录地址
   */
  getModelAddress(xiaoType: XiaoType): number {
    // Audio 模型地址为 0x500000，其他为 0x400000
    return xiaoType === XiaoType.AUDIO ? 0x500000 : 0x400000;
  }

  /**
   * 读取文件为二进制字符串
   * @param blob 文件 Blob
   * @returns Promise<string>
   */
  private readFileAsBinaryString(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsBinaryString(blob);
    });
  }

  /**
   * 计算文件 MD5
   * @param blob 文件 Blob
   * @returns Promise<string>
   */
  private calculateMD5(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const spark = new SparkMD5.ArrayBuffer();
        spark.append(arrayBuffer);
        const md5 = spark.end();
        resolve(md5);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }

  /**
   * 检查是否需要更新固件
   * @param currentVersion 当前版本
   * @param latestVersion 最新版本
   * @returns boolean
   */
  needFirmwareUpdate(currentVersion: string | undefined, latestVersion: string): boolean {
    if (!currentVersion) return true;
    return currentVersion !== latestVersion;
  }
}
