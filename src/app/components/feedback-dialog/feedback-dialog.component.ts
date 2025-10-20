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

@Component({
  selector: 'app-feedback-dialog',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzSelectModule,
    BaseDialogComponent
  ],
  templateUrl: './feedback-dialog.component.html',
  styleUrl: './feedback-dialog.component.scss'
})
export class FeedbackDialogComponent {
  readonly modal = inject(NzModalRef);

  title = '反馈';

  // 反馈类型
  feedbackType: string = 'bug';

  feedbackTarget = [
    { label: '软件问题', value: 'bug' },
    { label: '库问题', value: 'feature' },
    { label: '开发板问题', value: 'question' },
    { label: '其他', value: 'other' }
  ];

  feedbackTypes = [
    { label: 'Bug 反馈', value: 'bug' },
    { label: '功能建议', value: 'feature' },
    { label: '使用问题', value: 'question' },
    { label: '其他', value: 'other' }
  ];

  projectData = [

  ];



  // 表单数据
  feedbackTitle: string = '';
  feedbackContent: string = '';
  contactInfo: string = '';

  // 提交状态
  isSubmitting: boolean = false;

  // 配置对话框按钮
  buttons: DialogButton[] = [
    {
      text: '取消',
      type: 'default',
      action: 'cancel'
    },
    {
      text: '提交',
      type: 'primary',
      action: 'submit'
    }
  ];

  constructor(
    private message: NzMessageService,
    private feedbackService: FeedbackService
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

  // 提交反馈
  async submitFeedback(): Promise<void> {
    // 验证反馈内容
    if (!this.feedbackContent || this.feedbackContent.trim() === '') {
      this.message.warning('请输入反馈内容');
      return;
    }

    if (!this.feedbackTitle || this.feedbackTitle.trim() === '') {
      this.message.warning('请输入反馈标题');
      return;
    }

    if (this.feedbackContent.trim().length < 10) {
      this.message.warning('反馈内容至少需要10个字符');
      return;
    }

    this.isSubmitting = true;

    // 更新按钮状态
    this.buttons = this.buttons.map(btn => ({
      ...btn,
      disabled: btn.action === 'cancel',
      loading: btn.action === 'submit'
    }));

    try {
      // 构建反馈数据
      const feedbackData = {
        label: this.feedbackType,
        title: this.feedbackTitle.trim(),
        content: this.feedbackContent.trim(),
        contact: this.contactInfo.trim(),
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent
      };

      this.feedbackService.submitFeedback(feedbackData).subscribe(res => {
        this.message.success('感谢您的反馈！');
        this.modal.close({ result: 'success', data: feedbackData });
        this.isSubmitting = false;
        // 恢复按钮状态
        this.buttons = this.buttons.map(btn => ({
          ...btn,
          disabled: false,
          loading: false
        }));
      }, err => {
        console.warn('提交反馈失败:', err);
        this.message.error('提交失败，请稍后重试');
        this.isSubmitting = false;
        // 恢复按钮状态
        this.buttons = this.buttons.map(btn => ({
          ...btn,
          disabled: false,
          loading: false
        }));
      });
    } catch (error) {
      console.warn('提交反馈失败:', error);
      this.message.error('提交失败，请稍后重试');
      this.isSubmitting = false;
      // 恢复按钮状态
      this.buttons = this.buttons.map(btn => ({
        ...btn,
        disabled: false,
        loading: false
      }));
    }
  }
}
