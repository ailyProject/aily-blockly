import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, EventEmitter, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
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
import { NzMessageService } from 'ng-zorro-antd/message';

interface ToolboxContextMenuAction {
  name: string;
  action: string;
  icon: string;
  handler: (item: BlocklyToolboxFacadeItem) => void | Promise<void>;
  disabled?: (item: BlocklyToolboxFacadeItem) => boolean;
}

@Component({
  selector: 'app-blockly-toolbox-pane',
  imports: [CommonModule, TranslateModule, MenuComponent],
  templateUrl: './blockly-toolbox-pane.component.html',
  styleUrl: './blockly-toolbox-pane.component.scss',
})
export class BlocklyToolboxPaneComponent implements OnInit, OnDestroy {
  @Output() libraryManagerRequested = new EventEmitter<void>();

  readonly searchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  items: BlocklyToolboxFacadeItem[] = [];
  selectedKey: string | null = null;
  searchQuery = '';
  showContextMenu = false;
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
    private message: NzMessageService,
    private translate: TranslateService,
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
        });
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
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
    this.contextMenuItems = this.toolboxContextMenuActions.map(action => ({
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

  private hasLibraryContextMenu(item: BlocklyToolboxFacadeItem): boolean {
    return !!item.libraryName && !!item.libraryPath;
  }

  private openLibraryPath(item: BlocklyToolboxFacadeItem) {
    if (!item.libraryPath) {
      return;
    }

    this.electronService.openByExplorer(item.libraryPath);
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
