import { CommonModule } from '@angular/common';
import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostBinding, NgZone, OnDestroy, OnInit, Output, TemplateRef, ViewChild } from '@angular/core';
import { Subject, combineLatest, firstValueFrom } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import {
  BLOCKLY_TOOLBOX_SEARCH_KEY,
  BlocklyService,
  BlocklyToolboxFacadeItem,
} from '../../../../services/blockly.service';
import { BlocklyLibraryMetadataUpdateResult, BlocklyLibraryPackageService } from '../../../../../../services/blockly-library-package.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MenuComponent } from '../../../../../../components/menu/menu.component';
import { IMenuItem } from '../../../../../../configs/menu.config';
import { ElectronService } from '../../../../../../services/electron.service';
import { ProjectService } from '../../../../../../services/project.service';
import { CmdService } from '../../../../../../services/cmd.service';
import { WorkflowService } from '../../../../../../services/workflow.service';
import { UiService } from '../../../../../../services/ui.service';
import { LibrarySubmissionApiError, LibrarySubmissionService } from '../../../../../../services/library-submission.service';
import { AuthService } from '../../../../../../services/auth.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import {
  LibraryPublishDialogComponent,
  LibraryPublishDialogResult,
  LibraryPublishSubmitResult,
} from '../../../../../../components/library-publish-dialog/library-publish-dialog.component';
import {
  LibraryPublishConfirmDialogComponent,
  LibraryPublishConfirmDialogData,
} from '../../../../../../components/library-publish-confirm-dialog/library-publish-confirm-dialog.component';
import { extractApiErrorDetails } from '../../../../../../utils/api-error.utils';
import Sortable, { SortableEvent } from 'sortablejs';

interface ToolboxContextMenuAction {
  name: string;
  action: string;
  icon: string;
  handler: (item: BlocklyToolboxFacadeItem) => void | Promise<void>;
  disabled?: (item: BlocklyToolboxFacadeItem) => boolean;
  visible?: (item: BlocklyToolboxFacadeItem) => boolean;
}

