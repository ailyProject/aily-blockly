import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import {
  BlocklyLibraryPackageRef,
  BlocklyLibraryPackageService,
  BlocklyLibrarySubmissionPackage,
} from '@domain/dependencies/public-api';
import { ElectronService } from '@core/platform/public-api';
import { ConfigService } from '@core/preferences/public-api';

export interface LibraryPublishDialogResult {
  packageJsonPatch: Record<string, unknown>;
  localPackageJsonPatch: Record<string, unknown>;
  prDescription: string;
  saveToLocalPackageJson: boolean;
}

export interface LibraryPublishSubmitResult {
  success: boolean;
  packageNameConflictMessage?: string;
  packageNameConflictValue?: string;
}

@Component({
  selector: 'app-library-publish-dialog',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzCheckboxModule,
    NzInputModule,
    TranslateModule,
    BaseDialogComponent,
  ],
  templateUrl: './library-publish-dialog.component.html',
  styleUrl: './library-publish-dialog.component.scss',
})
export class LibraryPublishDialogComponent {
  readonly modal = inject(NzModalRef);
  readonly data: {
    ref: BlocklyLibraryPackageRef;
    displayName?: string;
    initialPackageJsonPatch?: Record<string, unknown>;
    packageNameConflictMessage?: string;
    packageNameConflictValue?: string;
    submitPublish?: (result: LibraryPublishDialogResult) => Promise<LibraryPublishSubmitResult>;
  } = inject(NZ_MODAL_DATA);

  packageName = '';
  nickname = '';
  description = '';
  prDescription = '';
  author = '';
  keywords = '';
  version = '';
  blockCount = 0;
  saveToLocalPackageJson = false;
  hardwareTestConfirmed = false;
  isSubmitting = false;
  currentPackageNameConflictMessage = '';
  currentPackageNameConflictValue = '';
  packageNameValidationMessage = '';
  versionValidationMessage = '';

  private readonly packageNamePattern = /^@aily-project\/lib-[a-z0-9][a-z0-9-]*[a-z0-9]$/;
  private readonly packageNamePrefix = '@aily-project/lib-';
  private readonly versionPattern = /^\d+\.\d+\.\d+$/;

  @ViewChild('packageNameInput') private packageNameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('versionInput') private versionInput?: ElementRef<HTMLInputElement>;
  @ViewChild('nicknameInput') private nicknameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('hardwareConfirmOption') private hardwareConfirmOption?: ElementRef<HTMLElement>;

  get packageNameConflictMessage(): string {
    const conflictValue = this.currentPackageNameConflictValue || '';
    if (!conflictValue || this.packageName.trim() !== conflictValue) {
      return '';
    }

    return this.currentPackageNameConflictMessage || '';
  }

  get packageNameErrorMessage(): string {
    return this.packageNameValidationMessage || this.packageNameConflictMessage;
  }

  get versionErrorMessage(): string {
    return this.versionValidationMessage;
  }

  get isKnownPublicLibraryName(): boolean {
    const packageName = this.packageName.trim();
    return !!packageName && !!this.configService.libraryDict?.[packageName];
  }

  get buttons(): DialogButton[] {
    return [
      {
        text: this.translate.instant('LIBRARY_PUBLISH.CANCEL'),
        type: 'default',
        disabled: this.isSubmitting,
        action: 'cancel',
      },
      {
        text: this.translate.instant('LIBRARY_PUBLISH.PUBLISH'),
        type: 'primary',
        loading: this.isSubmitting,
        action: 'publish',
      },
    ];
  }

  constructor(
    private message: NzMessageService,
    private blocklyLibraryPackageService: BlocklyLibraryPackageService,
    private electronService: ElectronService,
    private configService: ConfigService,
    private translate: TranslateService,
  ) {}

  ngOnInit(): void {
    try {
      const bundle = this.blocklyLibraryPackageService.readLibrarySubmissionPackageByRef(this.data.ref);
      this.applyPackage(bundle.package);
      this.applyInitialPatch();
      this.currentPackageNameConflictMessage = this.data.packageNameConflictMessage || '';
      this.currentPackageNameConflictValue = this.data.packageNameConflictValue || '';
    } catch (error) {
      this.message.error(this.translate.instant('LIBRARY_PUBLISH.READ_FAILED', {
        error: error instanceof Error ? error.message : error,
      }));
      this.modal.close({ result: 'cancel' });
    }
  }

  onCloseDialog(): void {
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
      this.onCloseDialog();
      return;
    }

