import { Component, inject, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import { FeedbackService, ImageUploadResponse } from './feedback.service';
import { ElectronService, LogService } from '@core/platform/public-api';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { ProjectService } from '@domain/project/public-api';
import { SerialService } from '@domain/device/public-api';
import { AILY_LOCAL_LIBRARY_SOURCES_KEY } from '@domain/dependencies/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { AuthService } from '@core/auth/public-api';
import { isAilyBoardPackageName, isAilyLibraryPackageName } from '@shared/public-api';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import {
  FEEDBACK_CRASH_CONTEXT_MAX_BYTES,
  enforceDiagnosticTextBudget,
  extractLatestCrashDiagnostic,
  resolveAccountStatusCode,
  sanitizeDiagnosticText,
  selectRecentDiagnosticLogs,
  type CrashDiagnostic,
  type DiagnosticLogSelection,
  type DiagnosticTextBlock,
} from './feedback-diagnostics.utils';
import {
  readRecentProjectDiagnosticLogs,
  type ProjectDiagnosticLogReadResult,
  type ProjectUploadDiagnosticEvidence,
} from '../../utils/project-log.utils';

import packageJson from '../../../../package.json';

type UnknownRecord = Record<string, unknown>;

interface FeedbackResultSnapshot {
  result: UnknownRecord | null;
  time: string | null;
  occurredAt: number | null;
}

const SAFE_SERIAL_PORT_PATTERN = /^(?:COM\d+|\/dev\/tty(?:USB|ACM|S|AMA)\d+)$/i;
const SAFE_PROJECT_PARAMETER_KEYS = [
  'ArduinoRunsOn',
  'CDCOnBoot',
  'CPUFreq',
  'DebugLevel',
  'DFUOnBoot',
  'EraseFlash',
  'EventsRunOn',
  'FlashFreq',
  'FlashMode',
  'FlashSize',
  'LoopCore',
  'PartitionScheme',
  'PSRAM',
  'ThreadCore',
  'UploadMode',
  'UploadSpeed',
  'USBMode',
  'USBMSCOnBoot',
  'ZigbeeMode',
] as const;
const UPLOAD_LOG_CORRELATION_TOLERANCE_MS = 250;

@Component({
  selector: 'app-feedback-dialog',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzSelectModule,
    NzRadioModule,
    TranslateModule,
    BaseDialogComponent
  ],
  templateUrl: './feedback-dialog.component.html',
  styleUrl: './feedback-dialog.component.scss',
  providers: [FeedbackService]
})
export class FeedbackDialogComponent implements OnDestroy {
  readonly modal = inject(NzModalRef);
  readonly data: {
    feedbackType?: string;
    feedbackTitle?: string;
    feedbackContent?: string;
    feedbackLibraryName?: string;
  } | null = inject(NZ_MODAL_DATA, { optional: true });

  // textarea 元素引用
  @ViewChild('contentTextarea') contentTextarea!: ElementRef<HTMLTextAreaElement>;

  private readonly STORAGE_KEY = 'feedback_dialog_draft';

  // 标记是否已成功提交
  private isSubmitted: boolean = false;

  // 图片上传计数器，用于生成唯一占位符
  private uploadCounter: number = 0;

  private userInfoSubscription?: Subscription;

  // 反馈类型
  feedbackType: string = 'bug';

