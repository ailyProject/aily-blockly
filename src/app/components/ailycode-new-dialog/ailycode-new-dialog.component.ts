import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import { UnsaveDialogComponent } from '../../main-window/components/unsave-dialog/unsave-dialog.component';
import { PlatformService } from '../../services/platform.service';
import { AilyCodeProjectService } from '../../services/aily-code-project.service';
import { ElectronService } from '../../services/electron.service';
import { ProjectService } from '../../services/project.service';

/**
 * Aily Code 新建项目对话框。
 * 与 blockly 的 ProjectNewComponent 完全独立：只收集"项目名 + 保存父目录"，
 * 然后委托 AilyCodeProjectService.projectNew() 生成目录结构。
 */
@Component({
  selector: 'app-ailycode-new-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    TranslateModule,
    BaseDialogComponent
  ],
  templateUrl: './ailycode-new-dialog.component.html',
  styleUrl: './ailycode-new-dialog.component.scss'
})
export class AilyCodeNewDialogComponent {

  readonly modal = inject(NzModalRef);

  /** 表单：项目名 + 保存父目录 */
  form = {
    name: '',
    path: ''
  };

  /** 同名占用提示 */
  showIsExist = false;
  /** 路径含非法字符（仅 macOS 校验） */
  showInvalidChars = false;
  /** 创建中：禁用所有交互，避免重复点击 */
  isSubmitting = false;

  /** 与 Header 一致：防止未保存弹窗重复叠加 */
  private unsaveDialogOpen = false;

  get buttons(): DialogButton[] {
    return [
      {
        text: 'AILYCODE_NEW_DIALOG.CANCEL',
        type: 'default',
        action: 'cancel',
        disabled: this.isSubmitting
      },
      {
        text: this.isSubmitting ? 'AILYCODE_NEW_DIALOG.CREATING' : 'AILYCODE_NEW_DIALOG.CREATE',
        type: 'primary',
        action: 'create',
        loading: this.isSubmitting,
        disabled: this.isSubmitting || this.showIsExist || this.showInvalidChars
      }
    ];
  }

  constructor(
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private translate: TranslateService,
    private platformService: PlatformService,
    private ailyCodeProject: AilyCodeProjectService,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private nzModal: NzModalService,
    private router: Router,
  ) { }

  ngOnInit(): void {
    if (this.electronService.isElectron) {
      // 默认放到 Documents/aily-code-project/，与 blockly 默认目录区分
      const pt = this.platformService.getPlatformSeparator();
      this.form.path = window['path'].getUserDocuments() + `${pt}aily-code-project${pt}`;
      this.form.name = this.ailyCodeProject.generateUniqueProjectName(this.form.path, 'aily_code_');
      this.checkPathExists();
    }
  }

  /** "选择保存路径"：复用主进程的 select-folder dialog */
  async selectFolder(): Promise<void> {
    try {
      const folderPath: string = await window['ipcRenderer'].invoke('select-folder', {
        path: this.form.path
      });
      if (!folderPath) return;
      // 统一以分隔符结尾，保持与 blockly 项目新建 UI 的视觉一致
      const pt = this.platformService.getPlatformSeparator();
      this.form.path = folderPath.endsWith(pt) ? folderPath : folderPath + pt;
      this.checkPathExists();
    } catch (error) {
      console.warn('[AilyCodeNewDialog] selectFolder 失败:', error);
    }
  }

  /** 检查最终目录是否已存在，触发输入框下方的错误提示 */
  checkPathExists(): void {
    const pt = this.platformService.getPlatformSeparator();
    const name = (this.form.name || '').trim().replace(/\s+/g, '_');
    if (!name || !this.form.path) {
      this.showIsExist = false;
    } else {
      const full = this.form.path.endsWith(pt) ? this.form.path + name : `${this.form.path}${pt}${name}`;
      this.showIsExist = !!window['path']?.isExists?.(full);
    }
    this.checkInvalidChars();
  }

