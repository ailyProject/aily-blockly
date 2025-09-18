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

  constructor(
    private fileService: FileService,
    private message: NzMessageService
  ) {
    // 初始化时创建空的数据源
    this.dataSource = new DynamicFileDataSource(this.treeControl, this.fileService, []);
  }

  ngOnInit() {
    this.loadRootPath();
  }

  ngAfterViewInit() {
    setTimeout(() => {
      const files = this.dataSource.getCurrentData();
      const inoFile = files.find(f => f.isLeaf && f.title.endsWith('.ino'));
      if (inoFile) {
        this.openFile(inoFile);
      }
    }, 0);
  }

  loadRootPath(path = this.rootPath): void {
    // 保存当前展开状态
    if (this.dataSource) {
      this.dataSource.saveExpandedState();
    }

    const files = this.fileService.readDir(path);
    console.log('Loaded root path files:', files);

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
    console.log('Menu item clicked:', menuItem, 'Node:', this.currentSelectedNode);
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
        const currentSelected = this.nodeSelection.selected.filter(
          node => !deletedPaths.includes(node.path)
        );
        this.nodeSelection.clear();
        currentSelected.forEach(node => {
          this.nodeSelection.select(node);
        });

        console.log('Delete operation completed, UI updated');

        // 验证删除是否成功反映在UI中
        setTimeout(() => {
          const currentData = this.dataSource.getCurrentData();
          const stillExists = deletedPaths.some(path =>
            currentData.some(node => node.path === path)
          );

          if (stillExists) {
            console.warn('Some deleted nodes still exist in UI, forcing refresh');
            this.refresh();
          }
        }, 100);

      } catch (error) {
        console.error('Error updating UI after delete:', error);
        // 如果增量更新失败，强制刷新整个树
        this.refresh();
      }
    });
  }

  private createNewFile(parentNode: FlatFileNode) {
    // 确定实际的父路径
    let parentPath = parentNode.path;
    if (parentNode.isLeaf) {
      parentPath = window['path'].dirname(parentPath);
    }

    // 创建临时节点用于内联编辑，使用时间戳确保唯一性
    const tempKey = `__new_file_temp_${Date.now()}__`;
    const tempPath = window['path'].join(parentPath, tempKey);
    const tempNode: FlatFileNode = {
      expandable: false,
      title: '',
      level: parentNode.isLeaf ? parentNode.level : parentNode.level + 1,
      key: tempPath,
      isLeaf: true,
      path: tempPath
    };

    // 添加临时节点到适当位置
    this.addFileNodeDirect(parentPath, tempKey, true);

    // 开始内联编辑
    this.startInlineEdit(tempNode, 'newFile', parentPath);
  }

  private createNewFolder(parentNode: FlatFileNode) {
    // 确定实际的父路径
    let parentPath = parentNode.path;
    if (parentNode.isLeaf) {
      parentPath = window['path'].dirname(parentPath);
    }

    // 创建临时节点用于内联编辑，使用时间戳确保唯一性
    const tempKey = `__new_folder_temp_${Date.now()}__`;
    const tempPath = window['path'].join(parentPath, tempKey);
    const tempNode: FlatFileNode = {
      expandable: true,
      title: '',
      level: parentNode.isLeaf ? parentNode.level : parentNode.level + 1,
      key: tempPath,
      isLeaf: false,
      path: tempPath
    };

    // 添加临时节点到适当位置
    this.addFileNodeDirect(parentPath, tempKey, false);

    // 开始内联编辑
    this.startInlineEdit(tempNode, 'newFolder', parentPath);
  }

  private copyPathToClipboard(node: FlatFileNode, relative: boolean) {
    this.fileService.copyPathToClipboard(node, relative, this.rootPath);
  }

  private getRelativePath(absolutePath: string): string {
    return this.fileService.getRelativePath(absolutePath, this.rootPath);
  }

  private revealInExplorer(node: FlatFileNode) {
    this.fileService.revealInExplorer(node);
  }

  private openInTerminal(node: FlatFileNode) {
    this.fileService.openInTerminal(node);
  }

  // private showProperties(node: FlatFileNode) {
  //   this.fileService.showProperties(node);
  // }

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
    }, 0);
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
    const existingNode = data.find(n => n.path === fullPath);
    if (existingNode) {
      return; // 文件已存在，不重复添加
    }

    // 寻找合适的插入位置
    let insertLevel = 0;
    let insertIndex = data.length; // 默认插入到末尾

    // 如果是根目录，直接插入到顶层
    if (parentPath === this.rootPath) {
      insertLevel = 0;
      // 按文件类型和字母顺序排序：文件夹在前，文件在后
      for (let i = 0; i < data.length; i++) {
        if (data[i].level === 0) {
          if (isLeaf && !data[i].isLeaf) {
            // 新文件，当前是文件夹，继续查找
            continue;
          } else if (!isLeaf && data[i].isLeaf) {
            // 新文件夹，当前是文件，插入这里
            insertIndex = i;
            break;
          } else if (data[i].title > newFileName) {
            // 同类型，按字母顺序
            insertIndex = i;
            break;
          }
        } else if (data[i].level < 0) {
          // 已经到了下一层，停止
          break;
        }
      }
    } else {
      // 寻找父节点
      const parentNodeIndex = data.findIndex(n => n.path === parentPath);
      if (parentNodeIndex !== -1) {
        const parentNode = data[parentNodeIndex];
        insertLevel = parentNode.level + 1;

        // 找到同级节点的末尾位置，并按照文件类型和字母顺序排序
        insertIndex = parentNodeIndex + 1;
        while (insertIndex < data.length && data[insertIndex].level > parentNode.level) {
          if (data[insertIndex].level === insertLevel) {
            if (isLeaf && !data[insertIndex].isLeaf) {
              // 新文件，当前是文件夹，继续查找
            } else if (!isLeaf && data[insertIndex].isLeaf) {
              // 新文件夹，当前是文件，插入这里
              break;
            } else if (data[insertIndex].title > newFileName) {
              // 同类型，按字母顺序
              break;
            }
          }
          insertIndex++;
        }
      } else {
        // 父节点不存在，可能需要先展开父节点
        console.warn('Parent node not found:', parentPath);
        return;
      }
    }

    const newNode: FlatFileNode = {
      expandable: !isLeaf,
      title: newFileName,
      level: insertLevel,
      key: fullPath,
      isLeaf: isLeaf,
      path: fullPath
    };

    // 直接插入到数据中
    data.splice(insertIndex, 0, newNode);
    // 使用flattenedData.next来触发更新，避免完全重置
    this.dataSource['flattenedData'].next([...data]);
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
    }, 0);
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
      inputElement.focus();

      // 选择文本（对于重命名操作，选择不包括扩展名的部分）
      if (this.inlineEditState.editType === 'rename' && this.inlineEditState.originalValue) {
        const value = this.inlineEditState.originalValue;
        const lastDotIndex = value.lastIndexOf('.');
        if (lastDotIndex > 0) {
          inputElement.setSelectionRange(0, lastDotIndex);
        } else {
          inputElement.select();
        }
      } else {
        inputElement.select();
      }
    }
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
}