  get feedbackTypes() {
    return [
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_BUG'), value: 'bug' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_BUILD_UPLOAD'), value: 'build&upload' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_LIBRARY'), value: 'library' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_OTHER'), value: 'other' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_FEATURE'), value: 'feature' },
    ];
  }

  projectData = [

  ];

  // 表单数据
  feedbackTitle: string = '';
  feedbackContent: string = '';
  feedbackLibraryName: string = '';
  contactInfo: string = '';

  // 提交状态
  isSubmitting: boolean = false;

  // 拖拽状态
  isDragOver: boolean = false;

  email: string = '';

  // 配置对话框按钮
  get buttons(): DialogButton[] {
    return [
      // {
      //   text: this.translate.instant('FEEDBACK_DIALOG.CANCEL'),
      //   type: 'default',
      //   action: 'cancel'
      // },
      {
        text: 'FEEDBACK_DIALOG.SUBMIT',
        type: 'primary',
        action: 'submit'
      }
    ];
  }

  constructor(
    private message: NzMessageService,
    private feedbackService: FeedbackService,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private logService: LogService,
    private serialService: SerialService,
    private configService: ConfigService,
    private authService: AuthService,
    private translate: TranslateService
  ) { }

  get isCnRegion(): boolean {
    return this.configService.isCnRegion;
  }

  ngOnInit(): void {
    this.loadDraft();
    this.applyInitialData();
    this.clearUntouchedLegacyLibraryTemplate();
    this.applyUserEmail(this.authService.currentUser);
    this.userInfoSubscription = this.authService.userInfo$.subscribe(userInfo => {
      this.applyUserEmail(userInfo);
    });
  }

  ngOnDestroy(): void {
    this.userInfoSubscription?.unsubscribe();
    // 组件销毁时，如果未成功提交，则保存草稿
    if (!this.isSubmitted) {
      this.saveDraft();
    }
  }

  private applyUserEmail(userInfo: any): void {
    const userEmail = userInfo?.email?.trim();
    if (!this.email.trim() && userEmail) {
      this.email = userEmail;
    }
  }

  private applyInitialData(): void {
    if (!this.data) {
      return;
    }

    if (this.data.feedbackType) {
      this.feedbackType = this.data.feedbackType;
    }
    if (this.data.feedbackTitle) {
      this.feedbackTitle = this.data.feedbackTitle;
    }
    if (this.data.feedbackContent) {
      this.feedbackContent = this.data.feedbackContent;
    }
    if (this.data.feedbackLibraryName) {
      this.feedbackLibraryName = this.data.feedbackLibraryName;
    }
  }

  private clearUntouchedLegacyLibraryTemplate(): void {
    const content = this.feedbackContent.trim();
    if (!content) {
      return;
    }

    const parsedLibraryName = this.parseLibraryNameFromContent();
    if (!parsedLibraryName) {
      return;
    }
    const legacyTemplate = this.translate.instant('FEEDBACK_DIALOG.LIBRARY_ISSUE_CONTENT', {
      name: parsedLibraryName,
    }).trim();
    if (content === legacyTemplate) {
      this.feedbackContent = '';
    }
  }

  // 从 localStorage 加载草稿数据
  private loadDraft(): void {
    try {
      const draft = localStorage.getItem(this.STORAGE_KEY);
      if (draft) {
        const data = JSON.parse(draft);
        this.feedbackType = data.feedbackType || 'bug';
        this.feedbackTitle = data.feedbackTitle || '';
        this.feedbackContent = data.feedbackContent || '';
        this.contactInfo = data.contactInfo || '';
        this.email = data.email || '';
      }
    } catch (error) {
      console.warn('加载反馈草稿失败:', error);
    }
  }

  // 保存草稿数据到 localStorage
  private saveDraft(): void {
    try {
      const draft = {
        feedbackType: this.feedbackType,
        feedbackTitle: this.feedbackTitle,
        feedbackContent: this.feedbackContent,
        contactInfo: this.contactInfo,
        email: this.email
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(draft));
    } catch (error) {
      console.warn('保存反馈草稿失败:', error);
    }
  }

  // 清除草稿数据
  private clearDraft(): void {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
    } catch (error) {
      console.warn('清除反馈草稿失败:', error);
    }
  }

  onCloseDialog(): void {
    this.saveDraft();
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
      this.saveDraft();
      this.modal.close({ result: 'cancel' });
    } else if (action === 'submit') {
      this.submitFeedback();
    }
  }

  getBasicInfo(feedbackTime: string): string {
    let softwareVersion: string | null = String(packageJson.version || '').trim() || null;
    try {
      if (this.isCnRegion && softwareVersion !== null) {
        softwareVersion += '-cn';
      }
    } catch {
      softwareVersion = null;
    }

    let operatingSystem: unknown = null;
    try {
      operatingSystem = (window as any)?.platform?.type ?? null;
    } catch {
      operatingSystem = null;
    }

    let uiLanguage: unknown = null;
    try {
      uiLanguage = this.translate.currentLang || this.translate.defaultLang || 'en';
    } catch {
      uiLanguage = null;
    }

    let accountStatusCode: unknown = null;
    try {
      const authState = this.authService.getAuthInitializationState();
      accountStatusCode = resolveAccountStatusCode(
        authState,
        this.authService.isAuthenticated,
        authState === 'authenticated' ? this.authService.getAuthSnapshot()?.plan : null,
      );
    } catch {
      accountStatusCode = null;
    }

    return this.renderTable([
      ['Software Version', softwareVersion],
      ['OS', operatingSystem],
      ['UI Language', uiLanguage],
      ['Feedback Time', feedbackTime],
      ['Account Status Code', accountStatusCode],
    ]);
  }

  private async buildIssueContent(feedbackTime: string): Promise<string> {
    const sections = [
      '## Issue Description',
      this.feedbackContent.trim() || 'null',
      '## Environment',
      this.getBasicInfo(feedbackTime),
    ];

    const diagnostics = await this.buildDiagnostics(feedbackTime);
    if (diagnostics) {
      sections.push(diagnostics);
    }

    sections.push(
      '---',
      '> This issue was sent by the user using the built-in feedback function.',
    );
    return sections.join('\n\n');
  }

  private async buildDiagnostics(feedbackTime: string): Promise<string | null> {
    switch (this.feedbackType) {
      case 'bug':
        return this.buildBugDiagnostics(feedbackTime);
      case 'build&upload':
        return this.buildBuildUploadDiagnostics(feedbackTime);
      case 'library':
        return this.buildLibraryDiagnostics(feedbackTime);
      case 'other':
        return this.buildOtherDiagnostics(feedbackTime);
      case 'feature':
        return null;
      default:
        return this.buildOtherDiagnostics(feedbackTime);
    }
  }

  private async buildBugDiagnostics(feedbackTime: string): Promise<string> {
    const now = this.toTimestamp(feedbackTime) ?? Date.now();
    const projectPath = this.readCurrentProjectPath();
    const [projectPackage, crash] = await Promise.all([
      this.readProjectPackage(),
      this.readLatestCrashDiagnostic(),
    ]);
    const sensitivePaths = this.readSensitivePaths(projectPath, projectPackage);
    const recentErrors = this.selectLogs({
      now,
      withinMs: 30 * 60 * 1000,
      limit: 10,
      state: 'error',
    });

    const blocks = this.applyDiagnosticBudget([
      {
        key: 'recent-errors',
        kind: 'log',
        content: this.sanitizeBlock(recentErrors.content, sensitivePaths),
        occurredAt: recentErrors.latestTimestamp,
      },
      ...(crash ? [{
        key: 'crash-context',
        kind: 'log' as const,
        content: this.sanitizeBlock(crash.context, sensitivePaths, FEEDBACK_CRASH_CONTEXT_MAX_BYTES),
        occurredAt: crash.occurredAt,
      }] : []),
    ]);

    const sections = [
      '## Diagnostics',
      '### Project Summary',
      this.renderTable([
        ['Project Mode', this.readProjectMode(projectPackage, projectPath)],
        ['Board', this.readBoardName()],
        ['Direct Dependency Count', this.countDirectDependencies(projectPackage)],
      ]),
    ];

    if (crash) {
      sections.push(
        '### Crash Summary',
        this.renderTable([
          ['Exit Reason', crash.reason],
          ['Exit Code', crash.exitCode],
          ['Process State', crash.processState],
        ]),
      );
    }

    sections.push(
      '### Logs',
      this.renderDetails('Recent Errors', this.readBudgetedBlock(blocks, 'recent-errors')),
    );
    if (crash) {
      sections.push(this.renderDetails('Crash Context', this.readBudgetedBlock(blocks, 'crash-context')));
    }
    return sections.join('\n\n');
  }

  private async buildBuildUploadDiagnostics(feedbackTime: string): Promise<string> {
    const now = this.toTimestamp(feedbackTime) ?? Date.now();
    const projectPath = this.readCurrentProjectPath();
    const projectPackage = await this.readProjectPackage();
    const sensitivePaths = this.readSensitivePaths(projectPath, projectPackage);
    const [boardPackage, boardPackageVersion, projectLogs] = await Promise.all([
      this.readBoardPackageName(),
      this.readBoardPackageVersion(),
      this.readProjectDiagnosticLogs(projectPath, sensitivePaths),
    ]);
    const compileResult = this.readLastCompileResult(projectPackage);
    const uploadResult = this.readLastUploadResult(
      now,
      sensitivePaths,
      projectLogs.upload,
      projectLogs.uploadEvidence,
    );
    const libraries = this.readDirectLibraries(projectPackage);
    const parameters = this.readBuildUploadParameters(projectPackage);
    const lastResults = {
      'Last Compile Result': compileResult.result,
      'Last Compile Result Time': compileResult.time,
      'Last Upload Result': uploadResult.result,
      'Last Upload Result Time': uploadResult.time,
    };

    const blocks = this.applyDiagnosticBudget([
      {
        key: 'libraries',
        kind: 'result',
        content: this.sanitizeBlock(libraries === null ? null : JSON.stringify(libraries, null, 2), sensitivePaths),
      },
      {
        key: 'parameters',
        kind: 'result',
        content: this.sanitizeBlock(
          parameters === null ? null : JSON.stringify(parameters, null, 2),
          sensitivePaths,
        ),
      },
      {
        key: 'last-results',
        kind: 'result',
        content: this.sanitizeBlock(JSON.stringify(lastResults, null, 2), sensitivePaths),
        occurredAt: Math.max(
          compileResult.occurredAt ?? Number.NEGATIVE_INFINITY,
          uploadResult.occurredAt ?? Number.NEGATIVE_INFINITY,
        ),
      },
      {
        key: 'compile-log',
        kind: 'log',
        content: this.readAndSanitizeProjectLog(projectLogs.compile, sensitivePaths),
        occurredAt: this.readLatestLogTimestamp(projectLogs.compile.content),
      },
      {
        key: 'upload-log',
        kind: 'log',
        content: this.readAndSanitizeProjectLog(projectLogs.upload, sensitivePaths),
        occurredAt: this.readLatestLogTimestamp(projectLogs.upload.content),
      },
    ]);

    return [
      '## Diagnostics',
      '### Board and Port',
      this.renderTable([
        ['Board', this.readBoardName()],
        ['Board Package', boardPackage],
        ['Board Package Version', boardPackageVersion],
        ['Port', this.readSafeSerialPort()],
      ]),
      '### Libraries',
      this.renderCodeBlock('json', this.readBudgetedBlock(blocks, 'libraries')),
      '### Parameters',
      this.renderCodeBlock('json', this.readBudgetedBlock(blocks, 'parameters')),
      '### Last Results',
      this.renderCodeBlock('json', this.readBudgetedBlock(blocks, 'last-results')),
      '### Compile / Upload Logs',
      this.renderDetails('Compile Log', this.readBudgetedBlock(blocks, 'compile-log')),
      this.renderDetails('Upload Log', this.readBudgetedBlock(blocks, 'upload-log')),
    ].join('\n\n');
  }

  private async buildLibraryDiagnostics(feedbackTime: string): Promise<string> {
    const now = this.toTimestamp(feedbackTime) ?? Date.now();
    const projectPath = this.readCurrentProjectPath();
    const projectPackage = await this.readProjectPackage();
    const sensitivePaths = this.readSensitivePaths(projectPath, projectPackage);
    const libraryName = this.getFeedbackLibraryName();
    const relatedLogs = libraryName
      ? this.selectLogs({
        now,
        withinMs: 30 * 60 * 1000,
        limit: 10,
        query: libraryName,
      })
      : { content: null, latestTimestamp: null };
    const blocks = this.applyDiagnosticBudget([{
      key: 'related-logs',
      kind: 'log',
      content: this.sanitizeBlock(relatedLogs.content, sensitivePaths),
      occurredAt: relatedLogs.latestTimestamp,
    }]);

    return [
      '## Diagnostics',
      '### Library',
      this.renderTable([
        ['Name', libraryName || null],
        ['Version', this.readLibraryVersion(projectPackage, libraryName)],
        ['Source', this.readLibrarySource(projectPackage, libraryName)],
      ]),
      '### Related Logs',
      this.renderDetails('Related Logs', this.readBudgetedBlock(blocks, 'related-logs')),
    ].join('\n\n');
  }

  private async buildOtherDiagnostics(feedbackTime: string): Promise<string> {
    const now = this.toTimestamp(feedbackTime) ?? Date.now();
    const projectPath = this.readCurrentProjectPath();
    const projectPackage = await this.readProjectPackage();
    const latestError = this.selectLogs({
      now,
      withinMs: Number.MAX_SAFE_INTEGER,
      limit: 1,
      state: 'error',
    });
    const blocks = this.applyDiagnosticBudget([{
      key: 'latest-error',
      kind: 'error',
      content: this.sanitizeBlock(latestError.content, this.readSensitivePaths(projectPath, projectPackage)),
      occurredAt: latestError.latestTimestamp,
    }]);

    return [
      '## Diagnostics',
      '### Latest Error',
      this.renderCodeBlock('text', this.readBudgetedBlock(blocks, 'latest-error')),
    ].join('\n\n');
  }

  // 验证邮箱格式
  private isValidEmail(email: string): boolean {
    if (!email || email.trim() === '') {
      return true; // 邮箱是选填的,空值也是有效的
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  }

  // 提交反馈
  async submitFeedback(): Promise<void> {
    // 验证反馈内容
    if (!this.feedbackContent || this.feedbackContent.trim() === '') {
      this.message.warning(this.translate.instant('FEEDBACK_DIALOG.WARNING_CONTENT_EMPTY'));
      return;
    }

    if (!this.feedbackTitle || this.feedbackTitle.trim() === '') {
      this.message.warning(this.translate.instant('FEEDBACK_DIALOG.WARNING_TITLE_EMPTY'));
      return;
    }

    if (this.feedbackContent.trim().length < 10) {
      this.message.warning(this.translate.instant('FEEDBACK_DIALOG.WARNING_CONTENT_TOO_SHORT'));
      return;
    }

    // 验证邮箱格式
    if (!this.isValidEmail(this.email)) {
      this.message.warning(this.translate.instant('FEEDBACK_DIALOG.WARNING_INVALID_EMAIL'));
      return;
    }

    this.isSubmitting = true;
    const feedbackTime = new Date().toISOString();

    try {
      const content = await this.buildIssueContent(feedbackTime);
      // 构建反馈数据
      const feedbackData = {
        label: this.feedbackType,
        title: this.feedbackTitle.trim(),
        content,
        contact: this.contactInfo.trim(),
        timestamp: feedbackTime,
        email: this.email.trim()
      };

      this.feedbackService.submitFeedback(feedbackData).subscribe(res => {
        this.message.success(this.translate.instant('FEEDBACK_DIALOG.SUCCESS_MESSAGE'));
        this.isSubmitted = true;
        this.clearDraft();
        this.resetForm();
        this.modal.close({ result: 'success', data: feedbackData });
        this.isSubmitting = false;
      }, err => {
        console.warn('提交反馈失败:', err);
        this.message.error(this.translate.instant('FEEDBACK_DIALOG.ERROR_SUBMIT_FAILED'));
        this.isSubmitting = false;
      });
    } catch (error) {
      console.warn('提交反馈失败:', error);
      this.message.error(this.translate.instant('FEEDBACK_DIALOG.ERROR_SUBMIT_FAILED'));
      this.isSubmitting = false;
    }
  }

  private async readProjectPackage(): Promise<UnknownRecord | null> {
    try {
      return this.asRecord(await this.projectService.getPackageJson());
    } catch {
      return null;
    }
  }

  private readCurrentProjectPath(): string | null {
    try {
      const projectPath = this.projectService.currentProjectPath;
      return typeof projectPath === 'string' && projectPath.trim() ? projectPath.trim() : null;
    } catch {
      return null;
    }
  }

  private readProjectMode(projectPackage: UnknownRecord | null, projectPath: string | null): string | null {
    if (!projectPath || !projectPackage) {
      return null;
    }
    const configuredMode = this.readString(projectPackage['devmode'])?.toLowerCase();
    if (!configuredMode) {
      return 'arduino';
    }
    return ['arduino', 'micropython', 'python'].includes(configuredMode) ? configuredMode : null;
  }

  private readBoardName(): string | null {
    try {
      return this.readString(this.asRecord(this.projectService.currentBoardConfig)?.['name']);
    } catch {
      return null;
    }
  }

  private async readBoardPackageName(): Promise<string | null> {
    try {
      const packageName = this.readString(await this.projectService.getBoardModule());
      return packageName && (
        isAilyBoardPackageName(packageName)
        || packageName.startsWith('@aily-project/coder-')
      ) ? packageName : null;
    } catch {
      return null;
    }
  }

  private async readBoardPackageVersion(): Promise<string | null> {
    try {
      const boardPackage = this.asRecord(await this.projectService.getBoardPackageJson());
      return this.readDependencyVersion(boardPackage?.['version']);
    } catch {
      return null;
    }
  }

  private readSafeSerialPort(): string | null {
    try {
      const port = this.readString(this.serialService.currentPort);
      if (!port) {
        return null;
      }
      return SAFE_SERIAL_PORT_PATTERN.test(port) ? port : null;
    } catch {
      return null;
    }
  }

  private countDirectDependencies(projectPackage: UnknownRecord | null): number | null {
    const dependencies = this.readDependencyEntries(projectPackage);
    return dependencies ? dependencies.size : null;
  }

  private readDirectLibraries(projectPackage: UnknownRecord | null): Array<{ name: string; version: string | null }> | null {
    const dependencies = this.readDependencyEntries(projectPackage);
    if (!dependencies) {
      return null;
    }
    return [...dependencies.entries()]
      .filter(([name]) => isAilyLibraryPackageName(name))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => ({ name, version: this.readDependencyVersion(version) }));
  }

  private readLibraryVersion(projectPackage: UnknownRecord | null, libraryName: string): string | null {
    if (!libraryName) {
      return null;
    }
    return this.readDependencyVersion(this.readDependencyEntries(projectPackage)?.get(libraryName));
  }

  private readLibrarySource(projectPackage: UnknownRecord | null, libraryName: string): 'local' | 'registry' | null {
    if (!projectPackage || !libraryName) {
      return null;
    }
    const hasLocalSources = Object.prototype.hasOwnProperty.call(projectPackage, AILY_LOCAL_LIBRARY_SOURCES_KEY);
    const localSources = this.asRecord(projectPackage[AILY_LOCAL_LIBRARY_SOURCES_KEY]);
    if (hasLocalSources && !localSources) {
      return null;
    }
    if (localSources && Object.prototype.hasOwnProperty.call(localSources, libraryName)) {
      return 'local';
    }
    return this.readDependencyEntries(projectPackage)?.has(libraryName) ? 'registry' : null;
  }

  private readDependencyEntries(projectPackage: UnknownRecord | null): Map<string, unknown> | null {
    if (!projectPackage) {
      return null;
    }
    const entries = new Map<string, unknown>();
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (!Object.prototype.hasOwnProperty.call(projectPackage, key)) {
        continue;
      }
      const dependencyGroup = this.asRecord(projectPackage[key]);
      if (!dependencyGroup) {
        return null;
      }
      for (const [name, version] of Object.entries(dependencyGroup)) {
        if (name.trim()) {
          entries.set(name, version);
        }
      }
    }
    return entries;
  }

  private readBuildUploadParameters(projectPackage: UnknownRecord | null): UnknownRecord | null {
    if (!projectPackage) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(projectPackage, 'projectConfig')) {
      return {};
    }
    const projectConfig = this.asRecord(projectPackage['projectConfig']);
    if (!projectConfig) {
      return null;
    }
    const parameters: UnknownRecord = {};
    for (const key of SAFE_PROJECT_PARAMETER_KEYS) {
      const value = projectConfig?.[key];
      if (
        typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
        || (typeof value === 'string' && value.trim())
      ) {
        parameters[key] = typeof value === 'string' ? value.trim() : value;
      }
    }
    return parameters;
  }

  private readLastCompileResult(projectPackage: UnknownRecord | null): FeedbackResultSnapshot {
    const buildInfo = this.asRecord(projectPackage?.['buildInfo']);
    const status = this.readString(buildInfo?.['lastBuildStatus'])?.toLowerCase() || '';
    if (!['success', 'failed', 'cancelled'].includes(status)) {
      return { result: null, time: null, occurredAt: null };
    }

    const result: UnknownRecord = { status };
    const duration = buildInfo?.['lastBuildDuration'];
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      result['durationSeconds'] = duration;
    }
    const time = this.toIsoTimestamp(buildInfo?.['lastBuildTime']);
    return {
      result,
      time,
      occurredAt: this.toTimestamp(time),
    };
  }

  private readLastUploadResult(
    now: number,
    sensitivePaths: readonly string[],
    projectLog: ProjectDiagnosticLogReadResult,
    uploadEvidence?: ProjectUploadDiagnosticEvidence,
  ): FeedbackResultSnapshot {
    try {
      if (projectLog.status !== 'ok') {
        return { result: null, time: null, occurredAt: null };
      }
      const projectEntries = uploadEvidence
        ? (uploadEvidence.latestOtaEntry ? [uploadEvidence.latestOtaEntry] : [])
        : this.readProjectUploadLogEntries(projectLog.content || '');
      if (projectEntries.length === 0) {
        return { result: null, time: null, occurredAt: null };
      }
      const logs = Array.isArray(this.logService.list) ? this.logService.list : [];
      const terminalLogs = logs
        .map((entry) => {
          const timestamp = typeof entry?.timestamp === 'number' ? entry.timestamp : Number.NaN;
          const state = typeof entry?.state === 'string' ? entry.state.trim().toLowerCase() : '';
          const detail = typeof entry?.detail === 'string' ? entry.detail.trim() : '';
          return { timestamp, state, detail };
        })
        .filter((entry) => (
          Number.isFinite(entry.timestamp)
          && entry.timestamp <= now
          && /^(?:\[WiFi OTA\]|\[BLE OTA\])\s+/i.test(entry.detail)
          && ['done', 'warn', 'error'].includes(entry.state)
        ))
        .sort((left, right) => right.timestamp - left.timestamp);

      const correlated = terminalLogs
        .map((terminalLog) => {
          const summary = this.sanitizeBlock(terminalLog.detail, sensitivePaths);
          if (summary === null) {
            return null;
          }
          const projectEntry = projectEntries.find((entry) => (
            entry.detail === summary
            && Math.abs(entry.timestamp - terminalLog.timestamp) <= UPLOAD_LOG_CORRELATION_TOLERANCE_MS
          ));
          return projectEntry ? { terminalLog, projectEntry, summary } : null;
        })
        .find((entry): entry is NonNullable<typeof entry> => entry !== null);

      if (!correlated) {
        return { result: null, time: null, occurredAt: null };
      }
      const latestProjectTimestamp = uploadEvidence?.latestTimestamp
        ?? Math.max(...projectEntries.map((entry) => entry.timestamp));
      if (latestProjectTimestamp > correlated.projectEntry.timestamp + UPLOAD_LOG_CORRELATION_TOLERANCE_MS) {
        return { result: null, time: null, occurredAt: null };
      }
      const status = correlated.terminalLog.state === 'done'
        ? 'success'
        : correlated.terminalLog.state === 'warn'
          ? 'cancelled'
          : 'failed';
      return {
        result: { status, summary: correlated.summary },
        time: new Date(correlated.terminalLog.timestamp).toISOString(),
        occurredAt: correlated.terminalLog.timestamp,
      };
    } catch {
      return { result: null, time: null, occurredAt: null };
    }
  }

  private readProjectUploadLogEntries(content: string): Array<{ timestamp: number; detail: string }> {
    return content
      .split(/\r\n|\n|\r/)
      .map((line) => line.match(
        /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s+\[[^\]]+\]\s+\[upload\]\s+(.*)$/,
      ))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => ({
        timestamp: Date.parse(`${match[1]}T${match[2]}`),
        detail: match[3].trim(),
      }))
      .filter((entry) => Number.isFinite(entry.timestamp) && !!entry.detail);
  }

  private selectLogs(options: {
    now: number;
    withinMs: number;
    limit: number;
    state?: string;
    query?: string;
  }): DiagnosticLogSelection {
    try {
      return selectRecentDiagnosticLogs(this.logService.list, options);
    } catch {
      return { content: null, latestTimestamp: null };
    }
  }

  private async readLatestCrashDiagnostic(): Promise<CrashDiagnostic | null> {
    try {
      const pathApi = (window as any)?.path;
      const fsApi = (window as any)?.fs;
      if (
        !pathApi
        || typeof pathApi.getAppDataPath !== 'function'
        || typeof pathApi.join !== 'function'
        || !fsApi
        || typeof fsApi.existsSync !== 'function'
        || typeof fsApi.readTailLines !== 'function'
      ) {
        return null;
      }
      const appDataPath = this.readString(pathApi.getAppDataPath());
      if (!appDataPath) {
        return null;
      }
      const appLogPath = pathApi.join(appDataPath, 'logs', 'app.log');
      if (!fsApi.existsSync(appLogPath)) {
        return null;
      }
      const [processLines, contextLines] = await Promise.all([
        fsApi.readTailLines(appLogPath, {
          maxLines: 32 * 1024,
          filterPattern: '\\[ProcessHealth\\]\\[(?:RendererGone|ChildGone)\\]',
        }),
        fsApi.readTailLines(appLogPath, { maxLines: 401 }),
      ]);
      if (
        !Array.isArray(processLines)
        || processLines.some((line) => typeof line !== 'string')
        || !Array.isArray(contextLines)
        || contextLines.some((line) => typeof line !== 'string')
      ) {
        return null;
      }
      const latestCrash = extractLatestCrashDiagnostic(processLines, 0);
      if (!latestCrash) {
        return null;
      }
      if (contextLines.length > 400) {
        return latestCrash;
      }
      const userHome = this.readUserHome();
      const pathHints = [appDataPath];
      if (userHome) {
        pathHints.push(userHome);
      }
      const sanitizedContext = sanitizeDiagnosticText(
        contextLines.join('\n'),
        pathHints,
        undefined,
        userHome,
      );
      if (!sanitizedContext) {
        return latestCrash;
      }
      const contextualCrash = extractLatestCrashDiagnostic(sanitizedContext);
      return contextualCrash?.occurredAt === latestCrash.occurredAt
        && contextualCrash.reason === latestCrash.reason
        && contextualCrash.exitCode === latestCrash.exitCode
        ? contextualCrash
        : latestCrash;
    } catch {
      return null;
    }
  }

  private async readProjectDiagnosticLogs(
    projectPath: string | null,
    sensitivePaths: readonly string[],
  ): Promise<{
    compile: ProjectDiagnosticLogReadResult;
    upload: ProjectDiagnosticLogReadResult;
    uploadEvidence: ProjectUploadDiagnosticEvidence;
  }> {
    try {
      return await readRecentProjectDiagnosticLogs(
        projectPath || undefined,
        (content) => this.sanitizeBlock(content, sensitivePaths),
      );
    } catch {
      return {
        compile: { status: 'error', content: null, truncated: false },
        upload: { status: 'error', content: null, truncated: false },
        uploadEvidence: { latestTimestamp: null, latestOtaEntry: null },
      };
    }
  }

  private readAndSanitizeProjectLog(
    result: ProjectDiagnosticLogReadResult,
    sensitivePaths: readonly string[],
  ): string | null {
    if (result.status === 'none') {
      return 'none';
    }
    if (result.status !== 'ok') {
      return null;
    }
    return this.sanitizeBlock(result.content, sensitivePaths);
  }

  private sanitizeBlock(
    value: unknown,
    sensitivePaths: readonly string[],
    maxBytes?: number,
  ): string | null {
    const sanitized = sanitizeDiagnosticText(
      value,
      sensitivePaths,
      maxBytes,
      this.readUserHome(),
    );
    return sanitized?.trim() ? sanitized : null;
  }

  private applyDiagnosticBudget(blocks: readonly DiagnosticTextBlock[]): DiagnosticTextBlock[] {
    return enforceDiagnosticTextBudget(blocks);
  }

  private readBudgetedBlock(blocks: readonly DiagnosticTextBlock[], key: string): string | null {
    return blocks.find((block) => block.key === key)?.content ?? null;
  }

  private readSensitivePaths(
    projectPath: string | null,
    projectPackage: UnknownRecord | null = null,
  ): string[] {
    const paths = new Set<string>();
    if (projectPath) {
      paths.add(projectPath);
    }
    for (const key of ['name', 'nickname']) {
      const projectName = this.readString(projectPackage?.[key]);
      if (projectName) {
        paths.add(projectName);
      }
    }
    const localLibrarySources = this.asRecord(projectPackage?.[AILY_LOCAL_LIBRARY_SOURCES_KEY]);
    for (const sourcePath of Object.values(localLibrarySources || {})) {
      const normalizedSourcePath = this.readString(sourcePath);
      if (normalizedSourcePath) {
        paths.add(normalizedSourcePath);
      }
    }
    try {
      const appDataPath = this.readString((window as any)?.path?.getAppDataPath?.());
      if (appDataPath) {
        paths.add(appDataPath);
      }
    } catch {
      // Conventional user-directory masking still applies when runtime path hints are unavailable.
    }
    const userHome = this.readUserHome();
    if (userHome) {
      paths.add(userHome);
    }
    return [...paths];
  }

  private readUserHome(): string | null {
    try {
      const pathApi = (window as any)?.path;
      return typeof pathApi?.getUserHome === 'function'
        ? this.readString(pathApi.getUserHome())
        : null;
    } catch {
      return null;
    }
  }

  private renderTable(rows: ReadonlyArray<readonly [string, unknown]>): string {
    return [
      '| Field | Value |',
      '|---|---|',
      ...rows.map(([field, value]) => `| ${field} | ${this.renderTableValue(value, field === 'Port')} |`),
    ].join('\n');
  }

  private renderTableValue(value: unknown, allowSafeSerialPort = false): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return 'null';
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return 'null';
    }
    if (allowSafeSerialPort && typeof value === 'string' && SAFE_SERIAL_PORT_PATTERN.test(value)) {
      return value;
    }
    const sanitized = sanitizeDiagnosticText(String(value));
    if (!sanitized?.trim()) {
      return 'null';
    }
    return sanitized.replace(/\r\n|\n|\r/g, ' ').replace(/\|/g, '\\|').trim();
  }

  private renderCodeBlock(language: 'json' | 'text', content: string | null): string {
    const body = content === null ? 'null' : content;
    const longestBacktickRun = Math.max(
      0,
      ...(body.match(/`+/g) || []).map((match) => match.length),
    );
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
    return `${fence}${language}\n${body}\n${fence}`;
  }

  private renderDetails(summary: string, content: string | null): string {
    return [
      '<details>',
      `<summary>${summary}</summary>`,
      '',
      this.renderCodeBlock('text', content),
      '</details>',
    ].join('\n');
  }

  private readLatestLogTimestamp(content: string | null): number | null {
    if (!content) {
      return null;
    }
    let latest: number | null = null;
    const matches = content.matchAll(/\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z)?\]/g);
    for (const match of matches) {
      const timestamp = Date.parse(`${match[1]}T${match[2]}`);
      if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) {
        latest = timestamp;
      }
    }
    return latest;
  }

  private toIsoTimestamp(value: unknown): string | null {
    const timestamp = this.toTimestamp(value);
    return timestamp === null ? null : new Date(timestamp).toISOString();
  }

  private toTimestamp(value: unknown): number | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readDependencyVersion(value: unknown): string | null {
    const version = this.readString(value);
    return version
      && version.length <= 128
      && /^[0-9A-Za-z*<>=~^][0-9A-Za-z._+*<>=~^| -]*$/.test(version)
      ? version
      : null;
  }

  private asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as UnknownRecord
      : null;
  }

  private getFeedbackLibraryName(): string {
    const libraryName = this.feedbackLibraryName.trim();
    if (libraryName) {
      return libraryName;
    }

    const parsedName = this.parseLibraryNameFromContent();
    const placeholder = this.translate.instant('FEEDBACK_DIALOG.LIBRARY_NAME_PLACEHOLDER').trim();
    if (!parsedName || parsedName === placeholder) {
      return '';
    }

    return parsedName.replace(/^<(.+)>$/, '$1').trim();
  }

  private parseLibraryNameFromContent(): string {
    const marker = '__LIBRARY_NAME__';
    const template = this.translate.instant('FEEDBACK_DIALOG.LIBRARY_ISSUE_CONTENT', {
      name: marker,
    });
    const [prefix, suffix = ''] = template.split(marker);
    const content = this.feedbackContent.trim();
    if (!prefix || !content.startsWith(prefix)) {
      return '';
    }
    let parsedName = content.slice(prefix.length).trim();

    const suffixMarker = suffix
      .split(/\r\n|\n|\r/)
      .map(line => line.trim())
      .find(line => line.length > 0);
    if (suffixMarker) {
      const suffixIndex = parsedName.indexOf(suffixMarker);
      if (suffixIndex >= 0) {
        parsedName = parsedName.slice(0, suffixIndex).trim();
      }
    }

    return parsedName.split(/\r\n|\n|\r/)[0].trim();
  }

  private resetForm(): void {
    this.feedbackType = 'bug';
    this.feedbackTitle = '';
    this.feedbackContent = '';
    this.feedbackLibraryName = '';
    this.contactInfo = '';
    this.email = '';
    this.isDragOver = false;
  }

  /**
   * 处理拖拽经过事件
   * @param event 拖拽事件
   */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    
    // 检查是否包含图片文件
    if (event.dataTransfer?.types.includes('Files')) {
      this.isDragOver = true;
    }
  }

  /**
   * 处理拖拽离开事件
   * @param event 拖拽事件
   */
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  /**
   * 处理拖放事件
   * @param event 拖放事件
   */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // 遍历所有拖入的文件，处理图片文件
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        this.handleImageUpload(file);
      }
    }
  }

  /**
   * 处理文件选择事件
   * @param event 文件选择事件
   */
  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;

    // 遍历所有选择的文件，处理图片文件
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        this.handleImageUpload(file);
      }
    }

    // 清空 input 以便可以重复选择同一文件
    input.value = '';
  }

  /**
   * 处理粘贴事件，支持从剪贴板粘贴图片
   * @param event 粘贴事件
   */
  onPaste(event: ClipboardEvent): void {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          this.handleImageUpload(file);
        }
        return;
      }
    }
  }

  /**
   * 处理图片上传
   * @param file 图片文件
   */
  private handleImageUpload(file: File): void {
    const textarea = this.contentTextarea?.nativeElement;
    if (!textarea) return;

    // 生成唯一的占位符标识
    const uploadId = ++this.uploadCounter;
    const fileName = file.name || 'image.png';
    const placeholder = `![Uploading ${fileName}#${uploadId}...]()`;

    // 获取当前光标位置
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;

    // 在光标位置插入占位符
    const beforeText = this.feedbackContent.substring(0, startPos);
    const afterText = this.feedbackContent.substring(endPos);
    this.feedbackContent = beforeText + placeholder + afterText;

    // 显示上传中提示
    this.message.loading(this.translate.instant('FEEDBACK_DIALOG.IMAGE_UPLOADING'), { nzDuration: 0 });

    // 上传图片
    this.feedbackService.uploadImage(file).subscribe({
      next: (response: ImageUploadResponse) => {
        this.message.remove();
        if (response.status === 200 && response.data.url) {
          // 上传成功，替换占位符为真实的 Markdown 图片语法
          const imageMarkdown = `![${fileName}](${response.data.url})`;
          this.feedbackContent = this.feedbackContent.replace(placeholder, imageMarkdown);
          this.message.success(this.translate.instant('FEEDBACK_DIALOG.IMAGE_UPLOAD_SUCCESS'));
        } else {
          // 上传失败，移除占位符
          this.feedbackContent = this.feedbackContent.replace(placeholder, '');
          this.message.error(this.translate.instant('FEEDBACK_DIALOG.IMAGE_UPLOAD_FAILED'));
        }
      },
      error: (error) => {
        this.message.remove();
        console.warn('图片上传失败:', error);
        // 上传失败，移除占位符
        this.feedbackContent = this.feedbackContent.replace(placeholder, '');
        this.message.error(this.translate.instant('FEEDBACK_DIALOG.IMAGE_UPLOAD_FAILED'));
      }
    });
  }

  openUrl() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly/issues');
  }
}