  /** macOS 路径非法字符校验，规则与 ProjectNewComponent.checkPathInvalidChars 保持一致 */
  private checkInvalidChars(): void {
    if (!this.platformService.isMac()) {
      this.showInvalidChars = false;
      return;
    }
    const invalidChars = /[\s\0:\\*?^$!#%&()=+`~'"<>|\n\r]/;
    this.showInvalidChars = invalidChars.test(this.form.path);
  }

  onCloseDialog(): void {
    if (this.isSubmitting) return;
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
      this.onCloseDialog();
    } else if (action === 'create') {
      this.createProject();
    }
  }

  /** 当前是否处在会加载工程的主编辑路由（与 HeaderComponent.isLoaded 对齐） */
  private isOnEditorRoute(): boolean {
    const url = this.router.url;
    const routes = ['/main/blockly-editor', '/main/code-editor', '/main/code-editor-pro'];
    return routes.some((r) => url.includes(r));
  }

  /**
   * 切换到新工程前处理未保存（与「打开项目」流程一致）；
   * 取消则返回 false，目录已创建但不会 projectOpen。
   */
  private async confirmSwitchWithUnsavedIfNeeded(): Promise<boolean> {
    if (!this.isOnEditorRoute()) {
      return true;
    }
    if (!(await this.projectService.hasUnsavedChanges())) {
      return true;
    }
    if (this.unsaveDialogOpen) {
      return false;
    }
    this.unsaveDialogOpen = true;
    return new Promise<boolean>((resolve) => {
      const ref = this.nzModal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzWidth: '350px',
        nzContent: UnsaveDialogComponent,
        nzData: { action: 'open' as const },
      });
      ref.afterClose.subscribe(async (res: { result?: string } | null) => {
        this.unsaveDialogOpen = false;
        if (!res) {
          resolve(false);
          return;
        }
        switch (res.result) {
          case 'save':
            await this.projectService.save();
            resolve(true);
            break;
          case 'continue':
            resolve(true);
            break;
          case 'cancel':
          default:
            resolve(false);
            break;
        }
      });
    });
  }

  /** 真正执行创建：成功 → 提示并走 projectOpen 进入内嵌 aily-coder；失败 → 错误消息 */
  private async createProject(): Promise<void> {
    if (this.isSubmitting) return;

    const name = (this.form.name || '').trim();
    if (!name) {
      this.message.warning(this.translate.instant('AILYCODE_NEW_DIALOG.WARN_NAME_EMPTY'));
      return;
    }
    if (!this.form.path) {
      this.message.warning(this.translate.instant('AILYCODE_NEW_DIALOG.WARN_PATH_EMPTY'));
      return;
    }
    this.checkPathExists();
    if (this.showIsExist || this.showInvalidChars) return;

    this.isSubmitting = true;
    this.cd.detectChanges();

    const result = await this.ailyCodeProject.projectNew({
      name,
      path: this.form.path
    });

    this.isSubmitting = false;

    if (!result.ok) {
      // 把已知错误码翻译成提示，未知错误回退到通用失败文案
      const map: Record<string, string> = {
        NAME_EMPTY: 'AILYCODE_NEW_DIALOG.WARN_NAME_EMPTY',
        PATH_EMPTY: 'AILYCODE_NEW_DIALOG.WARN_PATH_EMPTY',
        PATH_EXISTS: 'AILYCODE_NEW_DIALOG.ERR_PATH_EXISTS'
      };
      const key = map[result.error || ''] || 'AILYCODE_NEW_DIALOG.ERR_CREATE_FAILED';
      this.message.error(this.translate.instant(key));
      this.checkPathExists();
      this.cd.detectChanges();
      return;
    }

    this.message.success(this.translate.instant('AILYCODE_NEW_DIALOG.SUCCESS'));

    if (result.projectPath) {
      // Aily Code 无 project.abi：projectOpen 会进入 /main/code-editor-pro（iframe 加载已安装的 Coder 子应用包）
      const canSwitch = await this.confirmSwitchWithUnsavedIfNeeded();
      if (!canSwitch) {
        this.modal.close({ result: 'created', projectPath: result.projectPath, opened: false });
        this.cd.detectChanges();
        return;
      }
      await this.projectService.projectOpen(result.projectPath);
    }

    this.modal.close({ result: 'created', projectPath: result.projectPath, opened: !!result.projectPath });
  }
}
