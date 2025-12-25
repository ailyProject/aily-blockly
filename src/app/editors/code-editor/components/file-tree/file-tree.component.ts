import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { CollectionViewer, DataSource, SelectionChange } from '@angular/cdk/collections';
import { FlatTreeControl } from '@angular/cdk/tree';
import { SelectionModel } from '@angular/cdk/collections';
import { NzTreeViewModule } from 'ng-zorro-antd/tree-view';
import { NzMessageService } from 'ng-zorro-antd/message';
import { FileService } from '../../services/file.service';
import { CommonModule } from '@angular/common';
import { BehaviorSubject, Observable, merge } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { MenuComponent } from '../../../../components/menu/menu.component';
import {
  FILE_RIGHTCLICK_MENU,
  FOLDER_RIGHTCLICK_MENU,
  ROOT_RIGHTCLICK_MENU,
  MULTI_SELECT_MENU
} from './menu.config';
import { IMenuItem } from '../../../../configs/menu.config';

// 文件节点接口定义
interface FileNode {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNode[];
}

// 原始文件节点接口
interface FileNodeOrig {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNodeOrig[];
}

// 扁平化的文件节点接口
interface FlatFileNode extends FileNode {
  expandable: boolean;
  level: number;
  loading?: boolean;
}

// 内联编辑状态
interface InlineEditState {
  isEditing: boolean;
  nodeKey: string;
  editType: 'rename' | 'newFile' | 'newFolder';
  originalValue?: string;
  parentPath?: string;
}

// 动态数据源类
class DynamicFileDataSource implements DataSource<FlatFileNode> {
  private flattenedData: BehaviorSubject<FlatFileNode[]>;
  private childrenLoadedSet = new Set<FlatFileNode>();
  private expandedPaths = new Set<string>(); // 保存展开的节点路径

  constructor(
    private treeControl: FlatTreeControl<FlatFileNode>,
    private fileService: FileService,
    initData: FlatFileNode[]
  ) {
    this.flattenedData = new BehaviorSubject<FlatFileNode[]>(initData);
    treeControl.dataNodes = initData;
  }

  connect(collectionViewer: CollectionViewer): Observable<FlatFileNode[]> {
    const changes = [
      collectionViewer.viewChange,
      this.treeControl.expansionModel.changed.pipe(tap(change => this.handleExpansionChange(change))),
      this.flattenedData.asObservable()
    ];
    return merge(...changes).pipe(map(() => this.expandFlattenedNodes(this.flattenedData.getValue())));
  }

  expandFlattenedNodes(nodes: FlatFileNode[]): FlatFileNode[] {
    const treeControl = this.treeControl;
    const results: FlatFileNode[] = [];
    const currentExpand: boolean[] = [];
    currentExpand[0] = true;

    nodes.forEach(node => {
      let expand = true;
      for (let i = 0; i <= treeControl.getLevel(node); i++) {
        expand = expand && currentExpand[i];
      }
      if (expand) {
        results.push(node);
      }
      if (treeControl.isExpandable(node)) {
        currentExpand[treeControl.getLevel(node) + 1] = treeControl.isExpanded(node);
      }
    });
    return results;
  }

  handleExpansionChange(change: SelectionChange<FlatFileNode>): void {
    if (change.added) {
      change.added.forEach(node => this.loadChildren(node));
    }
  }

  loadChildren(node: FlatFileNode): void {
    if (this.childrenLoadedSet.has(node)) {
      return;
    }
    node.loading = true;

    // 使用 fileService 加载子文件夹内容
    const children = this.fileService.readDir(node.path);
    const flatChildren: FlatFileNode[] = children.map(child => ({
      expandable: !child.isLeaf,
      title: child.title,
      level: node.level + 1,
      key: child.key,
      isLeaf: child.isLeaf,
      path: child['path']
    }));

    node.loading = false;
    const flattenedData = this.flattenedData.getValue();
    const index = flattenedData.indexOf(node);
    if (index !== -1) {
      flattenedData.splice(index + 1, 0, ...flatChildren);
      this.childrenLoadedSet.add(node);
    }
    this.flattenedData.next(flattenedData);
  }

  disconnect(): void {
    this.flattenedData.complete();
  }

  // 更新根数据
  setRootData(data: FlatFileNode[]): void {
    this.childrenLoadedSet.clear();
    this.flattenedData.next(data);
    this.treeControl.dataNodes = data;
  }

  // 获取当前数据
  getCurrentData(): FlatFileNode[] {
    return this.flattenedData.getValue();
  }

  // 保存当前展开状态
  saveExpandedState(): void {
    this.expandedPaths.clear();
    const expandedNodes = this.treeControl.expansionModel.selected;
    expandedNodes.forEach(node => {
      this.expandedPaths.add(node.path);
    });
  }

  // 恢复展开状态
  restoreExpandedState(): void {
    const allNodes = this.flattenedData.getValue();
    setTimeout(() => {
      allNodes.forEach(node => {
        if (this.expandedPaths.has(node.path) && node.expandable) {
          this.treeControl.expand(node);
        }
      });
    }, 0);
  }

  // 增量更新节点
  updateNode(path: string, updateFn: (node: FlatFileNode) => void): void {
    const data = this.flattenedData.getValue();
    const node = data.find(n => n.path === path);
    if (node) {
      updateFn(node);
      this.flattenedData.next([...data]);
    }
  }

  // 添加新节点
  addNode(parentPath: string, newNode: FlatFileNode): void {
    const data = this.flattenedData.getValue();
    const parentIndex = data.findIndex(n => n.path === parentPath);

    if (parentIndex !== -1) {
      // 找到插入位置（在同级节点的最后）
      let insertIndex = parentIndex + 1;
      const parentLevel = data[parentIndex].level;

      // 找到同级节点的最后位置
      while (insertIndex < data.length && data[insertIndex].level > parentLevel) {
        insertIndex++;
      }

      data.splice(insertIndex, 0, newNode);
      this.flattenedData.next([...data]);
    }
  }

  // 删除节点（包括子节点）
  removeNode(nodePath: string): void {
    const data = this.flattenedData.getValue();
    const nodeIndex = data.findIndex(n => n.path === nodePath);

    console.log('DynamicFileDataSource.removeNode called for:', nodePath);
    console.log('Node found at index:', nodeIndex);

    if (nodeIndex !== -1) {
      const node = data[nodeIndex];
      const nodesToRemove = [nodeIndex];

      console.log('Removing node:', node.title, 'expandable:', node.expandable);

      // 如果是文件夹，也要删除所有子节点
      if (node.expandable) {
        for (let i = nodeIndex + 1; i < data.length; i++) {
          if (data[i].level > node.level) {
            nodesToRemove.push(i);
            console.log('Also removing child node:', data[i].title);
          } else {
            break;
          }
        }
      }

      console.log('Total nodes to remove:', nodesToRemove.length);

      // 从后往前删除，避免索引问题
      nodesToRemove.reverse().forEach(index => {
        const removedNode = data[index];
        console.log('Removing node at index', index, ':', removedNode.title);
        data.splice(index, 1);
      });

      console.log('Updating flattenedData with new array, length:', data.length);
      this.flattenedData.next([...data]);

      // 更新树控件的数据节点
      this.treeControl.dataNodes = [...data];

      // 清除相关的展开状态
      this.expandedPaths.delete(nodePath);
      this.childrenLoadedSet.forEach(loadedNode => {
        if (loadedNode.path === nodePath) {
          this.childrenLoadedSet.delete(loadedNode);
        }
      });

      console.log('Node removal completed for:', nodePath);
    } else {
      console.warn('Node not found for removal:', nodePath);
    }
  }

  // 智能刷新指定路径的内容
  refreshPath(path: string): void {
    const data = this.flattenedData.getValue();
    const nodeIndex = data.findIndex(n => n.path === path);

    if (nodeIndex !== -1) {
      const node = data[nodeIndex];
      if (node.expandable) {
        // 获取新的文件列表
        const children = this.fileService.readDir(path);
        const flatChildren: FlatFileNode[] = children.map(child => ({
          expandable: !child.isLeaf,
          title: child.title,
          level: node.level + 1,
          key: child.key,
          isLeaf: child.isLeaf,
          path: child['path']
        }));

        // 删除旧的子节点
        let deleteCount = 0;
        for (let i = nodeIndex + 1; i < data.length; i++) {
          if (data[i].level > node.level) {
            deleteCount++;
          } else {
            break;
          }
        }

        // 用新的子节点替换
        data.splice(nodeIndex + 1, deleteCount, ...flatChildren);
        this.flattenedData.next([...data]);

        // 标记子节点已加载
        this.childrenLoadedSet.add(node);
      }
    }
    // 注意：如果节点不在当前数据中，调用者应该处理刷新逻辑
  }

