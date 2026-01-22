
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, from } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { API } from '../../../configs/api.config';
import { CmdService, CmdOutput } from '../../../services/cmd.service';
import { PlatformService } from "../../../services/platform.service";

declare global {
  interface Window {
    fs: any;
    env: any;
    Buffer: any;
  }
}

declare const process: any;

@Injectable({
  providedIn: 'root'
})
export class CloudService {
  // 使用 getter 动态获取 URL，确保区域切换后能获取到最新的地址
  get baseUrl(): string { return API.cloudBase; }
  private get apiUrl() { return API.cloudSync; }
  private get cloudProjectsUrl() { return API.cloudProjects; }

  constructor(
      private http: HttpClient,
      private cmdService: CmdService,
      private platformService: PlatformService
  ) { }

  /** 
   * 获取公开列表
   */
  getPublicProjects(page, perPage, keyword, id='', board=''): Observable<any> {
    return this.http.get<any>(`${API.cloudPublicProjects}?page=${page}&perPage=${perPage}&keywords=${keyword}&id=${id}&board=${board}`)
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 同步（新建/更新）项目
   * @param params 同步参数
   * @param token 认证token
   */
  syncProject(params: {
    pid?: string;
    projectData?: any; // 新增的项目数据对象
    archive?: string;
  }): Observable<any> {
    const formData = new FormData();
    if (params.projectData) {
      formData.append('projectData', JSON.stringify(params.projectData));
    }
    if (params.pid) formData.append('pid', params.pid);
    if (params.archive) {
      // 读取二进制文件（不指定编码参数，返回原始Buffer）
      const fileBuffer = window['fs'].readFileSync(params.archive, null);
      const archiveName = window['path'].basename(params.archive);
      const file = new File([fileBuffer], archiveName, { type: 'application/x-7z-compressed' });
      formData.append('archive', file, archiveName);
    }

    // 打印FormData内容（用于调试）
    // console.log('FormData内容:');
    // for (const [key, value] of formData.entries()) {
    //   if (value instanceof File) {
    //     console.log(`${key}: File(${value.name}, ${value.size} bytes, ${value.type})`);
    //   } else {
    //     console.log(`${key}: ${value}`);
    //   }
    // }

    // 创建带有正确headers的请求
    const headers = new HttpHeaders({
      "mimeType": "multipart/form-data",
    });

    console.log('发送请求到:', this.apiUrl);
    return this.http.post<any>(this.apiUrl, formData, { headers })
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 获取当前用户所有云上项目列表
   * @param skip 跳过的项目数量（分页）
   * @param limit 返回的最大项目数量（分页）
   */
  getProjects(skip: number = 0, limit: number = 20): Observable<any> {
    const params = {
      page: skip.toString(),
      perPage: limit.toString()
    };

    return this.http.get<any>(this.cloudProjectsUrl, { params })
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 云上项目基础信息编辑接口
   * @param projectId 项目ID
   * @param params 编辑参数
   */
  updateProject(projectId: string, params: {
    nickname?: string;
    description?: string;
    doc_url?: string;
    tags?: string[];
    image?: File;
  }): Observable<any> {
    const formData = new FormData();
    if (params.nickname) formData.append('nickname', params.nickname);
    if (params.description) formData.append('description', params.description);
    if (params.doc_url) formData.append('doc_url', params.doc_url);
    if (params.tags) {
      formData.append('tags', JSON.stringify(params.tags));
    }
    if (params.image) {
      // 确保为image文件指定正确的文件名
      const fileName = params.image.name || 'image';
      formData.append('image', params.image, fileName);
    }

    // 创建带有正确headers的请求
    const headers = new HttpHeaders();
    // 注意：不要手动设置Content-Type，让浏览器自动设置multipart/form-data的boundary

    return this.http.put<any>(`${this.cloudProjectsUrl}/${projectId}`, formData, { headers })
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 获取项目.7z文件的接口
   * @param projectId 项目ID
   */
  downloadProject(projectId: string): Observable<Blob> {
    return this.http.get(`${this.cloudProjectsUrl}/${projectId}/download`, {
      responseType: 'blob'
    })
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 发布项目接口
   * @param projectId 项目ID
   */
  publishProject(projectId: string): Observable<any> {
    return this.http.post<any>(`${this.cloudProjectsUrl}/${projectId}/publish`, {})
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 取消发布项目接口
   * @param projectId 项目ID
   */
  unpublishProject(projectId: string): Observable<any> {
    return this.http.delete<any>(`${this.cloudProjectsUrl}/${projectId}/publish`)
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 删除项目接口
   * @param projectId 项目ID
   */
  deleteProject(projectId: string): Observable<any> {
    return this.http.delete<any>(`${this.cloudProjectsUrl}/${projectId}`)
      .pipe(
        catchError(this.handleError)
      );
  }

  /**
   * 获取项目归档文件并解压
   * @param archiveUrl 归档文件URL
   * @returns Observable<string> 解压后的路径
   */
  getProjectArchive(archiveUrl: string): Observable<string> {
    return this.http.get(archiveUrl, { responseType: 'blob' })
      .pipe(
        switchMap((blob: Blob) => {
          return from(this.downloadAndExtractArchive(blob));
        }),
        catchError(this.handleError)
      );
  }

  /**
   * 下载并解压归档文件
   * @param blob 文件blob数据
   * @returns Promise<string> 解压后的路径
   */
  private async downloadAndExtractArchive(blob: Blob): Promise<string> {
    let tempDir = '';
    try {
      // 检查 blob 大小和类型
      // console.log('Blob 信息:', {
      //   size: blob.size,
      //   type: blob.type
      // });
      
      if (blob.size === 0) {
        throw new Error('下载的文件为空');
      }
      
      // 创建临时目录
      tempDir = await this.createTempDirectory();
      
      // 保存文件到临时目录
      const archivePath = `${tempDir}/archive.7z`;
      await this.saveBlobToFile(blob, archivePath);
      
      // 验证文件是否正确保存
      if (!window['fs'].existsSync(archivePath)) {
        throw new Error('归档文件保存失败');
      }
      
      const fileStats = window['fs'].statSync(archivePath);
      // console.log('保存的文件信息:', {
      //   path: archivePath,
      //   size: fileStats.size,
      //   exists: true
      // });
      
      if (fileStats.size === 0) {
        throw new Error('保存的归档文件为空');
      }
      
      // 检查文件前几个字节，验证是否为有效的7z文件（读取为Buffer）
      // const fileBuffer = window['fs'].readFileSync(archivePath, null);
      // const magic = fileBuffer.slice(0, 6);
      // const is7zFile = magic[0] === 0x37 && magic[1] === 0x7A && 
      //                  magic[2] === 0xBC && magic[3] === 0xAF && 
      //                  magic[4] === 0x27 && magic[5] === 0x1C;
      
      // console.log('文件魔数检查:', {
      //   magic: Array.from(magic).map((b: number) => b.toString(16)).join(' '),
      //   is7zFile: is7zFile
      // });
      
      // if (!is7zFile) {
      //   // 尝试读取文件内容开头，看是否是错误响应
      //   const textContent = fileBuffer.slice(0, 200).toString('utf8');
      //   // console.log('文件内容开头:', textContent);
      //   throw new Error(`下载的文件不是有效的7z格式。文件内容: ${textContent.substring(0, 100)}`);
      // }
      
      // 创建解压目录
      const extractPath = `${tempDir}/extracted`;
      window['fs'].mkdirSync(extractPath);
      
      // 获取7za/7zz的完整路径
      const za7Path = await this.platformService.getZa7Path();
      
      // 使用7za/7zz解压文件（明确指定7z格式）
      let extractCmd = `"${za7Path}" x "${archivePath}" -o"${extractPath}" -t7z -y`;
      if (window['platform'].isWindows) {
        extractCmd = `& ${extractCmd}`; // PowerShell 语法
      }
      
      console.log('执行解压命令:', extractCmd);
      
      // 收集所有输出信息（包括 stdout 和 stderr）
      let allOutput = '';
      let allErrors = '';
      let exitCode: number | undefined;
      let hasError = false;
      
      try {
        const result = await new Promise<CmdOutput>((resolve, reject) => {
          const outputs: string[] = [];
          const errors: string[] = [];
          
          this.cmdService.run(extractCmd, undefined, false).subscribe({
            next: (output: CmdOutput) => {
              if (output.type === 'stdout' && output.data) {
                outputs.push(output.data);
                allOutput += output.data;
              } else if (output.type === 'stderr' && output.data) {
                errors.push(output.data);
                allErrors += output.data;
              } else if (output.type === 'error') {
                hasError = true;
                if (output.error) {
                  errors.push(output.error);
                  allErrors += output.error;
                }
              } else if (output.type === 'close') {
                exitCode = output.code;
                resolve(output);
              }
            },
            error: (err) => {
              hasError = true;
              reject(err);
            }
          });
        });
        
        // 检查解压结果
        if (hasError || (exitCode !== undefined && exitCode !== 0)) {
          const errorMsg = allErrors || allOutput || result.error || result.data || `退出码: ${exitCode}`;
          const errorDetails = JSON.stringify({
            type: result.type,
            code: exitCode,
            error: result.error,
            data: result.data,
            signal: result.signal,
            allOutput: allOutput.substring(0, 500), // 限制长度
            allErrors: allErrors.substring(0, 500)
          }, null, 2);
          console.error('解压命令执行失败:', errorDetails);
          throw new Error(`7za解压失败: ${errorMsg}`);
        }
      } catch (error: any) {
        const errorMsg = error.message || allErrors || allOutput || '未知错误';
        console.error('解压命令执行异常:', {
          error: error,
          allOutput: allOutput.substring(0, 500),
          allErrors: allErrors.substring(0, 500),
          exitCode
        });
        throw new Error(`7za解压失败: ${errorMsg}`);
      }
      
      // 验证解压目录是否存在文件
      if (!window['fs'].existsSync(extractPath)) {
        throw new Error('解压目录不存在');
      }
      
      const extractedFiles = window['fs'].readDirSync(extractPath);
      if (extractedFiles.length === 0) {
        throw new Error('解压后没有找到任何文件');
      }
      
      // console.log('解压成功，文件数量:', extractedFiles.length);

      // 删除.7z文件，节省空间
      try {
        window['fs'].unlinkSync(archivePath);
        // console.log('已删除临时归档文件:', archivePath);
      } catch (error) {
        console.warn('删除临时归档文件失败:', error);
      }
      return extractPath;
    } catch (error) {
      // 清理临时文件
      if (tempDir && window['fs'].existsSync(tempDir)) {
        try {
          this.cleanupTempDirectory(tempDir);
        } catch (cleanupError) {
          console.warn('清理临时文件失败:', cleanupError);
        }
      }
      throw new Error(`解压归档文件失败: ${error.message || error}`);
    }
  }

  /**
   * 创建临时目录
   * @returns Promise<string> 临时目录路径
   */
  private async createTempDirectory(): Promise<string> {
    const tempBase = await window['env'].get('TEMP') || await window['env'].get('TMP') || '/tmp';
    const tempDir = `${tempBase}/aily_cloud_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    window['fs'].mkdirSync(tempDir);
    return tempDir;
  }

  /**
   * 将Blob保存为文件
   * @param blob 文件blob数据
   * @param filePath 保存路径
   */
  private async saveBlobToFile(blob: Blob, filePath: string): Promise<void> {
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = window.Buffer ? window.Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer);
    window['fs'].writeFileSync(filePath, buffer);
  }

  /**
   * 清理临时目录
   * @param tempDir 临时目录路径
   */
  private cleanupTempDirectory(tempDir: string): void {
    try {
      if (window['fs'].existsSync(tempDir)) {
        // 递归删除目录及其内容
        const rmOptions = { recursive: true, force: true };
        window['fs'].rmSync(tempDir, rmOptions);
        console.log('临时目录已清理:', tempDir);
      }
    } catch (error) {
      console.warn('清理临时目录失败:', error);
    }
  }

  /**
   * 清理指定路径（用于外部调用）
   * @param extractPath 需要清理的路径
   */
  cleanupExtractedFiles(extractPath: string): void {
    if (extractPath && extractPath.includes('aily_cloud_')) {
      // 只清理我们创建的临时目录，确保安全
      const parentDir = extractPath.replace('/extracted', '');
      this.cleanupTempDirectory(parentDir);
    }
  }

  private handleError(error: any) {
    let errMsg = '';
    
    // 检查是否是 HttpErrorResponse
    if (error.error instanceof ErrorEvent) {
      errMsg = `客户端错误: ${error.error.message}`;
    } else if (error.status !== undefined || error.statusText !== undefined) {
      // 标准的 HttpErrorResponse
      console.error('HTTP错误详细信息:', {
        status: error.status,
        statusText: error.statusText,
        url: error.url,
        error: error.error,
        headers: error.headers
      });
      
      let errorDetail = '';
      if (error.error) {
        if (typeof error.error === 'string') {
          errorDetail = error.error;
        } else if (error.error.messages) {
          errorDetail = error.error.messages;
        } else if (error.error.message) {
          errorDetail = error.error.message;
        } else {
          errorDetail = JSON.stringify(error.error);
        }
      }
      
      // 针对文件上传的特殊错误处理
      if (error.status === 413) {
        errMsg = `文件过大: 请检查上传文件大小是否超过服务器限制`;
      } else if (error.status === 415) {
        errMsg = `不支持的文件类型: 请确保上传的是.7z格式的归档文件`;
      } else if (error.status === 400) {
        errMsg = `请求参数错误: ${errorDetail || '请检查文件格式和必要参数'}`;
      } else {
        const status = error.status || '未知状态码';
        const statusText = error.statusText || '未知状态';
        errMsg = `服务端错误: ${status} ${statusText}, ${errorDetail || error.message || '无详细错误信息'}`;
      }
    } else {
      // 非标准错误对象（可能是网络错误、CORS错误等）
      console.error('非标准HTTP错误:', error);
      if (error.message) {
        errMsg = `网络错误: ${error.message}`;
      } else if (typeof error === 'string') {
        errMsg = error;
      } else {
        errMsg = `未知错误: ${JSON.stringify(error)}`;
      }
    }
    
    console.error('处理后的错误信息:', errMsg);
    return throwError(() => errMsg);
  }
}
