import { Component, inject } from '@angular/core';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import { FeedbackService } from '../../services/feedback.service';
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
export class FeedbackDialogComponent {
  readonly modal = inject(NzModalRef);

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
  }

  onCloseDialog(): void {
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
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
    const descriptionStr = this.feedbackContent
      ? this.feedbackContent.split('\n').map(line => `  ${line}`).join('\n')
      : "  null";

    return `**Issue Descriptions:**
\`\`\`plaintext
${descriptionStr}
\`\`\`
    `;
  }

  // 功能建议
  getFeatureSuggestion(): string {
    const descriptionStr = this.feedbackContent
      ? this.feedbackContent.split('\n').map(line => `  ${line}`).join('\n')
      : "  null";

    return `**Feature Suggestions**
\`\`\`plaintext
${descriptionStr}
\`\`\`
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

  openUrl() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly/issues');
  }
}
