import { Component, inject, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import { FeedbackService, ImageUploadResponse } from '../../services/feedback.service';
import { ElectronService } from '../../services/electron.service';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { ProjectService } from '../../services/project.service';
import { LogService } from '../../services/log.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import { version } from '../../../../package.json';

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
  styleUrl: './feedback-dialog.component.scss'
})
export class FeedbackDialogComponent implements OnDestroy {
  readonly modal = inject(NzModalRef);

  // textarea 元素引用
  @ViewChild('contentTextarea') contentTextarea!: ElementRef<HTMLTextAreaElement>;

  private readonly STORAGE_KEY = 'feedback_dialog_draft';

  // 标记是否已成功提交
  private isSubmitted: boolean = false;

  // 图片上传计数器，用于生成唯一占位符
  private uploadCounter: number = 0;

  // 反馈类型
  feedbackType: string = 'bug';

  get feedbackTypes() {
    return [
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_BUG'), value: 'bug' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_BUILD_UPLOAD'), value: 'build&upload' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_OTHER'), value: 'other' },
      { label: this.translate.instant('FEEDBACK_DIALOG.TYPE_FEATURE'), value: 'feature' },
    ];
  }

  projectData = [

  ];

  // 表单数据
  feedbackTitle: string = '';
  feedbackContent: string = '';
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
    private translate: TranslateService
  ) { }

  ngOnInit(): void {
    this.loadDraft();
  }

  ngOnDestroy(): void {
    // 组件销毁时，如果未成功提交，则保存草稿
    if (!this.isSubmitted) {
      this.saveDraft();
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

  // 获取基本信息
  async getBasicInfo(): Promise<string> {
    const currentPackageJson = await this.projectService.getPackageJson();
    const dependencies = currentPackageJson?.dependencies || {};

    // 如果有依赖项,添加缩进使其在代码块中正确显示
    const dependenciesStr = dependencies && Object.keys(dependencies).length > 0
      ? JSON.stringify(dependencies, null, 2).split('\n').map(line => `  ${line}`).join('\n')
      : `  ${this.translate.instant('FEEDBACK_DIALOG.NO_DEPENDENCIES')}`;

    return `
- OS Version: ${window['platform'].type}
- Software Version: ${version}
- Project Dependencies:
\`\`\`json
${dependenciesStr}
\`\`\`
    `;
  }

  // 获取错误日志
  getErrorLogs(): string {
    // 获取最近十条错误日志
    const errorLogs = this.logService.list
      .filter(log => log.state === 'error')
      .sort((a, b) => b.timestamp! - a.timestamp!)
      .slice(0, 20);

    const errorLogsStr = errorLogs.length > 0
      ? errorLogs.map(log => `  - [${log.timestamp}] ${log.detail}`).join('\n')
      : "  null";

    return `- Error Logs:
\`\`\`plaintext
${errorLogsStr}
\`\`\`
    `;
  }

  // 问题描述
  getIssueDescription(): string {
    const descriptionStr = this.feedbackContent?.trim() || 'null';

    return `**Issue Descriptions:**

${descriptionStr}
    `;
  }

  // 功能建议
  getFeatureSuggestion(): string {
    const descriptionStr = this.feedbackContent?.trim() || 'null';

    return `**Feature Suggestions:**

${descriptionStr}
    `;
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

    let basicInfo = '';
    let errorLogs = '';
    let content = '';

    if (this.feedbackType != 'feature') {
      // 获取基本信息
      basicInfo = await this.getBasicInfo();
      // 获取错误日志
      errorLogs = this.getErrorLogs();

      // 获取问题描述
      const issueDescription = this.getIssueDescription();
      content = issueDescription + '\n' + basicInfo + '\n' + errorLogs;
    } else {
      // 获取功能建议内容
      const featureSuggestion = this.getFeatureSuggestion();
      content = featureSuggestion;
    }

    try {
      // 构建反馈数据
      const feedbackData = {
        label: this.feedbackType,
        title: this.feedbackTitle.trim(),
        content: content + `\n> This issue was sent by the user using the built-in feedback function.`,
        contact: this.contactInfo.trim(),
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        email: this.email.trim()
      };

      this.feedbackService.submitFeedback(feedbackData).subscribe(res => {
        this.message.success(this.translate.instant('FEEDBACK_DIALOG.SUCCESS_MESSAGE'));
        this.isSubmitted = true;
        this.clearDraft();
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
