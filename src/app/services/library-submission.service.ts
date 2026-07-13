import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { defer, Observable, throwError } from 'rxjs';
import { catchError, finalize, switchMap } from 'rxjs/operators';
import { API } from '../configs/api.config';
import {
  BlocklyLibraryPackageRef,
  BlocklyLibraryPackageService,
  BlocklyLibrarySubmissionBundle,
  BlocklyLibrarySubmissionPackage,
} from './blockly-library-package.service';
import { extractApiErrorDetails, ApiErrorDetails } from '../utils/api-error.utils';
import { CmdOutput, CmdService } from './cmd.service';
import { PlatformService } from './platform.service';

export interface LibrarySubmissionPayload {
  package: BlocklyLibrarySubmissionPackage;
  confirmExisting?: boolean;
  prDescription?: string;
}

export interface LibrarySubmissionResult {
  id: number;
  mode: 'create' | 'update' | string;
  package_name: string;
  package_slug: string;
  target_dir: string;
  branch: string;
  pr_url: string | null;
  pr_number: number | null;
  status: string;
}

export interface LibrarySubmissionResponse {
  status: number;
  data?: LibrarySubmissionResult;
  messages?: string | string[] | null;
  errorCode?: string | null;
  errorArgs?: Record<string, unknown>;
  errorMessage?: string | null;
}

export interface LibrarySubmissionApiError extends ApiErrorDetails {
  status?: number;
  raw: unknown;
  submission?: LibrarySubmissionResult;
  sameContent?: boolean;
  submittedByCurrentUser?: boolean;
  conflictType?: string;
}

interface PreparedSrcArchive {
  path: string;
  tempDir?: string;
}

@Injectable({
  providedIn: 'root',
})
export class LibrarySubmissionService {
  constructor(
    private http: HttpClient,
    private blocklyLibraryPackageService: BlocklyLibraryPackageService,
    private cmdService: CmdService,
    private platformService: PlatformService,
  ) { }

  submitLocalLibrary(projectPath: string, packageName: string, confirmExisting = false, packageJsonPatch?: Record<string, unknown>, prDescription = ''): Observable<LibrarySubmissionResponse> {
    const bundle = this.blocklyLibraryPackageService.readLibrarySubmissionPackage(projectPath, packageName);
    this.applyPackageJsonPatch(bundle, packageJsonPatch);
    return this.submitBundle(bundle, confirmExisting, prDescription);
  }

  submitLocalLibraryByRef(ref: BlocklyLibraryPackageRef, confirmExisting = false, packageJsonPatch?: Record<string, unknown>, prDescription = ''): Observable<LibrarySubmissionResponse> {
    const bundle = this.blocklyLibraryPackageService.readLibrarySubmissionPackageByRef(ref);
    this.applyPackageJsonPatch(bundle, packageJsonPatch);
    return this.submitBundle(bundle, confirmExisting, prDescription);
  }

  submitBundle(bundle: BlocklyLibrarySubmissionBundle, confirmExisting = false, prDescription = ''): Observable<LibrarySubmissionResponse> {
    const payload: LibrarySubmissionPayload = {
      package: bundle.package,
      prDescription: prDescription.trim(),
    };
    if (confirmExisting) {
      payload.confirmExisting = true;
    }
    return defer(() => this.prepareSrcArchive(bundle)).pipe(
      switchMap((srcArchive) => {
        if (srcArchive) {
          try {
            return this.submitMultipart(payload, srcArchive.path).pipe(
              finalize(() => this.cleanupPreparedArchive(srcArchive)),
            );
          } catch (error) {
            this.cleanupPreparedArchive(srcArchive);
            throw error;
          }
        }
        return this.submitJson(payload);
      }),
    );
  }

  submitJson(payload: LibrarySubmissionPayload): Observable<LibrarySubmissionResponse> {
    return this.http.post<LibrarySubmissionResponse>(API.librarySubmissions, payload).pipe(
      catchError(error => this.handleError(error)),
    );
  }

  submitMultipart(payload: LibrarySubmissionPayload, srcArchivePath: string): Observable<LibrarySubmissionResponse> {
    const fileBuffer = window['fs'].readFileSync(srcArchivePath, null);
    const file = new File([fileBuffer], 'src.7z', { type: 'application/x-7z-compressed' });
    const formData = new FormData();
    formData.append('payload', JSON.stringify(payload));
    formData.append('src_archive', file, 'src.7z');

    return this.http.post<LibrarySubmissionResponse>(API.librarySubmissions, formData).pipe(
      catchError(error => this.handleError(error)),
    );
  }

  private handleError(error: HttpErrorResponse | unknown): Observable<never> {
    const source = this.getApiErrorPayload(error);
    const details = extractApiErrorDetails(source, '库提交失败');
    const normalized: LibrarySubmissionApiError = {
      ...details,
      status: error instanceof HttpErrorResponse ? error.status : undefined,
      raw: error,
      submission: this.getSubmissionFromErrorPayload(source),
      sameContent: this.getSameContentFromErrorPayload(source),
      submittedByCurrentUser: this.getSubmittedByCurrentUserFromErrorPayload(source),
      conflictType: this.getConflictTypeFromErrorPayload(source),
    };
    return throwError(() => normalized);
  }

