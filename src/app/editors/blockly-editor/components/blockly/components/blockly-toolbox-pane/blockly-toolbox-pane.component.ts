import { CommonModule } from '@angular/common';
import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostBinding, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import {
  BLOCKLY_TOOLBOX_SEARCH_KEY,
  BlocklyService,
  BlocklyToolboxFacadeItem,
} from '../../../../services/blockly.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MenuComponent } from '../../../../../../components/menu/menu.component';
import { IMenuItem } from '../../../../../../configs/menu.config';
import { ElectronService } from '../../../../../../services/electron.service';
import { ProjectService } from '../../../../../../services/project.service';
import { CmdService } from '../../../../../../services/cmd.service';
import { WorkflowService } from '../../../../../../services/workflow.service';
import { UiService } from '../../../../../../services/ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
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
  private sortableInstances = new Map<HTMLElement, Sortable>();
  private sortableSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverSuppressPointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  private dragSorting = false;
  private lastDragEndAt = 0;
  private readonly toolboxOrderPackageKey = 'blocklyToolboxOrder';

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
    private message: NzMessageService,
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
    let message = fallback;
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
