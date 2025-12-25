import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ModelProjectService } from '../../services/model-project.service';

@Component({
  selector: 'app-save-project-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzModalModule,
    NzInputModule,
    NzButtonModule
  ],
  template: `
    <nz-modal [(nzVisible)]="visible" [nzTitle]="'保存项目'" [nzFooter]="modalFooter"
      [nzWidth]="400" (nzOnCancel)="handleCancel()" nzClassName="save-project-modal">
      <ng-template #modalFooter>
        <button nz-button nzType="default" (click)="handleCancel()">关闭</button>
        <button nz-button nzType="primary" (click)="handleSave()" [nzLoading]="saving">保存</button>
      </ng-template>
      <div *nzModalContent class="save-project-content">
        <div class="form-item">
          <label>项目名称</label>
          <input nz-input [(ngModel)]="projectName" placeholder="请输入项目名称" />
        </div>
        <div class="form-item">
          <label>保存路径</label>
          <nz-input-group [nzAddOnAfter]="folderIconTemplate">
            <input nz-input [(ngModel)]="projectPath" placeholder="选择项目保存路径" [disabled]="true" />
          </nz-input-group>
          <ng-template #folderIconTemplate>
            <div class="btn ccenter ffull" (click)="selectPath()">
              <i class="fa-light fa-folder"></i>
            </div>
          </ng-template>
        </div>
      </div>
    </nz-modal>
  `,
  styles: [`
    ::ng-deep .save-project-modal {
      .ant-modal-content {
        background: #161616 !important;
        opacity: 1 !important;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.8) !important;
        border-radius: 8px !important;
        overflow: hidden;
      }

      .ant-modal-header {
        background: transparent;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        padding: 12px 16px;

        .ant-modal-title {
          color: #ffffff;
        }
      }

      .ant-modal-close {
        color: #bfbfbf;

        &:hover {
          color: #ffffff;
        }
      }

      .ant-modal-body {
        padding: 16px;
        background: transparent !important;
        color: #e6e6e6;
      }

      .ant-modal-footer {
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        padding: 12px 16px;
        background: transparent;

        button {
          &:not(:last-child) {
            margin-right: 8px;
          }
        }
      }
    }

    ::ng-deep .save-project-content {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 4px 0;

      .form-item {
        display: flex;
        flex-direction: column;
        gap: 8px;

        label {
          color: #e6e6e6;
          font-size: 14px;
          font-weight: 500;
        }

        input[nz-input] {
          background: #1f1f1f !important;
          border-color: rgba(255, 255, 255, 0.06) !important;
          color: #e6e6e6 !important;
          
          &:hover {
            border-color: rgba(24, 144, 255, 0.5) !important;
          }

          &:focus {
            border-color: #1890ff !important;
            box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.1);
          }

          &::placeholder {
            color: #666;
          }

          &:disabled {
            background: #141414 !important;
            color: #888 !important;
            cursor: not-allowed;
          }
        }

        nz-input-group {
          ::ng-deep {
            .ant-input-group-addon {
              background: #1f1f1f !important;
              border-color: rgba(255, 255, 255, 0.06) !important;
              padding: 0;

              .btn {
                width: 32px;
                height: 30px;
                color: #bfbfbf;
                cursor: pointer;
                transition: all 0.2s;

                &:hover {
                  color: #1890ff;
                  background: rgba(24, 144, 255, 0.05);
                }

                i {
                  font-size: 14px;
                }
              }
            }
          }
        }
      }
    }
  `]
})
export class SaveProjectModalComponent implements OnInit {
  @Input() visible = false;
  @Input() projectName = '';
  @Input() projectPath = '';
  @Input() namePrefix = 'project_';
  
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() projectNameChange = new EventEmitter<string>();
  @Output() projectPathChange = new EventEmitter<string>();
  @Output() save = new EventEmitter<{ name: string; path: string }>();
  @Output() cancel = new EventEmitter<void>();

  saving = false;

  constructor(private modelProjectService: ModelProjectService) {}

  ngOnInit() {
    // 如果没有设置默认路径，则获取默认路径
    if (!this.projectPath) {
      this.projectPath = this.modelProjectService.getDefaultSavePath();
      this.projectPathChange.emit(this.projectPath);
    }
    
    // 如果没有设置项目名称，则生成默认名称
    if (!this.projectName && this.projectPath) {
      this.projectName = this.modelProjectService.generateProjectName(this.projectPath, this.namePrefix);
      this.projectNameChange.emit(this.projectName);
    }
  }

  async selectPath() {
    const newPath = await this.modelProjectService.selectSavePath(this.projectPath);
    if (newPath) {
      this.projectPath = newPath;
      this.projectPathChange.emit(this.projectPath);
    }
  }

  handleCancel() {
    this.visible = false;
    this.visibleChange.emit(false);
    this.cancel.emit();
  }

  handleSave() {
    if (!this.projectName.trim()) {
      return;
    }
    
    this.save.emit({
      name: this.projectName,
      path: this.projectPath
    });
  }

  setSaving(value: boolean) {
    this.saving = value;
  }

  close() {
    this.visible = false;
    this.visibleChange.emit(false);
  }
}