  private applyPackageJsonPatch(bundle: BlocklyLibrarySubmissionBundle, packageJsonPatch?: Record<string, unknown>): void {
    if (!packageJsonPatch || typeof packageJsonPatch !== 'object') {
      return;
    }

    bundle.package.packageJson = {
      ...bundle.package.packageJson,
      ...packageJsonPatch,
    };
  }

  private async prepareSrcArchive(bundle: BlocklyLibrarySubmissionBundle): Promise<PreparedSrcArchive | undefined> {
    if (bundle.srcArchivePath && this.isNonEmptyFile(bundle.srcArchivePath)) {
      return { path: bundle.srcArchivePath };
    }

    if (!bundle.srcArchiveOutputPath) {
      return undefined;
    }

    const sourceDir = bundle.srcDirectoryPath || window['path']?.join?.(window['path']?.dirname?.(bundle.srcArchiveOutputPath), 'src');
    if (!this.isNonEmptyDirectory(sourceDir)) {
      if (bundle.srcArchivePath) {
        throw new Error(`src.7z 文件为空，且未找到可打包的非空 src 目录: ${bundle.srcArchivePath}`);
      }
      return undefined;
    }

    const packagePath = window['path']?.dirname?.(sourceDir);
    if (!packagePath) {
      throw new Error(`无法定位库目录: ${sourceDir}`);
    }

    const tempDir = this.createTempArchiveDirectory();
    const tempArchivePath = window['path'].join(tempDir, 'src.7z');
    const command = `${this.platformService.za7} a -t7z -mx=9 "${tempArchivePath}" src`;
    const result = await this.cmdService.runAsync(command, packagePath, false);
    if (result.type === 'error' || result.code !== 0) {
      this.cleanupTempDirectory(tempDir);
      throw new Error(this.formatArchiveError('src.7z 打包失败', command, result));
    }

    if (!this.isNonEmptyFile(tempArchivePath)) {
      this.cleanupTempDirectory(tempDir);
      throw new Error(this.formatArchiveError(`src.7z 生成失败: ${tempArchivePath}`, command, result));
    }

    return {
      path: tempArchivePath,
      tempDir,
    };
  }

  private isNonEmptyDirectory(path: string): boolean {
    try {
      const stat = window['fs'].statSync(path);
      const isDirectory = stat?.isDirectory?.() === true || stat?._isDirectory === true;
      return isDirectory && (window['fs'].readDirSync(path) || []).length > 0;
    } catch {
      return false;
    }
  }

  private isNonEmptyFile(path: string): boolean {
    try {
      const stat = window['fs'].statSync(path);
      const isFile = stat?.isFile?.() === true || stat?._isFile === true;
      return isFile && Number(stat.size || 0) > 0;
    } catch {
      return false;
    }
  }

  private createTempArchiveDirectory(): string {
    const tempBase = (window as any)['os']?.tmpdir?.() || (window as any)['electronAPI']?.os?.tmpdir?.();
    if (!tempBase) {
      throw new Error('无法获取临时目录，不能打包 src.7z');
    }
    const tempDir = window['path'].join(tempBase, `aily_library_publish_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    window['fs'].mkdirSync(tempDir, { recursive: true });
    return tempDir;
  }

  private cleanupPreparedArchive(srcArchive: PreparedSrcArchive): void {
    if (!srcArchive.tempDir) {
      return;
    }
    this.cleanupTempDirectory(srcArchive.tempDir);
  }

  private cleanupTempDirectory(path: string): void {
    try {
      if (window['fs'].existsSync(path)) {
        window['fs'].rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // 临时文件清理失败不影响发布结果。
    }
  }

  private formatArchiveError(message: string, command: string, result: CmdOutput): string {
    const output = [
      result.error,
      result.stderr,
      result.stdout,
      result.data,
    ]
      .filter(Boolean)
      .join('\n')
      .trim();
    const exitCode = result.code === undefined ? 'unknown' : result.code;
    return output
      ? `${message} (exit code: ${exitCode})\n命令: ${command}\n输出: ${output}`
      : `${message} (exit code: ${exitCode})\n命令: ${command}`;
  }

  private getApiErrorPayload(error: HttpErrorResponse | unknown): unknown {
    if (!(error instanceof HttpErrorResponse)) {
      return error;
    }
    const body = error.error;
    if (body && typeof body === 'object' && !Array.isArray(body) && body['detail']) {
      return body['detail'];
    }
    return body ?? error;
  }

  private getSubmissionFromErrorPayload(source: unknown): LibrarySubmissionResult | undefined {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return undefined;
    }
    const submission = source['submission'];
    return submission && typeof submission === 'object' && !Array.isArray(submission)
      ? submission as LibrarySubmissionResult
      : undefined;
  }

  private getSameContentFromErrorPayload(source: unknown): boolean | undefined {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return undefined;
    }
    const value = source['same_content'] ?? source['sameContent'];
    return typeof value === 'boolean' ? value : undefined;
  }

  private getSubmittedByCurrentUserFromErrorPayload(source: unknown): boolean | undefined {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return undefined;
    }
    const value = source['submitted_by_current_user'] ?? source['submittedByCurrentUser'];
    return typeof value === 'boolean' ? value : undefined;
  }

  private getConflictTypeFromErrorPayload(source: unknown): string | undefined {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return undefined;
    }
    const value = source['conflict_type'] ?? source['conflictType'];
    return typeof value === 'string' ? value : undefined;
  }
}