  /**
   * 清除节点的子节点缓存
   * 当文件夹内容发生变化但文件夹是折叠状态时，需要清除缓存
   * 这样当用户展开文件夹时，会重新从文件系统加载最新内容
   */
  clearNodeCache(nodePath: string): void {
    const data = this.flattenedData.getValue();
    const node = data.find(n => n.path === nodePath);
    
    if (node) {
      // 从缓存集合中移除该节点
      this.childrenLoadedSet.delete(node);
      console.log('已清除节点缓存:', nodePath);
    }
  }
}

@Component({
  selector: 'app-file-tree',
  imports: [
    NzTreeViewModule,
    CommonModule,
    MenuComponent
  ],
  templateUrl: './file-tree.component.html',
  styleUrl: './file-tree.component.scss'
})
export class FileTreeComponent implements OnInit {

  @Input() rootPath: string;
  @Input() selectedFile;
  @Output() selectedFileChange = new EventEmitter();
  @Output() filesDeleted = new EventEmitter<string[]>();

  isLoading = false;

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  // 选择模型 - 用于跟踪选中的节点
  nodeSelection = new SelectionModel<FlatFileNode>(true); // 允许多选

  // 最后一次点击的节点，用于 Shift 范围选择
  private lastClickedNode: FlatFileNode | null = null;

  // 树控件 - 使用 FlatTreeControl
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - 已知的弃用警告，等待 ng-zorro-antd 更新
  treeControl = new FlatTreeControl<FlatFileNode>(
    node => node.level,
    node => node.expandable
  );

  // 动态数据源
  dataSource: DynamicFileDataSource;

  // 显示右键菜单
  showRightClickMenu = false;
  rightClickMenuPosition = { x: null, y: null };
  configList: IMenuItem[] = [];
  currentSelectedNode: FlatFileNode | null = null;

  // 内联编辑状态
  inlineEditState: InlineEditState = {
    isEditing: false,
    nodeKey: '',
    editType: 'rename'
  };

  // 常量定义
  private readonly TIMING = {
    DOM_UPDATE: 0,           // DOM 更新延迟
    FOLDER_EXPAND: 50,       // 文件夹展开延迟
    DEFAULT_FILE_SELECT: 100, // 默认文件选择延迟
    FOCUS_RETRY: 50,         // 焦点重试延迟
    DRAG_SCROLL_DELAY: 300,  // 拖拽滚动延迟
    AUTO_EXPAND_DELAY: 800   // 拖拽自动展开延迟
  };

  private readonly TEMP_NODE_PREFIX = {
    FILE: '__new_file_temp_',
    FOLDER: '__new_folder_temp_'
  };

  // 拖拽相关状态
  dragState = {
    isDragging: false,
    draggedNodes: [] as FlatFileNode[],
    dragOverNode: null as FlatFileNode | null,
    dropPosition: null as 'before' | 'after' | 'inside' | null,
    isExternalDrag: false
  };

  // 拖拽自动展开定时器
  private dragExpandTimer: any = null;
  // 拖拽滚动定时器
  private dragScrollTimer: any = null;

  constructor(
    private fileService: FileService,
    private message: NzMessageService
  ) {
    // 初始化时创建空的数据源
    this.dataSource = new DynamicFileDataSource(this.treeControl, this.fileService, []);
  }

  ngOnInit() {
    // 延迟加载文件树，优先让UI渲染
    setTimeout(() => {
      this.loadRootPath();
    }, this.TIMING.DOM_UPDATE);
  }

  ngAfterViewInit() {
    // 延迟选择默认文件，确保文件树已加载
    setTimeout(() => {
      this.selectDefaultInoFile();
    }, this.TIMING.DEFAULT_FILE_SELECT);
  }

  /**
   * 选择默认的 .ino 文件
   */
  private selectDefaultInoFile(): void {
    const files = this.dataSource.getCurrentData();
    const inoFile = files.find(f => f.isLeaf && f.title.endsWith('.ino'));
    if (inoFile) {
      this.openFile(inoFile);
    }
  }

  /**
   * 根据文件路径选中节点
   * @param filePath 文件路径
   */
  selectNodeByPath(filePath: string): void {
    if (!filePath) {
      return;
    }

    const allNodes = this.dataSource.getCurrentData();
    const targetNode = allNodes.find(node => node.path === filePath);

    if (targetNode) {
      // 清除当前选择
      this.nodeSelection.clear();
      // 选中目标节点
      this.nodeSelection.select(targetNode);
      this.lastClickedNode = targetNode;
    }
  }

  loadRootPath(path = this.rootPath): void {
    // 保存当前展开状态
    if (this.dataSource) {
      this.dataSource.saveExpandedState();
    }
    const files = this.fileService.readDir(path);
    // 转换为扁平节点格式
    const flatFiles: FlatFileNode[] = files.map(file => ({
      expandable: !file.isLeaf,
      title: file.title,
      level: 0,
      key: file.key,
      isLeaf: file.isLeaf,
      path: file['path']
    }));

    this.dataSource.setRootData(flatFiles);

    // 恢复展开状态
    this.dataSource.restoreExpandedState();
  }

  // 判断节点是否有子节点
  hasChild = (_: number, node: FlatFileNode): boolean => node.expandable;

  // 当节点被点击时
  nodeClick(node: FlatFileNode, event?: MouseEvent): void {
    // 如果正在编辑，不处理点击事件
    if (this.isNodeEditing(node)) {
      return;
    }

    // 处理多选逻辑
    this.handleNodeSelection(node, event);

    // 如果是文件且只选择了一个，则打开文件
    if (node.isLeaf && this.nodeSelection.selected.length === 1 && this.nodeSelection.isSelected(node)) {
      this.openFile(node);
    } else if (!node.isLeaf && this.nodeSelection.selected.length === 1 && this.nodeSelection.isSelected(node)) {
      // 如果是文件夹且只选择了一个，则展开/收起
      this.openFolder(node);
    }
  }

  // 处理节点选择逻辑
  private handleNodeSelection(node: FlatFileNode, event?: MouseEvent): void {
    const isCtrlPressed = event?.ctrlKey || event?.metaKey; // Mac 用 metaKey
    const isShiftPressed = event?.shiftKey;

    if (isShiftPressed && this.lastClickedNode) {
      // Shift + 点击：范围选择
      this.selectRange(this.lastClickedNode, node);
    } else if (isCtrlPressed) {
      // Ctrl + 点击：切换选择状态
      this.nodeSelection.toggle(node);
      this.lastClickedNode = node;
    } else {
      // 普通点击：清除其他选择，只选择当前节点
      this.nodeSelection.clear();
      this.nodeSelection.select(node);
      this.lastClickedNode = node;
    }
  }

  // 范围选择：选择两个节点之间的所有节点
  private selectRange(startNode: FlatFileNode, endNode: FlatFileNode): void {
    const allNodes = this.dataSource.getCurrentData();
    const startIndex = allNodes.indexOf(startNode);
    const endIndex = allNodes.indexOf(endNode);

    if (startIndex === -1 || endIndex === -1) {
      return;
    }

    // 确保 start <= end
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);

    // 清除当前选择
    this.nodeSelection.clear();