@Component({
  selector: 'app-blockly-toolbox-pane',
  imports: [CommonModule, TranslateModule, MenuComponent],
  templateUrl: './blockly-toolbox-pane.component.html',
  styleUrl: './blockly-toolbox-pane.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlocklyToolboxPaneComponent implements OnInit, AfterViewInit, OnDestroy {
  @Output() libraryManagerRequested = new EventEmitter<void>();

  readonly searchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  items: BlocklyToolboxFacadeItem[] = [];
  selectedKey: string | null = null;
  searchQuery = '';
  showContextMenu = false;
  dragVisualActive = false;
  hoverSuppressed = false;
  contextMenuPosition = { x: 0, y: 0 };
  contextMenuItems: IMenuItem[] = [];
  contextMenuTarget: BlocklyToolboxFacadeItem | null = null;

  readonly toolboxContextMenuActions: ToolboxContextMenuAction[] = [
    // 资源管理器中打开库所在位置
    {
      name: 'MENU.OPEN_IN_EXPLORER',
      action: 'open-library-path',
      icon: 'fa-light fa-browser',
      handler: (item) => this.openLibraryPath(item),
      disabled: (item) => !item.libraryPath,
    },
    // 反馈非本地库问题
    {
      name: 'MENU.FEEDBACK_LIBRARY_ISSUE',
      action: 'feedback-library-issue',
      icon: 'fa-light fa-message-exclamation',
      handler: (item) => this.openLibraryFeedback(item),
      disabled: (item) => !item.libraryName,
      visible: (item) => !item.isLocalLibrary,
    },
    // 发布本地库并提交 PR
    {
      name: 'MENU.UPLOAD_LIBRARY',
      action: 'upload-library',
      icon: 'fa-light fa-cloud-arrow-up',
      handler: (item) => this.uploadLibrary(item),
      disabled: (item) => !item.libraryName || !item.libraryPath || this.uploadingLibraryNames.has(item.libraryName),
      visible: (item) => item.isLocalLibrary === true,
    },
    // 移除该库
    {
      name: 'LIB_MANAGER.REMOVE',
      action: 'remove-library',
      icon: 'fa-light fa-trash-can',
      handler: (item) => this.removeLibrary(item),
      disabled: (item) => !item.libraryName || !item.libraryPath || this.removingLibraryNames.has(item.libraryName),
    },
  ];

  private destroy$ = new Subject<void>();
  private removingLibraryNames = new Set<string>();
  private uploadingLibraryNames = new Set<string>();
  private sortableInstances = new Map<HTMLElement, Sortable>();
  private sortableSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverSuppressPointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  private dragSorting = false;
  private lastDragEndAt = 0;
  private readonly toolboxOrderPackageKey = 'blocklyToolboxOrder';
  private pendingLibraryMetadataUpdateResult: BlocklyLibraryMetadataUpdateResult | null = null;
  lastSubmittedLibraryDisplayName = '';

  @ViewChild('librarySubmissionSuccessTpl')
  private librarySubmissionSuccessTpl?: TemplateRef<void>;

  @HostBinding('class.toolbox-pane--sorting')
  get isSortingVisualActive(): boolean {
    return this.dragVisualActive;
  }

  @HostBinding('class.toolbox-pane--suppress-hover')
  get isHoverSuppressed(): boolean {
    return this.hoverSuppressed;
  }

  // get isSearchActive(): boolean {
  //   return this.selectedKey === this.searchKey;
  // }

  constructor(
    private blocklyService: BlocklyService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private workflowService: WorkflowService,
    private uiService: UiService,
    private librarySubmissionService: LibrarySubmissionService,
    private blocklyLibraryPackageService: BlocklyLibraryPackageService,
    private authService: AuthService,
    private message: NzMessageService,
    private modal: NzModalService,
    private translate: TranslateService,
    private elementRef: ElementRef<HTMLElement>,
  ) { }

  ngOnInit(): void {
    combineLatest([
      this.blocklyService.toolboxFacadeItemsSubject,
      this.blocklyService.toolboxSelectedKeySubject,
      this.blocklyService.toolboxSearchQuerySubject,
    ])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([items, selectedKey, searchQuery]) => {
        this.ngZone.run(() => {
          this.items = items;
          this.selectedKey = selectedKey;
          this.searchQuery = searchQuery;
          if (this.contextMenuTarget && !this.findItemByKey(this.contextMenuTarget.key, items)) {
            this.closeContextMenu();
          }
          this.cdr.markForCheck();
          this.scheduleSortableSync();
        });
      });
  }

  ngAfterViewInit(): void {
    this.scheduleSortableSync();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.sortableSyncTimer) {
      clearTimeout(this.sortableSyncTimer);
    }
    this.removeHoverSuppressPointerListener();
    this.destroySortables();
  }

  trackItem(_index: number, item: BlocklyToolboxFacadeItem): string {
    return item.key;
  }

  onSearchFocus() {
    this.blocklyService.activateToolboxSearch();
  }

  onSearchInput(event: Event) {
    const query = (event.target as HTMLInputElement).value;
    this.blocklyService.setToolboxSearchQuery(query);
  }

  onSearchClear() {
    this.blocklyService.clearToolboxSearch();
  }

  onCategoryClick(item: BlocklyToolboxFacadeItem) {
    if (this.shouldIgnoreCategoryClick()) {
      return;
    }

    this.blocklyService.clickToolboxFacadeItem(item.key);
  }

  onToggleClick(item: BlocklyToolboxFacadeItem, event: MouseEvent) {
    event.stopPropagation();
    this.blocklyService.toggleToolboxFacadeItem(item.key);
  }

  onToolboxItemContextMenu(item: BlocklyToolboxFacadeItem, event: MouseEvent) {
    if (!this.hasLibraryContextMenu(item)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    this.contextMenuTarget = item;
    this.contextMenuItems = this.toolboxContextMenuActions
      .filter(action => action.visible?.(item) ?? true)
      .map(action => ({
        name: action.name,
        action: action.action,
        icon: action.icon,
        disabled: action.disabled?.(item) || false,
      }));
    this.contextMenuPosition = { x: event.clientX, y: event.clientY };
    this.showContextMenu = true;
  }

  async onContextMenuItemClick(menuItem: IMenuItem) {
    const target = this.contextMenuTarget;
    const action = this.toolboxContextMenuActions.find(item => item.action === menuItem.action);
    this.closeContextMenu();

    if (!target || !action || menuItem.disabled) {
      return;
    }

    await action.handler(target);
  }

  closeContextMenu() {
    this.showContextMenu = false;
    this.contextMenuTarget = null;
    this.contextMenuItems = [];
  }

  onLibraryManagerClick() {
    this.libraryManagerRequested.emit();
  }

  private scheduleSortableSync() {
    if (this.sortableSyncTimer) {
      clearTimeout(this.sortableSyncTimer);
    }

    this.sortableSyncTimer = setTimeout(() => {
      this.sortableSyncTimer = null;
      this.syncSortableContainers();
    }, 0);
  }

  private syncSortableContainers() {
    const containers = Array.from(this.elementRef.nativeElement.querySelectorAll<HTMLElement>('[data-toolbox-sortable-container="true"]'));
    const activeContainers = new Set(containers);

    this.sortableInstances.forEach((sortable, container) => {
      if (!activeContainers.has(container) || !container.isConnected) {
        sortable.destroy();
        this.sortableInstances.delete(container);
      }
    });

    containers.forEach((container) => {
      if (this.sortableInstances.has(container)) {
        return;
      }

      this.ngZone.runOutsideAngular(() => {
        const sortable = Sortable.create(container, {
          animation: 150,
          draggable: '.toolbox-node--sortable',
          handle: '.toolbox-row--sortable-handle',
          delay: 200,
          delayOnTouchOnly: false,
          touchStartThreshold: 10,
          fallbackTolerance: 4,
          ghostClass: 'toolbox-node--drag-ghost',
          chosenClass: 'toolbox-node--drag-chosen',
          dragClass: 'toolbox-node--dragging',
          filter: '.toolbox-item__toggle',
          preventOnFilter: false,
          onChoose: (event: SortableEvent) => {
            this.ngZone.run(() => {
              this.enterDragVisualMode(event.item);
            });
          },
          onStart: (event: SortableEvent) => {
            this.ngZone.run(() => {
              this.dragSorting = true;
              this.enterDragVisualMode(event.item);
            });
          },
          onUnchoose: () => {
            this.ngZone.run(() => {
              if (!this.dragSorting) {
                this.setDragVisualActive(false);
              }
            });
          },
          onEnd: (event: SortableEvent) => {
            this.ngZone.run(() => this.onToolboxSortEnd(event));
          },
        });

        this.sortableInstances.set(container, sortable);
      });
    });
  }

  private async onToolboxSortEnd(event: SortableEvent) {
    this.dragSorting = false;
    this.setDragVisualActive(false);
    this.suppressHoverAfterDragEnd();
    this.lastDragEndAt = Date.now();

    const itemKey = event.item.getAttribute('data-toolbox-key');
    const nextIndex = event.newDraggableIndex ?? event.newIndex ?? -1;

    if (!itemKey || nextIndex < 0 || event.oldIndex === event.newIndex) {
      this.scheduleSortableSync();
      return;
    }

    const moved = this.blocklyService.moveToolboxFacadeItem(itemKey, nextIndex);
    if (!moved) {
      this.scheduleSortableSync();
      return;
    }

    try {
      await this.persistToolboxOrder();
    } catch (error) {
      console.error('保存工具箱顺序失败:', error);
      this.message.error('保存工具箱顺序失败');
    } finally {
      this.scheduleSortableSync();
      this.cdr.markForCheck();
    }
  }

  private async persistToolboxOrder() {
    const packageJson = await this.projectService.getPackageJson();
    if (!packageJson) {
      return;
    }

    packageJson[this.toolboxOrderPackageKey] = this.blocklyService.getToolboxSortOrder();
    await this.projectService.setPackageJson(packageJson);
  }

  private shouldIgnoreCategoryClick(): boolean {
    return this.dragSorting || Date.now() - this.lastDragEndAt < 250;
  }

  private destroySortables() {
    this.sortableInstances.forEach((sortable) => sortable.destroy());
    this.sortableInstances.clear();
  }

  private enterDragVisualMode(itemElement?: HTMLElement) {
    if (itemElement) {
      this.closeDraggedItemBeforeSort(itemElement);
    }

    this.selectedKey = null;
    this.blocklyService.clearToolboxSelection();
    this.setDragVisualActive(true);
    this.closeContextMenu();
  }

  private closeDraggedItemBeforeSort(itemElement: HTMLElement) {
    const itemKey = itemElement.getAttribute('data-toolbox-key');
    if (!itemKey) {
      return;
    }

    const item = this.findItemByKey(itemKey, this.items);
    if (!item) {
      return;
    }

    if (this.selectedKey === item.key) {
      this.selectedKey = null;
      this.blocklyService.clearToolboxSelection();
    }

    if (item.isCollapsible && item.expanded) {
      this.blocklyService.collapseToolboxFacadeItem(item.key);
    }
  }

  private setDragVisualActive(active: boolean) {
    if (active) {
      this.setHoverSuppressed(false);
    }

    if (this.dragVisualActive === active) {
      return;
    }

    this.dragVisualActive = active;
    this.cdr.markForCheck();
  }

  private suppressHoverAfterDragEnd() {
    this.setHoverSuppressed(true);
    this.removeHoverSuppressPointerListener();

    this.hoverSuppressPointerMoveHandler = () => {
      this.ngZone.run(() => this.setHoverSuppressed(false));
    };
    document.addEventListener('pointermove', this.hoverSuppressPointerMoveHandler, { capture: true, once: true });
  }

  private setHoverSuppressed(suppressed: boolean) {
    if (!suppressed) {
      this.removeHoverSuppressPointerListener();
    }

    if (this.hoverSuppressed === suppressed) {
      return;
    }

    this.hoverSuppressed = suppressed;
    this.cdr.markForCheck();
  }

  private removeHoverSuppressPointerListener() {
    if (!this.hoverSuppressPointerMoveHandler) {
      return;
    }

    document.removeEventListener('pointermove', this.hoverSuppressPointerMoveHandler, { capture: true });
    this.hoverSuppressPointerMoveHandler = null;
  }

  private hasLibraryContextMenu(item: BlocklyToolboxFacadeItem): boolean {
    return !!item.libraryName && !!item.libraryPath;
  }

  private openLibraryPath(item: BlocklyToolboxFacadeItem) {
    if (!item.libraryPath) {
      return;
    }

    this.electronService.openByExplorer(item.libraryPath);
  }

  private openLibraryFeedback(item: BlocklyToolboxFacadeItem) {
    const libraryName = item.libraryName || '';

    this.uiService.openFeedback({
      feedbackType: 'library',
      feedbackLibraryName: libraryName,
      feedbackContent: this.translate.instant('FEEDBACK_DIALOG.LIBRARY_ISSUE_CONTENT', {
        name: libraryName,
      }),
    });
  }

  private async uploadLibrary(item: BlocklyToolboxFacadeItem) {
    const libraryName = item.libraryName;
    const libraryPath = item.libraryPath;
    if (!libraryName || !libraryPath || this.uploadingLibraryNames.has(libraryName)) {
      return;
    }

    if (!await this.ensureLibrarySubmissionReady()) {
      return;
    }

    try {
      this.uploadingLibraryNames.add(libraryName);
      await this.openLibraryPublishDialog(item);
    } catch (error) {
      const errorMessage = this.getLibrarySubmissionErrorMessage(error);
      this.message.error(`${this.getLibraryDisplayName(item)} 发布失败: ${errorMessage}`, { nzDuration: 7000 });
    } finally {
      this.uploadingLibraryNames.delete(libraryName);
      this.cdr.markForCheck();
    }
  }

  private openLibraryPublishDialog(
    item: BlocklyToolboxFacadeItem,
    initialPackageJsonPatch?: Record<string, unknown>,
    packageNameConflictMessage = '',
    packageNameConflictValue = '',
  ): Promise<void> {
    return new Promise((resolve) => {
      const modalRef = this.modal.create({
        nzClassName: 'library-publish-modal',
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0', maxHeight: 'calc(100vh - 80px)', overflow: 'hidden' },
        nzStyle: { top: '24px' },
        nzWidth: '640px',
        nzContent: LibraryPublishDialogComponent,
        nzData: {
          ref: {
            name: item.libraryName || '',
            path: item.libraryPath || '',
            source: 'declared',
          },
          displayName: this.getLibraryDisplayName(item),
          initialPackageJsonPatch,
          packageNameConflictMessage,
          packageNameConflictValue,
          submitPublish: (result: LibraryPublishDialogResult) => this.submitPublishFromDialog(item, result),
        },
      });

      modalRef.afterClose.subscribe(async () => {
        await this.promptProjectReloadAfterLibraryMetadataUpdate();
        resolve();
      });
    });
  }

  private async submitPublishFromDialog(item: BlocklyToolboxFacadeItem, publishResult: LibraryPublishDialogResult): Promise<LibraryPublishSubmitResult> {
    return this.submitPublishFromDialogWithGithubRetry(item, publishResult, true);
  }

  private async submitPublishFromDialogWithGithubRetry(item: BlocklyToolboxFacadeItem, publishResult: LibraryPublishDialogResult, allowGithubBindRetry: boolean): Promise<LibraryPublishSubmitResult> {
    try {
      const accepted = await this.submitLibraryWithExistingConfirmation(
        item,
        publishResult.packageJsonPatch,
        publishResult.prDescription,
      );
      if (!accepted) {
        return { success: false };
      }

      if (publishResult.saveToLocalPackageJson) {
        this.pendingLibraryMetadataUpdateResult = this.saveLibraryMetadataToLocalPackage(item, publishResult.localPackageJsonPatch);
      }
      this.showLibrarySubmissionSuccessMessage(item, publishResult.packageJsonPatch);
      return { success: true };
    } catch (error) {
      if (allowGithubBindRetry && this.isGithubBindingRequiredError(error)) {
        const ready = await this.promptGithubBindForLibrarySubmission();
        if (!ready) {
          return { success: false };
        }

        return this.submitPublishFromDialogWithGithubRetry(item, publishResult, false);
      }

      if (!this.isPackageNameUnavailableError(error)) {
        throw error;
      }

      const packageName = String(publishResult.packageJsonPatch['name'] || '').trim();
      return {
        success: false,
        packageNameConflictValue: packageName,
        packageNameConflictMessage: this.getPackageNameUnavailableMessage(error, packageName),
      };
    }
  }

  private isGithubBindingRequiredError(error: unknown): boolean {
    const apiError = error as Partial<LibrarySubmissionApiError>;
    const permissionErrorCodes = new Set([
      'github_not_bound',
      'github_repo_scope_required',
      'github_fork_permission_denied',
      'github_token_invalid',
    ]);
    if (apiError.errorCode && permissionErrorCodes.has(apiError.errorCode)) {
      return true;
    }

    const message = (apiError.message || '').toLowerCase();
    return /missing repo permission|repo permission|repository write permissions|reconnect github|bad credentials|重新绑定 github|github 授权/.test(message);
  }

  private saveLibraryMetadataToLocalPackage(item: BlocklyToolboxFacadeItem, localPackageJsonPatch: Record<string, unknown>): BlocklyLibraryMetadataUpdateResult {
    try {
      return this.blocklyLibraryPackageService.updateLibraryPackageJsonMetadata({
        name: item.libraryName || '',
        path: item.libraryPath || '',
        source: 'declared',
      }, localPackageJsonPatch);
    } catch (error) {
      throw new Error(`本地库元信息保存失败: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async promptProjectReloadAfterLibraryMetadataUpdate(): Promise<void> {
    const updateResult = this.pendingLibraryMetadataUpdateResult;
    this.pendingLibraryMetadataUpdateResult = null;
    if (!updateResult?.requiresProjectReload || !this.projectService.currentProjectPath) {
      return;
    }

    const renamedText = updateResult.previousPackageName && updateResult.nextPackageName
      ? this.translate.instant('LIBRARY_PUBLISH.RELOAD_RENAMED', {
        previousName: updateResult.previousPackageName,
        nextName: updateResult.nextPackageName,
      })
      : this.translate.instant('LIBRARY_PUBLISH.RELOAD_UPDATED');

    const confirmed = await this.openLibraryPublishConfirmDialog({
      title: this.translate.instant('LIBRARY_PUBLISH.RELOAD_TITLE'),
      content: this.translate.instant('LIBRARY_PUBLISH.RELOAD_CONTENT', { message: renamedText }),
      okText: this.translate.instant('LIBRARY_PUBLISH.RELOAD_OK'),
      cancelText: this.translate.instant('LIBRARY_PUBLISH.RELOAD_LATER'),
    });

    if (!confirmed) {
      this.message.info(this.translate.instant('LIBRARY_PUBLISH.RELOAD_SKIPPED'), { nzDuration: 5000 });
      return;
    }

    const projectPath = this.projectService.currentProjectPath;
    const saveResult = await this.projectService.save(projectPath);
    if (!saveResult.success) {
      this.message.error(this.translate.instant('LIBRARY_PUBLISH.RELOAD_SAVE_FAILED', {
        error: saveResult.error || this.translate.instant('LIBRARY_PUBLISH.UNKNOWN_ERROR'),
      }), { nzDuration: 7000 });
      return;
    }

    await this.projectService.projectOpen(projectPath, { reason: 'reload' });
  }

  private async submitLibraryWithExistingConfirmation(
    item: BlocklyToolboxFacadeItem,
    packageJsonPatch: Record<string, unknown>,
    prDescription: string,
  ): Promise<boolean> {
    try {
      await this.submitLibraryRequest(item, false, packageJsonPatch, prDescription);
      return true;
    } catch (error) {
      if (this.isExistingLibrarySubmissionError(error)) {
        const confirmed = await this.confirmExistingLibrarySubmission(item, error);
        if (!confirmed) {
          return false;
        }

        await this.submitLibraryRequest(item, true, packageJsonPatch, prDescription);
        return true;
      }

      throw error;
    }
  }

  private isPackageNameUnavailableError(error: unknown): boolean {
    const apiError = error as Partial<LibrarySubmissionApiError>;
    if (apiError.submittedByCurrentUser === true) {
      return false;
    }
    if (apiError.submittedByCurrentUser === false) {
      return true;
    }

    const message = (apiError.message || '').toLowerCase();
    const messageIndicatesNameUnavailable =
      /already exists|already submitted|pending submission|name conflict|same name|package name|another user|other user|not your|not owned|已存在|已提交|待审核|待处理|同名|占用|其他用户|别人|不是本人|非本人|不属于你/.test(message);

    if (messageIndicatesNameUnavailable) {
      return true;
    }

    if (apiError.status !== 409 && apiError.status !== 400 && apiError.status !== 422) {
      return false;
    }

    const conflictCodes = new Set([
      'library_already_exists',
      'library_name_already_exists',
      'library_package_name_exists',
      'library_package_name_conflict',
      'library_submission_name_conflict',
      'library_submission_package_name_conflict',
      'library_submission_already_exists',
      'library_submission_package_already_exists',
      'library_submission_pending',
      'library_submitted_by_other_user',
      'library_submission_submitted_by_other_user',
      'library_submission_not_owner',
      'library_submission_not_owned_by_current_user',
    ]);

    if (apiError.errorCode && conflictCodes.has(apiError.errorCode)) {
      return true;
    }

    return apiError.errorCode === 'library_submission_already_submitted' && !apiError.submission;
  }

  private getPackageNameUnavailableMessage(error: unknown, packageName: string): string {
    const baseMessage = packageName
      ? `库名 ${packageName} 已被其他用户发布或占用，请修改库名后再发布。`
      : '该库名已被其他用户发布或占用，请修改库名后再发布。';

    return baseMessage;
  }

  private async submitLibraryRequest(
    item: BlocklyToolboxFacadeItem,
    confirmExisting: boolean,
    packageJsonPatch: Record<string, unknown>,
    prDescription: string,
  ): Promise<void> {
    const loadingMessage = this.message.loading(this.translate.instant('LIBRARY_PUBLISH.SUBMITTING', {
      name: this.getLibraryDisplayName(item),
    }), { nzDuration: 0 });
    try {
      await firstValueFrom(this.librarySubmissionService.submitLocalLibraryByRef({
        name: item.libraryName || '',
        path: item.libraryPath || '',
        source: 'declared',
      }, confirmExisting, packageJsonPatch, prDescription));
    } finally {
      if (loadingMessage.messageId) {
        this.message.remove(loadingMessage.messageId);
      }
    }
  }

  private showLibrarySubmissionSuccessMessage(item: BlocklyToolboxFacadeItem, packageJsonPatch?: Record<string, unknown>): void {
    this.lastSubmittedLibraryDisplayName = String(packageJsonPatch?.['nickname'] || packageJsonPatch?.['name'] || this.getLibraryDisplayName(item));
    const content = this.librarySubmissionSuccessTpl
      ?? `${this.getLibraryDisplayName(item)} 提交已受理，系统将自动创建 PR。你可以稍后在用户中心查看提交状态。`;
    this.message.success(content, { nzDuration: 8000 });
  }

  openLibrarySubmissionsInUserCenter(event?: MouseEvent): void {
    event?.preventDefault();
    event?.stopPropagation();

    if (!this.authService.isLoggedIn) {
      this.uiService.openTool('user-center');
      return;
    }

    const loadingMessage = this.message.loading('正在打开用户中心...', { nzDuration: 0 });
    this.authService.generateSSOToken('/user/library-submissions')
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          if (loadingMessage.messageId) {
            this.message.remove(loadingMessage.messageId);
          }
          if (response?.target_url) {
            this.electronService.openUrl(response.target_url);
            return;
          }
          this.uiService.openTool('user-center');
          this.message.warning('已打开用户中心，可在库提交记录页查看');
        },
        error: (error) => {
          if (loadingMessage.messageId) {
            this.message.remove(loadingMessage.messageId);
          }
          console.error('打开库提交记录失败:', error);
          this.uiService.openTool('user-center');
          this.message.error('库提交记录页打开失败，已为你打开用户中心');
        },
      });
  }

  private isExistingLibrarySubmissionError(error: unknown): boolean {
    const apiError = error as Partial<LibrarySubmissionApiError>;
    if (apiError.submittedByCurrentUser === true) {
      return true;
    }
    if (apiError.submittedByCurrentUser === false) {
      return false;
    }

    return apiError.status === 409
      && apiError.errorCode === 'library_submission_already_submitted'
      && !!apiError.submission;
  }

  private confirmExistingLibrarySubmission(item: BlocklyToolboxFacadeItem, error: unknown): Promise<boolean> {
    const apiError = error as Partial<LibrarySubmissionApiError>;
    const prNumber = apiError.submission?.pr_number;
    const extra = prNumber
      ? this.translate.instant('LIBRARY_PUBLISH.EXISTING_WITH_PR', { prNumber })
      : this.translate.instant('LIBRARY_PUBLISH.EXISTING_NO_PR');
    const actionText = apiError.sameContent
      ? this.translate.instant('LIBRARY_PUBLISH.EXISTING_SAME_CONTENT')
      : this.translate.instant('LIBRARY_PUBLISH.EXISTING_UPDATE_CONTENT');
    return this.openLibraryPublishConfirmDialog({
      title: this.translate.instant('LIBRARY_PUBLISH.EXISTING_TITLE'),
      content: `${extra}${actionText}`,
      okText: this.translate.instant('LIBRARY_PUBLISH.EXISTING_OK'),
      cancelText: this.translate.instant('LIBRARY_PUBLISH.EXISTING_CANCEL'),
    });
  }

  private openLibraryPublishConfirmDialog(data: LibraryPublishConfirmDialogData): Promise<boolean> {
    return new Promise((resolve) => {
      const modalRef = this.modal.create({
        nzClassName: 'library-publish-modal',
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzWidth: '526px',
        nzMaskStyle: { background: 'transparent' },
        nzContent: LibraryPublishConfirmDialogComponent,
        nzData: data,
      });

      modalRef.afterClose.subscribe(result => resolve(result?.result === true));
    });
  }

  private async ensureLibrarySubmissionReady(): Promise<boolean> {
    const isLoggedIn = await this.authService.checkAndSyncAuthStatus();
    if (!isLoggedIn) {
      this.promptLoginForLibrarySubmission();
      return false;
    }

    if (await this.hasGithubLibraryPrPermission()) {
      return true;
    }
    return this.promptGithubBindForLibrarySubmission();
  }

  private async hasGithubLibraryPrPermission(): Promise<boolean> {
    try {
      const permissions = await firstValueFrom(this.authService.getGithubPermissions());
      return this.authService.hasGithubLibraryPrPermissionStatus(permissions);
    } catch (error) {
      console.warn('检查 GitHub PR 提交权限失败:', error);
      return false;
    }
  }

  private promptLoginForLibrarySubmission() {
    this.openLibraryPublishConfirmDialog({
      title: '登录后上传库',
      content: '上传库会使用你的 GitHub 账号向官方库仓库提交 PR。请先登录并绑定 GitHub。',
      okText: '打开用户中心',
      cancelText: '取消',
    }).then(confirmed => {
      if (confirmed) {
        this.uiService.openTool('user-center');
      }
    });
  }

  private async promptGithubBindForLibrarySubmission(): Promise<boolean> {
    const confirmed = await this.openLibraryPublishConfirmDialog({
      title: '授权 GitHub PR 提交权限',
      content: '上传库需要使用你的 GitHub 账号向官方库仓库提交 PR。请授权 repo 权限，完成后会自动继续本次上传。',
      okText: '去授权',
      cancelText: '取消',
    });

    if (!confirmed) {
      return false;
    }

    return new Promise((resolve) => {
      this.startGithubBindForLibrarySubmission(resolve);
    });
  }

  private startGithubBindForLibrarySubmission(resolve: (ready: boolean) => void) {
    const timer = setTimeout(() => {
      subscription.unsubscribe();
      resolve(false);
    }, 5 * 60 * 1000);

    const subscription = this.authService.githubBindCompleted$.subscribe(async () => {
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve(await this.hasGithubLibraryPrPermission());
    });

    this.authService.startGitHubLibraryPrSubmitOAuth().subscribe({
      next: (response) => {
        this.electronService.openUrl(response.authorization_url);
        this.message.info('请在浏览器中完成 GitHub PR 提交授权，授权完成后会自动继续上传');
      },
      error: (error) => {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve(false);
        this.message.error(this.getErrorMessage(error, '启动 GitHub 绑定失败'));
      },
    });
  }

  private getLibrarySubmissionErrorMessage(error: unknown): string {
    const apiError = error as Partial<LibrarySubmissionApiError>;
    const message = apiError.message || this.getErrorMessage(error, '库提交失败');
    const requestId = apiError.errorArgs?.['githubRequestId'];
    const suffix = typeof requestId === 'string' && requestId
      ? `（GitHub Request ID: ${requestId}）`
      : '';
    if (this.isGithubBindingRequiredError(error)) {
      return `${message}，请升级 GitHub PR 提交权限后重试${suffix}`;
    }
    return `${message}${suffix}`;
  }

  private async removeLibrary(item: BlocklyToolboxFacadeItem) {
    const libraryName = item.libraryName;
    const libraryPath = item.libraryPath;
    if (!libraryName || !libraryPath || this.removingLibraryNames.has(libraryName)) {
      return;
    }

    if (this.blocklyService.isLibraryUsedByCurrentProject(libraryPath)) {
      this.message.warning(this.translate.instant('LIB_MANAGER.LIB_IN_USE'), { nzDuration: 5000 });
      return;
    }

    this.removingLibraryNames.add(libraryName);
    const workflowStarted = this.workflowService.startInstall();
    let libraryRemoved = false;

    try {
      this.message.loading(`${this.getLibraryDisplayName(item)} ${this.translate.instant('LIB_MANAGER.UNINSTALLING')}...`);
      this.blocklyService.removeLibrary(libraryPath);
      libraryRemoved = true;

      const { code, stderr } = await this.cmdService.runAsync(`npm uninstall ${libraryName}`, this.projectService.currentProjectPath);
      if (code !== 0) {
        throw new Error(stderr || `退出码: ${code}`);
      }

      this.message.success(`${this.getLibraryDisplayName(item)} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
      if (workflowStarted) {
        this.workflowService.finishInstall(true);
      }
    } catch (error) {
      const errorMessage = this.getErrorMessage(error, 'Uninstall failed');
      if (libraryRemoved) {
        await this.blocklyService.loadLibrary(libraryName, this.projectService.currentProjectPath);
      }
      this.message.error(`${this.getLibraryDisplayName(item)} ${this.translate.instant('NPM.UNINSTALL_FAILED_TITLE')}: ${errorMessage}`);
      if (workflowStarted) {
        this.workflowService.finishInstall(false, errorMessage);
      }
    } finally {
      this.removingLibraryNames.delete(libraryName);
      this.cdr.markForCheck();
    }
  }

  private getLibraryDisplayName(item: BlocklyToolboxFacadeItem): string {
    return item.name || item.libraryName || '';
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    let message = extractApiErrorDetails(error, fallback).message || fallback;
    if (error instanceof Error && error.message) {
      message = error.message;
    } else if (typeof error === 'string' && error) {
      message = error;
    }

    return message.length > 240 ? `${message.slice(0, 240)}...` : message;
  }

  private findItemByKey(itemKey: string, items: BlocklyToolboxFacadeItem[]): BlocklyToolboxFacadeItem | null {
    for (const item of items) {
      if (item.key === itemKey) {
        return item;
      }

      const child = this.findItemByKey(itemKey, item.children);
      if (child) {
        return child;
      }
    }

    return null;
  }
}