    if (action === 'publish') {
      this.publish();
    }
  }

  openLibraryRepo(event: MouseEvent): void {
    event.preventDefault();
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries');
  }

  validatePackageNameField(): boolean {
    const packageName = this.packageName.trim();
    if (!packageName) {
      this.packageNameValidationMessage = this.translate.instant('LIBRARY_PUBLISH.PACKAGE_NAME_REQUIRED');
      return false;
    }

    if (!packageName.startsWith(this.packageNamePrefix)) {
      this.packageNameValidationMessage = this.translate.instant('LIBRARY_PUBLISH.PACKAGE_NAME_PREFIX_REQUIRED', {
        prefix: this.packageNamePrefix,
      });
      return false;
    }

    if (!this.packageNamePattern.test(packageName)) {
      this.packageNameValidationMessage = this.translate.instant('LIBRARY_PUBLISH.PACKAGE_NAME_PATTERN');
      return false;
    }

    this.packageNameValidationMessage = '';
    return true;
  }

  onPackageNameInputChange(): void {
    this.currentPackageNameConflictMessage = '';
    this.currentPackageNameConflictValue = '';
    if (this.packageNameValidationMessage) {
      this.validatePackageNameField();
    }
  }

  validateVersionField(): boolean {
    const version = this.version.trim();
    if (!version) {
      this.versionValidationMessage = this.translate.instant('LIBRARY_PUBLISH.VERSION_REQUIRED');
      return false;
    }

    if (!this.versionPattern.test(version)) {
      this.versionValidationMessage = this.translate.instant('LIBRARY_PUBLISH.VERSION_PATTERN');
      return false;
    }

    this.versionValidationMessage = '';
    return true;
  }

  onVersionInputChange(): void {
    if (this.versionValidationMessage) {
      this.validateVersionField();
    }
  }

  private applyPackage(pkg: BlocklyLibrarySubmissionPackage): void {
    const packageJson = pkg.packageJson || {};
    this.packageName = packageJson.name || this.data.ref.name || '';
    this.nickname = packageJson.nickname || this.data.displayName || this.packageName;
    this.description = packageJson.description || '';
    this.author = this.normalizeAuthor(packageJson.author);
    this.version = packageJson.version || '';
    this.keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords.join(', ') : '';
    this.blockCount = Array.isArray(pkg.blockJson) ? pkg.blockJson.length : 0;
  }

  private applyInitialPatch(): void {
    const patch = this.data.initialPackageJsonPatch;
    if (!patch || typeof patch !== 'object') {
      return;
    }

    if (typeof patch['name'] === 'string') {
      this.packageName = patch['name'];
    }
    if (typeof patch['version'] === 'string') {
      this.version = patch['version'];
    }
    if (typeof patch['nickname'] === 'string') {
      this.nickname = patch['nickname'];
    }
    if (typeof patch['description'] === 'string') {
      this.description = patch['description'];
    }
    if (typeof patch['author'] === 'string') {
      this.author = patch['author'];
    }
    if (Array.isArray(patch['keywords'])) {
      this.keywords = patch['keywords']
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .join(', ');
    }
  }

  private normalizeAuthor(author: unknown): string {
    if (typeof author === 'string') {
      return author;
    }
    if (author && typeof author === 'object' && !Array.isArray(author)) {
      const authorName = (author as { name?: unknown }).name;
      return typeof authorName === 'string' ? authorName : '';
    }
    return '';
  }

  private async publish(): Promise<void> {
    if (this.isSubmitting) {
      return;
    }

    const packageName = this.packageName.trim();
    if (!this.validatePackageNameField()) {
      this.focusPublishField('packageName');
      this.message.warning(this.packageNameValidationMessage, { nzDuration: 5000 });
      return;
    }

    if (!this.validateVersionField()) {
      this.focusPublishField('version');
      this.message.warning(this.versionValidationMessage, { nzDuration: 5000 });
      return;
    }

    if (!this.nickname.trim()) {
      this.focusPublishField('nickname');
      this.message.warning(this.translate.instant('LIBRARY_PUBLISH.DISPLAY_NAME_REQUIRED'), { nzDuration: 5000 });
      return;
    }

    if (!this.hardwareTestConfirmed) {
      this.focusPublishField('hardwareTest');
      this.message.warning(this.translate.instant('LIBRARY_PUBLISH.HARDWARE_REQUIRED'), { nzDuration: 5000 });
      return;
    }

    const result: LibraryPublishDialogResult = {
      packageJsonPatch: {
        name: packageName,
        version: this.version.trim(),
        nickname: this.nickname.trim(),
        description: this.description.trim(),
        author: this.author.trim(),
        keywords: this.parseKeywords(),
      },
      localPackageJsonPatch: {
        name: packageName,
        version: this.version.trim(),
        nickname: this.nickname.trim(),
        description: this.description.trim(),
        author: this.author.trim(),
        keywords: this.parseKeywords(),
      },
      prDescription: this.prDescription.trim(),
      saveToLocalPackageJson: this.saveToLocalPackageJson,
    };

    if (!this.data.submitPublish) {
      this.modal.close({ result: 'publish', data: result });
      return;
    }

    this.isSubmitting = true;
    try {
      const submitResult = await this.data.submitPublish(result);
      if (submitResult.success) {
        this.modal.close({ result: 'success', data: result });
        return;
      }

      this.currentPackageNameConflictMessage = submitResult.packageNameConflictMessage || '';
      this.currentPackageNameConflictValue = submitResult.packageNameConflictValue || packageName;
      this.focusPublishField('packageName', true);
    } catch (error) {
      this.message.error(error instanceof Error ? error.message : String(error), { nzDuration: 8000 });
    } finally {
      this.isSubmitting = false;
    }
  }

  private parseKeywords(): string[] {
    return this.keywords
      .split(',')
      .map(keyword => keyword.trim())
      .filter(keyword => keyword.length > 0);
  }

  private focusPublishField(field: 'packageName' | 'version' | 'nickname' | 'hardwareTest', afterRender = false): void {
    const focus = () => {
      const target = this.getPublishFieldElement(field);
      if (!target) {
        return;
      }

      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.focus({ preventScroll: true });
    };

    if (afterRender) {
      window.setTimeout(focus, 0);
      return;
    }

    focus();
  }

  private getPublishFieldElement(field: 'packageName' | 'version' | 'nickname' | 'hardwareTest'): HTMLElement | undefined {
    if (field === 'packageName') {
      return this.packageNameInput?.nativeElement;
    }
    if (field === 'version') {
      return this.versionInput?.nativeElement;
    }
    if (field === 'nickname') {
      return this.nicknameInput?.nativeElement;
    }
    return this.hardwareConfirmOption?.nativeElement;
  }
}