    // 选择范围内的所有节点
    for (let i = minIndex; i <= maxIndex; i++) {
      this.nodeSelection.select(allNodes[i]);
    }
  }

  menuList;
  onRightClick(event: MouseEvent, node: FlatFileNode = null) {
    event.preventDefault(); // 阻止浏览器默认右键菜单

    // 如果是在文件或文件夹节点上右键，阻止事件冒泡
    if (node) {
      event.stopPropagation();
    }

    // 处理右键点击时的选择逻辑
    if (node) {
      // 如果右键点击的节点没有被选中，则清除其他选择并选择当前节点
      if (!this.nodeSelection.isSelected(node)) {
        this.nodeSelection.clear();
        this.nodeSelection.select(node);
        this.lastClickedNode = node;
      }
    }

    const selectedNodes = this.nodeSelection.selected;
    const selectedCount = selectedNodes.length;

    if (!node) {
      // 右键点击空白区域
      this.currentSelectedNode = this.createRootNode();
      this.menuList = ROOT_RIGHTCLICK_MENU;
    } else if (selectedCount > 1) {
      // 多选状态
      this.currentSelectedNode = node;
      this.menuList = MULTI_SELECT_MENU;
    } else if (node.isLeaf) {
      // 单个文件
      this.currentSelectedNode = node;
      this.menuList = FILE_RIGHTCLICK_MENU;
    } else {
      // 单个文件夹
      this.currentSelectedNode = node;
      this.menuList = FOLDER_RIGHTCLICK_MENU;
    }

    // 获取当前鼠标点击位置
    this.rightClickMenuPosition.x = event.clientX;
    this.rightClickMenuPosition.y = event.clientY;

    this.showRightClickMenu = true;
  }

  onMenuItemClick(menuItem: IMenuItem) {
    // console.log('Menu item clicked:', menuItem, 'Node:', this.currentSelectedNode);
    // 隐藏菜单
    this.showRightClickMenu = false;
    // 处理菜单项点击事件
    this.handleMenuAction(menuItem);
  }

  // 创建根节点
  private createRootNode(): FlatFileNode {
    return {
      expandable: true,
      title: 'root',
      level: 0,
      key: 'root',
      isLeaf: false,
      path: this.rootPath
    };
  }

  private handleMenuAction(menuItem: IMenuItem) {
    const selectedNodes = this.nodeSelection.selected;
    // 如果currentSelectedNode为null，则默认操作根目录
    const currentNode = this.currentSelectedNode || this.createRootNode();

    switch (menuItem.action) {
      case 'file-copy':
      case 'folder-copy':
      case 'multi-copy':
        this.copyToClipboard(selectedNodes.length > 1 ? selectedNodes : [currentNode]);
        break;

      case 'file-cut':
      case 'folder-cut':
      case 'multi-cut':
        this.cutToClipboard(selectedNodes.length > 1 ? selectedNodes : [currentNode]);
        break;

      case 'folder-paste':
        this.pasteFromClipboard(currentNode);
        break;

      case 'file-rename':
      case 'folder-rename':
        this.renameNode(currentNode);
        break;

      case 'file-delete':
      case 'folder-delete':
      case 'multi-delete':
        this.deleteNodes(selectedNodes.length > 1 ? selectedNodes : [currentNode]);
        break;

      case 'folder-new-file':
        this.createNewFile(currentNode);
        break;

      case 'folder-new-folder':
        this.createNewFolder(currentNode);
        break;

      case 'file-copy-path':
      case 'folder-copy-path':
        this.copyPathToClipboard(currentNode, false);
        break;

      case 'file-copy-relative-path':
      case 'folder-copy-relative-path':
        this.copyPathToClipboard(currentNode, true);
        break;

      case 'reveal-in-explorer':
        this.revealInExplorer(currentNode);
        break;

      case 'open-in-terminal':
        this.openInTerminal(currentNode);
        break;

      // case 'file-properties':
      // case 'folder-properties':
      //   this.showProperties(currentNode);
      //   break;

      case 'multi-compress':
        this.compressMultipleFiles(selectedNodes);
        break;

      default:
        console.log('Unhandled menu action:', menuItem.action);
    }
  }

  // 菜单操作方法的实现 - 通过FileService调用
  private copyToClipboard(nodes: FlatFileNode[]) {
    this.fileService.copyToClipboard(nodes);
  }

  private cutToClipboard(nodes: FlatFileNode[]) {
    this.fileService.cutToClipboard(nodes);
  }

  private async pasteFromClipboard(targetNode: FlatFileNode) {
    // 获取剪贴板状态，判断是否是剪切操作
    const clipboardStatus = this.fileService.getClipboardStatus();
    const isCutOperation = clipboardStatus.operation === 'cut';

    const result = await this.fileService.pasteFromClipboard(targetNode);
    if (result.success && result.newFiles) {
      // 确定实际的目标路径
      let targetPath = targetNode.path;
      if (targetNode.isLeaf) {
        // 如果是文件，使用其父目录
        targetPath = window['path'].dirname(targetPath);
      }

      // 如果是剪切操作，先从原位置删除文件节点
      if (isCutOperation && clipboardStatus.nodes.length > 0) {
        for (const originalNode of clipboardStatus.nodes) {
          this.removeFileNode(originalNode.path);
        }
      }

      // 增量添加新文件，避免全量刷新
      for (const newFile of result.newFiles) {
        this.addFileNodeDirect(targetPath, newFile.name, newFile.isLeaf);
      }
    }
  }

  private renameNode(node: FlatFileNode) {
    // 使用内联编辑
    this.startInlineEdit(node, 'rename');
  }

  private deleteNodes(nodes: FlatFileNode[]) {
    console.log('Starting delete operation for nodes:', nodes.map(n => n.path));

    this.fileService.deleteNodes(nodes, (deletedPaths: string[]) => {
      this.handleDeleteCallback(deletedPaths);
    });
  }

  /**
   * 处理删除回调
   */
  private handleDeleteCallback(deletedPaths: string[]): void {
    console.log('Delete callback received for paths:', deletedPaths);

    try {
      // 发出文件删除事件，通知父组件
      this.filesDeleted.emit(deletedPaths);

      // 使用增量更新删除节点
      deletedPaths.forEach(path => {
        console.log('Removing node from UI:', path);
        this.removeFileNode(path);
      });

      // 清除已删除节点的选择状态
      this.updateSelectionAfterDelete(deletedPaths);

      console.log('Delete operation completed, UI updated');

      // 验证删除是否成功反映在UI中
      this.verifyDeleteOperation(deletedPaths);

    } catch (error) {
      console.error('Error updating UI after delete:', error);
      // 如果增量更新失败，强制刷新整个树
      this.refresh();
    }
  }

  /**
   * 删除后更新选择状态
   */
  private updateSelectionAfterDelete(deletedPaths: string[]): void {
    const currentSelected = this.nodeSelection.selected.filter(
      node => !deletedPaths.includes(node.path)
    );
    this.nodeSelection.clear();
    currentSelected.forEach(node => {
      this.nodeSelection.select(node);
    });
  }

  /**
   * 验证删除操作是否成功
   */
  private verifyDeleteOperation(deletedPaths: string[]): void {
    setTimeout(() => {
      const currentData = this.dataSource.getCurrentData();
      const stillExists = deletedPaths.some(path =>
        currentData.some(node => node.path === path)
      );

      if (stillExists) {
        console.warn('Some deleted nodes still exist in UI, forcing refresh');
        this.refresh();
      }
    }, this.TIMING.DEFAULT_FILE_SELECT);
  }

  private createNewFile(parentNode: FlatFileNode) {
    this.createNewNode(parentNode, true);
  }

  private createNewFolder(parentNode: FlatFileNode) {
    this.createNewNode(parentNode, false);
  }

  /**
   * 创建新节点（文件或文件夹）
   * @param parentNode 父节点
   * @param isFile 是否为文件
   */
  private createNewNode(parentNode: FlatFileNode, isFile: boolean): void {
    const { parentPath, actualParentNode } = this.resolveParentInfo(parentNode);

    // 如果父节点是文件夹且未展开，先展开它
    this.ensureNodeExpanded(actualParentNode);

    // 等待文件夹展开完成后再创建临时节点
    setTimeout(() => {
      const tempNode = this.createTempNode(parentNode, parentPath, isFile);

      // 添加临时节点到适当位置
      this.addFileNodeDirect(parentPath, tempNode.key.split(/[/\\]/).pop()!, isFile);

      // 开始内联编辑，需要额外延迟以确保DOM完全更新
      setTimeout(() => {
        this.startInlineEdit(tempNode, isFile ? 'newFile' : 'newFolder', parentPath);
      }, this.TIMING.DOM_UPDATE);
    }, this.TIMING.FOLDER_EXPAND);
  }

  /**
   * 解析父节点信息
   */
  private resolveParentInfo(parentNode: FlatFileNode): { parentPath: string; actualParentNode: FlatFileNode } {
    let parentPath = parentNode.path;
    let actualParentNode = parentNode;

    if (parentNode.isLeaf) {
      // 如果选中的是文件，使用其父目录
      parentPath = window['path'].dirname(parentPath);
      // 查找父目录节点
      const parentDirNode = this.dataSource.getCurrentData().find(n => n.path === parentPath);
      if (parentDirNode) {
        actualParentNode = parentDirNode;
      }
    }

    return { parentPath, actualParentNode };
  }

  /**
   * 确保节点已展开
   */
  private ensureNodeExpanded(node: FlatFileNode): void {
    if (node.expandable && !this.treeControl.isExpanded(node)) {
      this.treeControl.expand(node);
    }
  }

  /**
   * 创建临时节点
   */
  private createTempNode(parentNode: FlatFileNode, parentPath: string, isFile: boolean): FlatFileNode {
    const prefix = isFile ? this.TEMP_NODE_PREFIX.FILE : this.TEMP_NODE_PREFIX.FOLDER;
    const tempKey = `${prefix}${Date.now()}__`;
    const tempPath = window['path'].join(parentPath, tempKey);

    return {
      expandable: !isFile,
      title: '',
      level: parentNode.isLeaf ? parentNode.level : parentNode.level + 1,
      key: tempPath,
      isLeaf: isFile,
      path: tempPath
    };
  }

  private copyPathToClipboard(node: FlatFileNode, relative: boolean) {
    this.fileService.copyPathToClipboard(node, relative, this.rootPath);
  }

  private revealInExplorer(node: FlatFileNode) {
    this.fileService.revealInExplorer(node);
  }

  private openInTerminal(node: FlatFileNode) {
    this.fileService.openInTerminal(node);
  }

  private compressMultipleFiles(nodes: FlatFileNode[]) {
    // TODO: 实现多文件压缩功能
    console.log('Compress multiple files:', nodes.map(n => n.path));
    // 这里可以调用 fileService 的压缩方法，或者显示压缩对话框
  }

  // 获取当前数据
  getCurrentData(): FlatFileNode[] {
    return this.dataSource.getCurrentData();
  }

  openFolder(folder: FlatFileNode) {
    // 如果是文件夹，展开或收起
    if (this.treeControl.isExpanded(folder)) {
      this.treeControl.collapse(folder);
    } else {
      this.treeControl.expand(folder);
      // 动态数据源会自动处理子文件夹的加载
    }
  }

  openFile(file: FlatFileNode) {
    this.selectedFile = file.path;
    this.selectedFileChange.emit(file);
  }

  /**
   * 根据文件路径打开文件
   */
  private openFileByPath(filePath: string): void {
    const allNodes = this.dataSource.getCurrentData();
    const fileNode = allNodes.find(node => node.path === filePath && node.isLeaf);

    if (fileNode) {
      // 选中并打开文件
      this.nodeSelection.clear();
      this.nodeSelection.select(fileNode);
      this.lastClickedNode = fileNode;
      this.openFile(fileNode);
    }
  }

  getFileIcon(filename: string): string {
    // 根据文件扩展名返回不同的图标类
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'c': return 'fa-solid fa-c';
      case 'cpp': return 'fa-solid fa-c';
      case 'h': return 'fa-solid fa-h';
      case 'ino': return 'fa-solid fa-infinity main';
      // case 'json': return 'fa-light fa-brackets-curly'
      default: return 'fa-solid fa-file';
    }
  }

  // 检查文件列表是否为空
  isEmpty(): boolean {
    return this.dataSource.getCurrentData().length === 0;
  }

  refresh() {
    // 保存当前选择的路径
    const selectedPaths = this.nodeSelection.selected.map(node => node.path);

    // 保存展开状态，然后重新加载
    this.loadRootPath();

    // 恢复选择状态
    setTimeout(() => {
      this.restoreSelection(selectedPaths);
    }, this.TIMING.DOM_UPDATE);
  }

  // 获取选中节点的数量和类型信息
  getSelectionInfo(): { count: number; files: number; folders: number } {
    const selected = this.nodeSelection.selected;
    return {
      count: selected.length,
      files: selected.filter(node => node.isLeaf).length,
      folders: selected.filter(node => !node.isLeaf).length
    };
  }

  // 清除所有选择
  clearSelection(): void {
    this.nodeSelection.clear();
    this.lastClickedNode = null;
  }

  // 选择所有可见节点
  selectAll(): void {
    const allNodes = this.dataSource.getCurrentData();
    this.nodeSelection.clear();
    allNodes.forEach(node => {
      this.nodeSelection.select(node);
    });
  }

  // 反选当前选择
  invertSelection(): void {
    const allNodes = this.dataSource.getCurrentData();
    const currentSelected = [...this.nodeSelection.selected];

    this.nodeSelection.clear();
    allNodes.forEach(node => {
      if (!currentSelected.includes(node)) {
        this.nodeSelection.select(node);
      }
    });
  }

  // 恢复选择状态
  private restoreSelection(selectedPaths: string[]): void {
    this.nodeSelection.clear();
    const allNodes = this.dataSource.getCurrentData();

    selectedPaths.forEach(path => {
      const node = allNodes.find(n => n.path === path);
      if (node) {
        this.nodeSelection.select(node);
      }
    });
  }

  // 处理键盘事件
  onKeyDown(event: KeyboardEvent): void {
    const isCtrlPressed = event.ctrlKey || event.metaKey;

    switch (event.key) {
      case 'a':
      case 'A':
        if (isCtrlPressed) {
          event.preventDefault();
          this.selectAll();
        }
        break;

      case 'Escape':
        event.preventDefault();
        this.clearSelection();
        break;

      case 'Delete':
        if (this.nodeSelection.selected.length > 0) {
          event.preventDefault();
          this.deleteNodes(this.nodeSelection.selected);
        }
        break;

      case 'F2':
        if (this.nodeSelection.selected.length === 1) {
          event.preventDefault();
          this.renameNode(this.nodeSelection.selected[0]);
        }
        break;

      case 'c':
      case 'C':
        if (isCtrlPressed && this.nodeSelection.selected.length > 0) {
          event.preventDefault();
          this.copyToClipboard(this.nodeSelection.selected);
        }
        break;

      case 'x':
      case 'X':
        if (isCtrlPressed && this.nodeSelection.selected.length > 0) {
          event.preventDefault();
          this.cutToClipboard(this.nodeSelection.selected);
        }
        break;

      case 'v':
      case 'V':
        if (isCtrlPressed) {
          event.preventDefault();
          // 如果有选中的文件夹，粘贴到第一个文件夹；否则粘贴到根目录
          const targetNode = this.nodeSelection.selected.find(node => !node.isLeaf)
            || this.createRootNode();
          this.pasteFromClipboard(targetNode);
        }
        break;
    }
  }

  // 处理内容区域点击事件（用于在空白区域点击时清除选择）
  onContentClick(event: MouseEvent): void {
    // 检查点击的是否是空白区域（没有点击到树节点）
    const target = event.target as HTMLElement;
    if (target.classList.contains('file-explorer-content') ||
      target.classList.contains('sscroll')) {
      // 如果没有按住 Ctrl 或 Shift，清除选择
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
        this.clearSelection();
      }
    }
  }

  // 智能刷新 - 只刷新指定路径的内容
  smartRefresh(targetPath?: string) {
    if (!targetPath) {
      // 如果没有指定路径，刷新根目录
      this.refresh();
      return;
    }

    // 刷新指定路径
    this.dataSource.refreshPath(targetPath);
  }

  // 增量更新 - 添加新文件/文件夹
  addFileNode(parentPath: string, newFileName: string, isLeaf: boolean) {
    const fullPath = window['path'].join(parentPath, newFileName);
    const parentNode = this.dataSource.getCurrentData().find(n => n.path === parentPath);

    if (parentNode) {
      const newNode: FlatFileNode = {
        expandable: !isLeaf,
        title: newFileName,
        level: parentNode.level + 1,
        key: fullPath,
        isLeaf: isLeaf,
        path: fullPath
      };

      this.dataSource.addNode(parentPath, newNode);
    }
  }

  // 直接添加文件节点（不依赖父节点存在）
  addFileNodeDirect(parentPath: string, newFileName: string, isLeaf: boolean) {
    const fullPath = window['path'].join(parentPath, newFileName);
    const data = this.dataSource.getCurrentData();

    // 检查文件是否已存在
    if (this.nodeExists(data, fullPath)) {
      return; // 文件已存在，不重复添加
    }

    const { insertLevel, insertIndex } = this.findInsertPosition(data, parentPath, newFileName, isLeaf);

    if (insertIndex === -1) {
      return; // 插入位置无效
    }

    const newNode = this.createFileNode(newFileName, fullPath, insertLevel, isLeaf);

    // 直接插入到数据中
    data.splice(insertIndex, 0, newNode);
    // 使用flattenedData.next来触发更新，避免完全重置
    this.dataSource['flattenedData'].next([...data]);
  }

  /**
   * 检查节点是否已存在
   */
  private nodeExists(data: FlatFileNode[], path: string): boolean {
    return data.some(n => n.path === path);
  }

  /**
   * 检查父文件夹是否已展开
   * 用于判断是否需要手动添加子节点到树中
   */
  private isParentExpanded(parentPath: string): boolean {
    // 如果是根目录，始终返回 true（根目录总是展开的）
    if (parentPath === this.rootPath) {
      return true;
    }

    // 查找父节点
    const data = this.dataSource.getCurrentData();
    const parentNode = data.find(n => n.path === parentPath);
    
    if (!parentNode) {
      return false; // 父节点不存在，不需要添加
    }

    // 检查父节点是否展开
    return this.treeControl.isExpanded(parentNode);
  }

  /**
   * 查找插入位置
   */
  private findInsertPosition(
    data: FlatFileNode[],
    parentPath: string,
    newFileName: string,
    isLeaf: boolean
  ): { insertLevel: number; insertIndex: number } {
    // 如果是根目录
    if (parentPath === this.rootPath) {
      return this.findRootLevelInsertPosition(data, newFileName, isLeaf);
    }

    // 如果是子目录
    return this.findChildLevelInsertPosition(data, parentPath, newFileName, isLeaf);
  }

  /**
   * 查找根级别插入位置
   */
  private findRootLevelInsertPosition(
    data: FlatFileNode[],
    newFileName: string,
    isLeaf: boolean
  ): { insertLevel: number; insertIndex: number } {
    const insertLevel = 0;
    let insertIndex = data.length; // 默认插入到末尾

    // 按文件类型和字母顺序排序：文件夹在前，文件在后
    for (let i = 0; i < data.length; i++) {
      if (data[i].level === 0) {
        const shouldInsertHere = this.shouldInsertBefore(data[i], newFileName, isLeaf);
        if (shouldInsertHere) {
          insertIndex = i;
          break;
        }
      } else if (data[i].level < 0) {
        // 已经到了下一层，停止
        break;
      }
    }

    return { insertLevel, insertIndex };
  }

  /**
   * 查找子级别插入位置
   */
  private findChildLevelInsertPosition(
    data: FlatFileNode[],
    parentPath: string,
    newFileName: string,
    isLeaf: boolean
  ): { insertLevel: number; insertIndex: number } {
    const parentNodeIndex = data.findIndex(n => n.path === parentPath);

    if (parentNodeIndex === -1) {
      console.warn('Parent node not found:', parentPath);
      return { insertLevel: 0, insertIndex: -1 };
    }

    const parentNode = data[parentNodeIndex];
    const insertLevel = parentNode.level + 1;
    let insertIndex = parentNodeIndex + 1;

    // 找到同级节点的末尾位置，并按照文件类型和字母顺序排序
    while (insertIndex < data.length && data[insertIndex].level > parentNode.level) {
      if (data[insertIndex].level === insertLevel) {
        const shouldInsertHere = this.shouldInsertBefore(data[insertIndex], newFileName, isLeaf);
        if (shouldInsertHere) {
          break;
        }
      }
      insertIndex++;
    }

    return { insertLevel, insertIndex };
  }

  /**
   * 判断是否应该在当前节点之前插入
   * 排序规则：文件夹在前，文件在后；同类型按字母顺序
   */
  private shouldInsertBefore(currentNode: FlatFileNode, newFileName: string, newIsLeaf: boolean): boolean {
    if (newIsLeaf && !currentNode.isLeaf) {
      // 新文件，当前是文件夹，继续查找
      return false;
    } else if (!newIsLeaf && currentNode.isLeaf) {
      // 新文件夹，当前是文件，插入这里
      return true;
    } else {
      // 同类型，按字母顺序
      return currentNode.title > newFileName;
    }
  }

  /**
   * 创建文件节点
   */
  private createFileNode(fileName: string, fullPath: string, level: number, isLeaf: boolean): FlatFileNode {
    return {
      expandable: !isLeaf,
      title: fileName,
      level: level,
      key: fullPath,
      isLeaf: isLeaf,
      path: fullPath
    };
  }

  // 增量更新 - 删除文件/文件夹
  removeFileNode(nodePath: string) {
    console.log('removeFileNode called for:', nodePath);
    const currentData = this.dataSource.getCurrentData();
    console.log('Current data before removal:', currentData.map(n => n.path));

    this.dataSource.removeNode(nodePath);

    const updatedData = this.dataSource.getCurrentData();
    console.log('Current data after removal:', updatedData.map(n => n.path));
  }

  // 增量更新 - 重命名文件/文件夹
  renameFileNode(oldPath: string, newPath: string) {
    this.dataSource.updateNode(oldPath, (node) => {
      node.path = newPath;
      node.key = newPath;
      node.title = window['path'].basename(newPath);
    });
  }

  // ==================== 内联编辑方法 ====================

  // 开始内联编辑
  startInlineEdit(node: FlatFileNode, editType: 'rename' | 'newFile' | 'newFolder', parentPath?: string) {
    // 如果正在编辑其他节点，先取消
    if (this.inlineEditState.isEditing) {
      this.cancelInlineEdit();
    }

    this.inlineEditState = {
      isEditing: true,
      nodeKey: node.key,
      editType: editType,
      originalValue: editType === 'rename' ? node.title : '',
      parentPath: parentPath
    };

    // 延迟到下一个事件循环，确保DOM已更新
    setTimeout(() => {
      this.focusInlineInput();
    }, this.TIMING.DOM_UPDATE);
  }

  // 取消内联编辑
  cancelInlineEdit() {
    if (this.inlineEditState.editType !== 'rename') {
      // 如果是新建操作，需要删除临时节点
      this.removeInlineEditTempNode();
    }

    this.inlineEditState = {
      isEditing: false,
      nodeKey: '',
      editType: 'rename'
    };
  }

  // 完成内联编辑
  finishInlineEdit(inputValue: string) {
    if (!this.inlineEditState.isEditing) {
      return;
    }

    const trimmedValue = inputValue.trim();

    if (!trimmedValue) {
      this.cancelInlineEdit();
      return;
    }

    switch (this.inlineEditState.editType) {
      case 'rename':
        this.performRename(trimmedValue);
        break;
      case 'newFile':
        this.performCreateFile(trimmedValue);
        break;
      case 'newFolder':
        this.performCreateFolder(trimmedValue);
        break;
    }

    this.inlineEditState = {
      isEditing: false,
      nodeKey: '',
      editType: 'rename'
    };
  }

  // 检查节点是否正在编辑
  isNodeEditing(node: FlatFileNode): boolean {
    return this.inlineEditState.isEditing && this.inlineEditState.nodeKey === node.key;
  }

  // 获取编辑时显示的值
  getEditingValue(node: FlatFileNode): string {
    if (this.isNodeEditing(node)) {
      return this.inlineEditState.originalValue || '';
    }
    return node.title;
  }

  // 聚焦到输入框
  private focusInlineInput() {
    const inputElement = document.querySelector('.inline-edit-input') as HTMLInputElement;
    if (inputElement) {
      this.focusAndSelectInput(inputElement);
    } else {
      // 如果没有找到输入框，稍后重试
      this.retryFocusInput();
    }
  }

  /**
   * 聚焦并选择输入框内容
   */
  private focusAndSelectInput(inputElement: HTMLInputElement): void {
    inputElement.focus();

    // 选择文本（对于重命名操作，选择不包括扩展名的部分）
    if (this.inlineEditState.editType === 'rename' && this.inlineEditState.originalValue) {
      this.selectFileName(inputElement, this.inlineEditState.originalValue);
    } else {
      inputElement.select();
    }
  }

  /**
   * 选择文件名（不包括扩展名）
   */
  private selectFileName(inputElement: HTMLInputElement, fileName: string): void {
    const lastDotIndex = fileName.lastIndexOf('.');
    if (lastDotIndex > 0) {
      inputElement.setSelectionRange(0, lastDotIndex);
    } else {
      inputElement.select();
    }
  }

  /**
   * 重试聚焦输入框
   */
  private retryFocusInput(): void {
    console.warn('Inline edit input not found, retrying...');
    setTimeout(() => {
      const retryElement = document.querySelector('.inline-edit-input') as HTMLInputElement;
      if (retryElement) {
        retryElement.focus();
        retryElement.select();
      }
    }, this.TIMING.FOCUS_RETRY);
  }

  // 移除临时节点（用于取消新建操作）
  private removeInlineEditTempNode() {
    if (this.inlineEditState.nodeKey) {
      this.removeFileNode(this.inlineEditState.nodeKey);
    }
  }

  // 执行重命名
  private performRename(newName: string) {
    const node = this.dataSource.getCurrentData().find(n => n.key === this.inlineEditState.nodeKey);
    if (!node) {
      return;
    }

    if (newName === this.inlineEditState.originalValue) {
      // 名称没有变化，直接结束
      return;
    }

    // 验证文件名
    const validation = this.fileService.validateFileName(newName);
    if (!validation.valid) {
      this.message.error(validation.error);
      return;
    }

    const result = this.fileService.renameNodeInline(node.path, newName);
    if (result.success) {
      this.message.success('重命名成功');

      // 更新节点信息
      this.renameFileNode(node.path, result.newPath);

      // 更新选择状态中的节点路径
      if (this.nodeSelection.isSelected(node)) {
        node.path = result.newPath;
        node.key = result.newPath;
        node.title = newName;
      }
    } else {
      this.message.error(result.error);
    }
  }

  // 执行创建文件
  private performCreateFile(fileName: string) {
    if (!this.inlineEditState.parentPath) {
      return;
    }

    const result = this.fileService.createFileInline(this.inlineEditState.parentPath, fileName);

    if (result.success) {
      this.message.success('文件创建成功');
      // 更新临时节点为实际节点
      this.updateTempNodeToReal(fileName, result.filePath, true);

      // 自动打开新创建的文件
      setTimeout(() => {
        this.openFileByPath(result.filePath);
      }, this.TIMING.DOM_UPDATE);
    } else {
      this.message.error(result.error);
      this.removeInlineEditTempNode();
    }
  }

  // 执行创建文件夹
  private performCreateFolder(folderName: string) {
    if (!this.inlineEditState.parentPath) {
      return;
    }

    const result = this.fileService.createFolderInline(this.inlineEditState.parentPath, folderName);

    if (result.success) {
      this.message.success('文件夹创建成功');
      // 更新临时节点为实际节点
      this.updateTempNodeToReal(folderName, result.folderPath, false);
    } else {
      this.message.error(result.error);
      this.removeInlineEditTempNode();
    }
  }

  // 将临时节点更新为实际节点
  private updateTempNodeToReal(name: string, realPath: string, isLeaf: boolean) {
    this.dataSource.updateNode(this.inlineEditState.nodeKey, (node) => {
      node.title = name;
      node.path = realPath;
      node.key = realPath;
      node.isLeaf = isLeaf;
      node.expandable = !isLeaf;
    });
  }

  // 处理输入框的键盘事件
  onInlineEditKeyDown(event: KeyboardEvent, inputElement: HTMLInputElement) {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        this.finishInlineEdit(inputElement.value);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.cancelInlineEdit();
        break;
    }
  }

  // 处理输入框失去焦点
  onInlineEditBlur(inputElement: HTMLInputElement) {
    // 延迟一小段时间，允许其他事件（如Enter键）先处理
    setTimeout(() => {
      if (this.inlineEditState.isEditing) {
        this.finishInlineEdit(inputElement.value);
      }
    }, 100);
  }

  // ==================== 拖拽功能实现 ====================

  /**
   * 开始拖拽节点
   */
  onDragStart(event: DragEvent, node: FlatFileNode): void {
    // 如果正在编辑，不允许拖拽
    if (this.inlineEditState.isEditing) {
      event.preventDefault();
      return;
    }

    // 如果拖拽的节点没有被选中，则只拖拽当前节点
    if (!this.nodeSelection.isSelected(node)) {
      this.nodeSelection.clear();
      this.nodeSelection.select(node);
    }

    // 设置拖拽状态
    this.dragState.isDragging = true;
    this.dragState.draggedNodes = [...this.nodeSelection.selected];
    this.dragState.isExternalDrag = false;

    // 获取所有拖拽的文件路径
    const filePaths = this.dragState.draggedNodes.map(n => n.path);

    // 设置拖拽数据（用于内部拖拽）
    const dragData = {
      type: 'internal',
      nodes: this.dragState.draggedNodes.map(n => ({
        path: n.path,
        title: n.title,
        isLeaf: n.isLeaf
      }))
    };

    event.dataTransfer!.effectAllowed = 'copyMove';
    event.dataTransfer!.setData('application/json', JSON.stringify(dragData));

    // ⭐ 关键：为了支持拖拽到外部应用，需要设置正确的数据格式
    
    // 方法 1: 设置文本格式（文件路径）
    event.dataTransfer!.setData('text/plain', filePaths.join('\n'));
    
    // 方法 2: 设置 DownloadURL 格式（适用于单个文件）
    // 格式：MIME:name:url
    if (filePaths.length === 1) {
      const filePath = filePaths[0];
      const fileName = window['path'].basename(filePath);
      
      // 读取文件内容并创建 Blob URL（用于拖拽到浏览器等）
      try {
        if (window['fs'].existsSync(filePath) && window['fs'].statSync(filePath).isFile()) {
          const fileContent = window['fs'].readFileSync(filePath);
          const blob = new Blob([fileContent]);
          const blobUrl = URL.createObjectURL(blob);
          
          // 设置 DownloadURL
          const mimeType = this.getMimeType(fileName);
          event.dataTransfer!.setData('DownloadURL', `${mimeType}:${fileName}:${blobUrl}`);
          
          console.log('设置 DownloadURL:', `${mimeType}:${fileName}:${blobUrl}`);
          
          // 清理 Blob URL（在拖拽结束后）
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        }
      } catch (error) {
        console.warn('创建 DownloadURL 失败:', error);
      }
    }
    
    // 方法 3: 设置文件 URI 列表（标准格式）
    const fileUris = filePaths.map(p => {
      const normalizedPath = p.replace(/\\/g, '/');
      const uriPath = normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath;
      return `file://${uriPath}`;
    });
    event.dataTransfer!.setData('text/uri-list', fileUris.join('\r\n'));

    // 在控制台输出调试信息
    console.log('拖拽开始:', {
      files: filePaths,
      uris: fileUris,
      count: filePaths.length
    });

    // 设置拖拽图像
    this.setDragImage(event);
  }

  /**
   * 根据文件名获取 MIME 类型
   */
  private getMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const mimeTypes: Record<string, string> = {
      'txt': 'text/plain',
      'html': 'text/html',
      'css': 'text/css',
      'js': 'text/javascript',
      'json': 'application/json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'pdf': 'application/pdf',
      'zip': 'application/zip',
      'c': 'text/plain',
      'cpp': 'text/plain',
      'h': 'text/plain',
      'ino': 'text/plain'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * 拖拽经过节点
   */
  onDragOver(event: DragEvent, node: FlatFileNode | null): void {
    event.preventDefault();
    event.stopPropagation();

    // 清除之前的自动展开定时器
    this.clearDragExpandTimer();

    if (!node) {
      // 拖拽到空白区域，表示放到根目录
      this.dragState.dragOverNode = null;
      this.dragState.dropPosition = 'inside';
      event.dataTransfer!.dropEffect = 'move';
      return;
    }

    // 检查是否是外部拖拽
    const hasFiles = event.dataTransfer?.types?.includes('Files');
    if (hasFiles) {
      // 外部文件拖入，总是允许
      this.dragState.isExternalDrag = true;
      this.dragState.dragOverNode = node;
      this.dragState.dropPosition = node.isLeaf ? 'before' : 'inside';
      event.dataTransfer!.dropEffect = 'copy';
      
      // 如果拖拽到文件夹上且停留一段时间，自动展开
      if (!node.isLeaf && this.dragState.dropPosition === 'inside') {
        this.startDragExpandTimer(node);
      }
      
      // 处理自动滚动
      this.handleDragScroll(event);
      return;
    }

    // 检查是否是有效的拖放目标
    if (!this.isValidDropTarget(node)) {
      event.dataTransfer!.dropEffect = 'none';
      this.dragState.dragOverNode = null;
      this.dragState.dropPosition = null;
      return;
    }

    // 确定拖放位置
    this.dragState.dragOverNode = node;
    this.dragState.dropPosition = this.calculateDropPosition(event, node);

    // 设置拖放效果
    event.dataTransfer!.dropEffect = event.ctrlKey ? 'copy' : 'move';

    // 如果拖拽到文件夹上且停留一段时间，自动展开
    if (!node.isLeaf && this.dragState.dropPosition === 'inside') {
      this.startDragExpandTimer(node);
    }

    // 处理自动滚动
    this.handleDragScroll(event);
  }

  /**
   * 拖拽离开节点
   */
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.clearDragExpandTimer();
  }

  /**
   * 放下拖拽的节点
   */
  async onDrop(event: DragEvent, targetNode: FlatFileNode | null): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    this.clearDragExpandTimer();
    this.clearDragScrollTimer();

    try {
      // 检查是否是外部文件拖入
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        await this.handleExternalDrop(files, targetNode);
        return;
      }

      // 内部拖拽
      await this.handleInternalDrop(event, targetNode);

    } finally {
      // 重置拖拽状态
      this.resetDragState();
    }
  }

  /**
   * 拖拽结束
   */
  onDragEnd(event: DragEvent): void {
    this.resetDragState();
    this.clearDragExpandTimer();
    this.clearDragScrollTimer();
  }

  /**
   * 处理外部文件拖入
   */
  private async handleExternalDrop(files: FileList, targetNode: FlatFileNode | null): Promise<void> {
    console.log('=== 外部文件拖入开始 ===');
    console.log('文件数量:', files.length);
    console.log('目标节点:', targetNode?.path || '根目录');
    console.log('window.electronAPI 存在:', !!window['electronAPI']);
    console.log('window.path 存在:', !!window['path']);
    console.log('window.fs 存在:', !!window['fs']);

    // 确定目标路径
    let targetPath = this.rootPath;
    if (targetNode) {
      targetPath = targetNode.isLeaf ? window['path'].dirname(targetNode.path) : targetNode.path;
    }

    console.log('目标路径:', targetPath);

    const copiedFiles: string[] = [];
    const failedFiles: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      console.log(`\n--- 处理文件 ${i + 1}/${files.length} ---`);
      console.log('文件名:', file.name);
      console.log('文件大小:', file.size);
      console.log('文件类型:', file.type);
      
      // 在 Electron 中，File 对象有一个 path 属性
      // 这是 Electron 特有的扩展属性
      // 使用 Electron API 获取文件路径
      // 优先使用 webUtils.getPathForFile (Electron 20+)
      let sourcePath: string | null = null;
      
      // 方法 1: 使用 electronAPI.file.getPath (推荐)
      if ((window['electronAPI'] as any)?.file?.getPath) {
        try {
          sourcePath = (window['electronAPI'] as any).file.getPath(file);
          console.log('✓ 使用 electronAPI.file.getPath 获取路径:', sourcePath);
        } catch (error) {
          console.warn('⚠ electronAPI.file.getPath 调用失败:', error);
        }
      }
      
      // 方法 2: 降级方案，直接访问 file.path
      if (!sourcePath && (file as any).path) {
        sourcePath = (file as any).path;
        console.log('✓ 使用 file.path 获取路径:', sourcePath);
      }

      console.log('最终获取的路径:', sourcePath);
      console.log('File 对象的所有属性:', Object.getOwnPropertyNames(file));

      // 如果仍然没有路径，说明无法处理此文件
      if (!sourcePath) {
        console.error('❌ 无法获取文件路径');
        console.error('可能原因:');
        console.error('1. 应用未在 Electron 环境中运行');
        console.error('2. Electron API 未正确暴露（检查 preload.js）');
        console.error('3. Electron 版本过旧（需要 20+ 或包含 file.path）');
        console.error('4. 文件来源不支持（虚拟文件系统等）');
        console.error('\n调试信息:');
        console.error('- electronAPI 存在:', !!window['electronAPI']);
        console.error('- electronAPI.file 存在:', !!(window['electronAPI'] as any)?.file);
        console.error('- electronAPI.file.getPath 存在:', !!(window['electronAPI'] as any)?.file?.getPath);
        console.error('- file.path 存在:', !!(file as any).path);
        
        failedFiles.push(file.name);
        continue;
      }

      try {
        const fileName = window['path'].basename(sourcePath);
        let destPath = window['path'].join(targetPath, fileName);

        console.log('✓ 文件路径获取成功');
        console.log('源路径:', sourcePath);
        console.log('目标路径:', destPath);

        // 检查源文件是否存在
        if (!window['fs'].existsSync(sourcePath)) {
          console.error('❌ 源文件不存在:', sourcePath);
          failedFiles.push(file.name);
          continue;
        }

        console.log('✓ 源文件存在');

        // 如果目标已存在，生成唯一文件名
        if (window['fs'].existsSync(destPath)) {
          const stats = window['fs'].statSync(sourcePath);
          const isDir = stats.isDirectory();
          const uniqueName = this.generateUniqueNameForDrop(targetPath, fileName, isDir);
          destPath = window['path'].join(targetPath, uniqueName);
          console.log('⚠ 目标文件已存在，使用新名称:', uniqueName);
        }

        // 复制文件或文件夹
        const stats = window['fs'].statSync(sourcePath);
        const finalFileName = window['path'].basename(destPath);
        const isDirectory = stats.isDirectory();
        
        if (isDirectory) {
          console.log('→ 开始复制文件夹...');
          window['fs'].copySync(sourcePath, destPath);
          console.log('✓ 文件夹复制成功');
        } else {
          console.log('→ 开始复制文件...');
          const content = window['fs'].readFileSync(sourcePath);
          window['fs'].writeFileSync(destPath, content);
          console.log('✓ 文件复制成功');
        }

        // 只有当父文件夹是展开状态时才需要手动添加节点
        // 如果父文件夹是折叠的，展开时会自动加载子节点
        if (this.isParentExpanded(targetPath)) {
          console.log('→ 父文件夹已展开，添加节点到树中...');
          this.addFileNodeDirect(targetPath, finalFileName, !isDirectory);
          console.log('✓ 节点已添加到树中');
        } else {
          console.log('⚠ 父文件夹未展开，清除缓存以便下次展开时重新加载');
          // 清除父文件夹的子节点缓存，这样当用户展开时会重新从文件系统加载
          this.dataSource.clearNodeCache(targetPath);
        }

        copiedFiles.push(file.name);
      } catch (error) {
        console.error('❌ 复制失败:', file.name);
        console.error('错误详情:', error);
        failedFiles.push(file.name);
      }
    }

    console.log('\n=== 外部文件拖入完成 ===');
    console.log('成功:', copiedFiles.length, copiedFiles);
    console.log('失败:', failedFiles.length, failedFiles);

    // 显示结果消息
    if (copiedFiles.length > 0) {
      this.message.success(`成功导入 ${copiedFiles.length} 个项目${failedFiles.length > 0 ? `，${failedFiles.length} 个失败` : ''}`);
    } else if (failedFiles.length > 0) {
      // 提供更详细的错误信息
      const errorMsg = `文件导入失败。请检查控制台日志。\n可能原因：\n1. 未在 Electron 环境运行\n2. 文件路径获取失败\n3. 文件系统 API 未正确暴露`;
      this.message.error(errorMsg);
      console.error('❌ 导入失败原因分析:');
      console.error('- window.electronAPI:', window['electronAPI']);
      console.error('- window.path:', window['path']);
      console.error('- window.fs:', window['fs']);
    }
  }

  /**
   * 处理内部拖拽放下
   */
  private async handleInternalDrop(event: DragEvent, targetNode: FlatFileNode | null): Promise<void> {
    if (!this.dragState.isDragging || this.dragState.draggedNodes.length === 0) {
      return;
    }

    // 确定目标路径
    let targetPath: string;
    if (!targetNode) {
      // 放到根目录
      targetPath = this.rootPath;
    } else if (this.dragState.dropPosition === 'inside') {
      // 放到文件夹内部
      targetPath = targetNode.isLeaf ? window['path'].dirname(targetNode.path) : targetNode.path;
    } else {
      // 放到节点前后（同级）
      targetPath = window['path'].dirname(targetNode.path);
    }

    const isCopy = event.ctrlKey;
    const movedFiles: string[] = [];
    const failedFiles: string[] = [];

    for (const draggedNode of this.dragState.draggedNodes) {
      try {
        const sourcePath = draggedNode.path;
        const fileName = window['path'].basename(sourcePath);

        // 检查是否拖拽到自己或子目录
        if (this.isDropIntoSelfOrChild(sourcePath, targetPath)) {
          console.warn('不能将文件夹拖拽到自己或子目录:', sourcePath);
          continue;
        }

        // 检查是否拖拽到相同位置
        const sourceParent = window['path'].dirname(sourcePath);
        if (sourceParent === targetPath && !isCopy) {
          console.log('拖拽到相同位置，跳过:', sourcePath);
          continue;
        }

        let destPath = window['path'].join(targetPath, fileName);

        // 如果目标已存在，生成唯一文件名
        if (window['fs'].existsSync(destPath)) {
          const uniqueName = this.generateUniqueNameForDrop(targetPath, fileName, !draggedNode.isLeaf);
          destPath = window['path'].join(targetPath, uniqueName);
        }

        if (isCopy) {
          // 复制操作
          if (draggedNode.isLeaf) {
            const content = window['fs'].readFileSync(sourcePath);
            window['fs'].writeFileSync(destPath, content);
          } else {
            window['fs'].copySync(sourcePath, destPath);
          }
          
          // 只有当父文件夹是展开状态时才需要手动添加节点
          if (this.isParentExpanded(targetPath)) {
            this.addFileNodeDirect(targetPath, window['path'].basename(destPath), draggedNode.isLeaf);
          } else {
            // 清除父文件夹的子节点缓存
            this.dataSource.clearNodeCache(targetPath);
          }
        } else {
          // 移动操作
          window['fs'].renameSync(sourcePath, destPath);
          this.removeFileNode(sourcePath);
          
          // 只有当父文件夹是展开状态时才需要手动添加节点
          if (this.isParentExpanded(targetPath)) {
            this.addFileNodeDirect(targetPath, window['path'].basename(destPath), draggedNode.isLeaf);
          } else {
            // 清除父文件夹的子节点缓存
            this.dataSource.clearNodeCache(targetPath);
          }
        }

        movedFiles.push(fileName);
      } catch (error) {
        console.error('拖拽操作失败:', draggedNode.path, error);
        failedFiles.push(draggedNode.title);
      }
    }

    // 显示结果消息
    if (movedFiles.length > 0) {
      const action = isCopy ? '复制' : '移动';
      this.message.success(`成功${action} ${movedFiles.length} 个项目${failedFiles.length > 0 ? `，${failedFiles.length} 个失败` : ''}`);
    } else if (failedFiles.length > 0) {
      this.message.error('拖拽操作失败');
    }
  }

  /**
   * 检查是否是有效的拖放目标
   */
  private isValidDropTarget(targetNode: FlatFileNode): boolean {
    // 如果是外部拖拽，允许拖到任何文件夹或文件（文件会拖到父目录）
    if (this.dragState.isExternalDrag) {
      return true;
    }

    // 内部拖拽检查
    if (!this.dragState.isDragging || this.dragState.draggedNodes.length === 0) {
      return false;
    }

    // 不能拖拽到自己
    const isDraggingSelf = this.dragState.draggedNodes.some(n => n.path === targetNode.path);
    if (isDraggingSelf) {
      return false;
    }

    // 不能拖拽到自己的子节点
    for (const draggedNode of this.dragState.draggedNodes) {
      if (!draggedNode.isLeaf && targetNode.path.startsWith(draggedNode.path + window['path'].sep)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 计算拖放位置
   */
  private calculateDropPosition(event: DragEvent, node: FlatFileNode): 'before' | 'after' | 'inside' {
    // 如果是文件夹，优先放到内部
    if (!node.isLeaf) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const y = event.clientY - rect.top;
      const height = rect.height;

      // 上方1/4区域为before，下方1/4为after，中间1/2为inside
      if (y < height * 0.25) {
        return 'before';
      } else if (y > height * 0.75) {
        return 'after';
      } else {
        return 'inside';
      }
    } else {
      // 如果是文件，只能放到前后
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const y = event.clientY - rect.top;
      return y < rect.height / 2 ? 'before' : 'after';
    }
  }

  /**
   * 检查是否拖拽到自己或子目录
   */
  private isDropIntoSelfOrChild(sourcePath: string, targetPath: string): boolean {
    if (sourcePath === targetPath) {
      return true;
    }
    // 检查targetPath是否是sourcePath的子目录
    return targetPath.startsWith(sourcePath + window['path'].sep);
  }

  /**
   * 为拖放生成唯一文件名
   */
  private generateUniqueNameForDrop(targetDir: string, originalName: string, isFolder: boolean): string {
    if (isFolder) {
      let counter = 1;
      let newName = originalName;
      while (window['fs'].existsSync(window['path'].join(targetDir, newName))) {
        newName = `${originalName} (${counter})`;
        counter++;
      }
      return newName;
    } else {
      const ext = window['path'].extname(originalName);
      const nameWithoutExt = window['path'].basename(originalName, ext);
      let counter = 1;
      let newName = originalName;
      while (window['fs'].existsSync(window['path'].join(targetDir, newName))) {
        newName = `${nameWithoutExt} (${counter})${ext}`;
        counter++;
      }
      return newName;
    }
  }

  /**
   * 设置拖拽图像
   */
  private setDragImage(event: DragEvent): void {
    const draggedCount = this.dragState.draggedNodes.length;
    const dragImage = document.createElement('div');
    dragImage.className = 'drag-image';
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    dragImage.style.left = '-1000px';
    dragImage.style.padding = '4px 8px';
    dragImage.style.background = 'rgba(24, 144, 255, 0.9)';
    dragImage.style.color = 'white';
    dragImage.style.borderRadius = '4px';
    dragImage.style.fontSize = '12px';
    dragImage.style.whiteSpace = 'nowrap';

    if (draggedCount === 1) {
      dragImage.textContent = this.dragState.draggedNodes[0].title;
    } else {
      dragImage.textContent = `${draggedCount} 个项目`;
    }

    document.body.appendChild(dragImage);
    event.dataTransfer!.setDragImage(dragImage, 10, 10);

    // 移除临时元素
    setTimeout(() => {
      document.body.removeChild(dragImage);
    }, 0);
  }

  /**
   * 启动自动展开定时器
   */
  private startDragExpandTimer(node: FlatFileNode): void {
    this.clearDragExpandTimer();
    this.dragExpandTimer = setTimeout(() => {
      if (!this.treeControl.isExpanded(node)) {
        this.treeControl.expand(node);
      }
    }, this.TIMING.AUTO_EXPAND_DELAY);
  }

  /**
   * 清除自动展开定时器
   */
  private clearDragExpandTimer(): void {
    if (this.dragExpandTimer) {
      clearTimeout(this.dragExpandTimer);
      this.dragExpandTimer = null;
    }
  }

  /**
   * 处理拖拽自动滚动
   */
  private handleDragScroll(event: DragEvent): void {
    const container = document.querySelector('.file-explorer-content') as HTMLElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const scrollZone = 50; // 滚动触发区域的高度
    const scrollSpeed = 10; // 滚动速度

    this.clearDragScrollTimer();

    if (event.clientY < rect.top + scrollZone) {
      // 向上滚动
      this.dragScrollTimer = setInterval(() => {
        container.scrollTop -= scrollSpeed;
      }, 50);
    } else if (event.clientY > rect.bottom - scrollZone) {
      // 向下滚动
      this.dragScrollTimer = setInterval(() => {
        container.scrollTop += scrollSpeed;
      }, 50);
    }
  }

  /**
   * 清除拖拽滚动定时器
   */
  private clearDragScrollTimer(): void {
    if (this.dragScrollTimer) {
      clearInterval(this.dragScrollTimer);
      this.dragScrollTimer = null;
    }
  }

  /**
   * 重置拖拽状态
   */
  private resetDragState(): void {
    this.dragState.isDragging = false;
    this.dragState.draggedNodes = [];
    this.dragState.dragOverNode = null;
    this.dragState.dropPosition = null;
    this.dragState.isExternalDrag = false;
  }

  /**
   * 获取拖拽视觉反馈的CSS类
   */
  getDragOverClass(node: FlatFileNode): string {
    if (this.dragState.dragOverNode !== node) {
      return '';
    }

    switch (this.dragState.dropPosition) {
      case 'before':
        return 'drag-over-before';
      case 'after':
        return 'drag-over-after';
      case 'inside':
        return 'drag-over-inside';
      default:
        return '';
    }
  }

  /**
   * 处理容器拖拽经过（用于外部文件拖入）
   */
  onContainerDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // 检查是否是外部文件
    const hasFiles = event.dataTransfer?.types.includes('Files');
    if (hasFiles) {
      this.dragState.isExternalDrag = true;
      event.dataTransfer!.dropEffect = 'copy';
    }
  }

  /**
   * 处理容器拖拽放下（用于外部文件拖入到空白区域）
   */
  onContainerDrop(event: DragEvent): void {
    // 只处理拖到空白区域的情况
    const target = event.target as HTMLElement;
    if (target.classList.contains('file-explorer-content') || target.classList.contains('sscroll')) {
      this.onDrop(event, null);
    }
  }
}
