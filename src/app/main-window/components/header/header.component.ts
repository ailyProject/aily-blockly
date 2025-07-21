import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, isDevMode, ViewChild, viewChild } from '@angular/core';
import { HEADER_BTNS, HEADER_MENU } from '../../../configs/menu.config';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { FormsModule } from '@angular/forms';
import { ProjectService } from '../../../services/project.service';
import { UiService } from '../../../services/ui.service';
import { BuilderService } from '../../../services/builder.service';
import { UploaderService } from '../../../services/uploader.service';
import { MenuComponent } from '../../../components/menu/menu.component';
import { PortItem, SerialService } from '../../../services/serial.service';
import { ActBtnComponent } from '../act-btn/act-btn.component';
import { IMenuItem } from '../../../configs/menu.config';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { UnsaveDialogComponent } from '../unsave-dialog/unsave-dialog.component';
import { TranslateModule } from '@ngx-translate/core';
import { UpdateService } from '../../../services/update.service';
import { Router } from '@angular/router';
import { ElectronService } from '../../../services/electron.service';
import { UserComponent } from '../user/user.component';
import { ConfigService } from '../../../services/config.service';

@Component({
  selector: 'app-header',
  imports: [
    CommonModule,
    NzToolTipModule,
    MenuComponent,
    ActBtnComponent,
    UserComponent,
    TranslateModule
  ],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent {
  headerBtns = HEADER_BTNS;
  headerMenu = HEADER_MENU;

  get projectData() {
    return this.projectService.currentPackageData;
  }

  get openToolList() {
    return this.uiService.openToolList;
  }

  get terminalIsOpen() {
    return this.uiService.terminalIsOpen;
  }

  get currentPort() {
    return this.serialService.currentPort;
  }

  set currentPort(port) {
    this.serialService.currentPort = port;
  }

  get currentBoard() {
    return this.projectService.currentBoardConfig?.name;
  }

  currentUrl = null;

  get isDevMode() {
    return isDevMode()
  }

  constructor(
    private projectService: ProjectService,
    private uiService: UiService,
    private builderService: BuilderService,
    private uploaderService: UploaderService,
    private serialService: SerialService,
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private modal: NzModalService,
    private updateService: UpdateService,
    private router: Router,
    private electronService: ElectronService,
    private configService: ConfigService
  ) { }

  async ngAfterViewInit() {
    this.projectService.stateSubject.subscribe((state) => {
      if (state == 'loaded' || state == 'saved') {
        // 将headerMenu中有disabled的按钮置为可用
        this.headerMenu.forEach((menu) => {
          if (menu.disabled) {
            menu.disabled = false;
          }
        });
      } else {
        // 将headerMenu中有disabled的按钮置禁用
        this.headerMenu.forEach((menu) => {
          if (menu.disabled === false) {
            menu.disabled = true;
          }
        });
      }
      this.cd.detectChanges();
    });

    this.listenShortcutKeys();

  }

  showMenu = false;
  openMenu() {
    this.showMenu = !this.showMenu;
  }

  closeMenu() {
    this.showMenu = false;
  }

  showPortList = false;
  configList: PortItem[] = []
  boardKeywords = []; // 这个用来高亮显示正确开发板，如['arduino uno']，则端口菜单中如有包含'arduino uno'的串口则高亮显示
  openPortList() {
    let boardname = this.currentBoard.replace(' 2560', ' ').replace(' R3', '');
    this.boardKeywords = [boardname];
    this.showPortList = !this.showPortList;
    this.getDevicePortList();
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(item) {
    if (item.action) {
      this.process(item)
      return
    }
    this.currentPort = item.name;
    this.closePortList();
  }

  async getDevicePortList() {
    let portList0: IMenuItem[] = await this.serialService.getSerialPorts();
    if (portList0.length == 0) {
      portList0 = [
        {
          name: 'Device not found',
          text: '',
          type: 'serial',
          icon: 'fa-light fa-triangle-exclamation',
          disabled: true,
        }
      ];
    }
    // 添加ESP32相关配置选项
    if (this.projectService.currentBoardConfig['core'].indexOf('esp32') > -1) {
      let temp = this.projectService.currentBoardConfig['type'].split(':');
      let board = temp[temp.length - 1];
      let esp32config = await this.projectService.updateEsp32ConfigMenu(board);
      if (esp32config) {
        portList0 = portList0.concat(esp32config)
      }
      // console.log('ESP32配置选项:', esp32config);
    }

    // 添加切换开发板功能
    let boardList = await this.configService.loadBoardList();
    boardList = this.convertBoardListFormat(boardList);
    portList0.push({ sep: true });
    portList0.push({
      name: '切换开发板',
      icon: 'fa-light fa-layer-group',
      action: 'board-select',
      children: boardList
    })
    this.configList = portList0;
    this.cd.detectChanges();
  }

  onClick(item, event = null) {
    this.process(item, event);
  }

  isOpenTool(btn) {
    if (btn.data.type == 'terminal') {
      return this.terminalIsOpen;
    } else if (btn.data && btn.data.data) {
      return this.openToolList.indexOf(btn.data.data) !== -1;
    }
    return false;
  }

  onMenuClick(item) {
    if (item.disabled) return;
    this.process(item);
    this.closeMenu();
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: this.projectData.path,
    });
    // console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async selectSaveAsFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
      path: this.projectData.path,
      suggestedName: this.projectData.name + '_new',
    });
    // console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async openProject() {
    const path = await this.selectFolder();
    if (path) {
      await this.projectService.projectOpen(path);
    }
  }

  updateSubscription: any = null;

  async process(item: IMenuItem, event = null) {
    switch (item.action) {
      case 'project-new':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('new');
          if (!canContinue) return;
        }
        this.uiService.openWindow(item.data);
        break;
      case 'project-open':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('open');
          if (!canContinue) return;
        }
        this.openProject();
        break;
      case 'project-save':
        this.projectService.save();
        break;
      case 'project-save-as':
        const path = await this.selectSaveAsFolder();
        if (path) {
          this.projectService.saveAs(path);
        }
        break;
      case 'project-close':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('close');
          if (!canContinue) return;
        }
        this.projectService.close();
        break;
      case 'project-open-by-explorer':
        window['other'].openByExplorer(this.projectService.currentProjectPath);
        break;
      case 'tool-open':
        this.uiService.turnTool(item.data);
        break;
      // case 'terminal':
      //   this.uiService.turnTerminal(item.data);
      //   break;
      case 'compile':
        if (item.state === 'doing') return;
        item.state = 'doing';
        this.builderService.build().then(result => {
          item.state = 'done';
        }).catch(err => {
          console.error("编译失败: ", err);
          if (err.state) item.state = err.state;
        })
        break;
      case 'upload':
        if (item.state === 'doing') return;
        item.state = 'doing';
        this.uploaderService.upload().then(result => {
          item.state = 'done';
        }).catch(err => {
          console.log("上传失败: ", err);
          if (err.state) item.state = err.state;
        });
        break;
      case 'settings-open':
        this.uiService.openWindow(item.data);
        break;
      case 'check-update':
        this.updateService.clearSkipVersions();
        if (!this.updateSubscription) {
          this.updateSubscription = this.updateService.updateStatus.subscribe((status) => {
            // console.log('更新状态:', status);
            if (status === 'not-available') {
              this.message.info('当前已是最新版本');
            }
          });
        }
        this.updateService.checkForUpdates();
        break;
      case 'browser-open':
        this.electronService.openUrl(item.data.url);
        break;
      case 'app-exit':
        this.close();
        break;
      case 'example-open':
        if (this.isLoaded()) { // 只在已加载项目时检查
          this.electronService.openNewInStance('/main/playground')
        } else {
          this.router.navigate(['/main/playground']);
        }
        break;
      case 'user-auth':
        if (event) {
          this.calculateUserPosition(event);
        }
        this.showUser = !this.showUser;
        break;
      case 'board-select':
        console.log('board-select');
        break;
      default:
        console.log('未处理的操作:', item.action);
        break;
    }
  }

  minimize() {
    window['iWindow'].minimize();
  }

  maximize() {
    if (window['iWindow'].isMaximized()) {
      window['iWindow'].unmaximize();
    } else {
      window['iWindow'].maximize();
    }
  }

  async close() {
    const canClose = await this.checkUnsavedChanges('close');
    if (canClose) {
      window['iWindow'].close();
    }
  }

  // 快捷键功能，监听键盘事件,执行对应的操作
  private shortcutMap: Map<string, IMenuItem> = new Map();
  private initShortcutMap(): void {
    for (const item of HEADER_MENU) {
      if (item.text) {
        // 将快捷键文本转换成标准格式(如: "ctrl+s")
        const shortcutKey = this.normalizeShortcutKey(item.text);
        if (shortcutKey) {
          this.shortcutMap.set(shortcutKey, item);
        }
      }
    }
    // console.log('已初始化快捷键映射:', Array.from(this.shortcutMap.keys()));
  }

  // 转换快捷键文本为标准格式
  private normalizeShortcutKey(shortcutText: string): string {
    if (!shortcutText) return '';

    return shortcutText.toLowerCase().split('+')
      .map(part => part.trim())
      .sort((a, b) => {
        // 保证修饰键的顺序：ctrl 在前，shift 在后，其他按字母顺序
        if (a === 'ctrl') return -1;
        if (b === 'ctrl') return 1;
        if (a === 'shift') return -1;
        if (b === 'shift') return 1;
        return a.localeCompare(b);
      })
      .join('+');
  }

  // 从键盘事件生成标准化的快捷键字符串
  private getShortcutFromEvent(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.ctrlKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    // 添加主键，忽略修饰键本身
    const key = event.key.toLowerCase();
    if (!['control', 'shift', 'alt'].includes(key)) {
      parts.push(key);
    }

    return parts.join('+');
  }

  /* 监听快捷键
  */
  listenShortcutKeys() {
    this.initShortcutMap();
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      // 只处理包含修饰键的组合键
      if (event.ctrlKey || event.shiftKey || event.altKey) {
        const shortcutKey = this.getShortcutFromEvent(event);
        const menuItem = this.shortcutMap.get(shortcutKey);

        if (menuItem) {
          event.preventDefault(); // 阻止默认行为
          console.log('快捷键触发:', menuItem.name, shortcutKey);

          // 执行对应的操作
          if (menuItem.data && menuItem.data.type) {
            this.process(menuItem);
          } else if (menuItem.action) {
            // 如果需要处理action类型的菜单项，可以在这里添加逻辑
            // this.handleMenuAction(menuItem);
            console.log('需要处理action:', menuItem.action);
          }
        }
      }
    });
  }

  async checkUnsavedChanges(action: 'close' | 'open' | 'new'): Promise<boolean> {
    // 检查项目是否有未保存的更改
    if (!await this.projectService.hasUnsavedChanges()) {
      return true;
    }

    // 根据不同操作设置不同的提示文本
    let title = '有未保存的更改';
    let text = '是否保存当前项目？';
    if (action === 'open') {
      text = '在打开新项目前，是否保存当前项目的更改？';
    } else if (action === 'new') {
      text = '在创建新项目前，是否保存当前项目的更改？';
    } else if (action === 'close') {
      text = '是否在关闭前保存更改？';
    }

    return new Promise<boolean>((resolve) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '320px',
        nzContent: UnsaveDialogComponent,
        nzData: { title, text },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'save':
            // 保存项目并继续
            await this.projectService.save();
            resolve(true);
            break;
          case 'continue':
            // 不保存，但继续操作
            resolve(true);
            break;
          case 'cancel':
          default:
            // 取消操作
            resolve(false);
            break;
        }
      });
    });
  }


  showInRouter(menuItem: IMenuItem) {
    if (!menuItem.router) {
      return true;
    } else {
      for (const router of menuItem.router) {
        if (this.router.url.indexOf(router) > -1) {
          return true;
        }
      }
    }
  }

  // 判断路由是否为 ['/main/blockly-editor', '/main/code-editor']中的一个，如果是返回true
  isLoaded() {
    for (const router of ['/main/blockly-editor', '/main/code-editor']) {
      if (this.router.url.indexOf(router) > -1) {
        return true;
      }
    }
  }

  // 选择子菜单项-修改编译上传配置
  async selectSubItem(subItem: IMenuItem) {
    console.log('选择子菜单项:', subItem);
    // 切换开发板
    if (subItem.key === "BoardType") {
      this.projectService.changeBoard(subItem.data.board);
      this.showPortList = false;
    } else {
      let packageJson = await this.projectService.getPackageJson();
      packageJson['projectConfig'] = packageJson['projectConfig'] || {};
      packageJson['projectConfig'][subItem.key] = subItem.data;
      // 更新项目配置
      this.projectService.setPackageJson(packageJson);
    }
  }

  showUser = false;
  userPosition = { x: 0, y: 40 };

  // 计算用户组件的显示位置
  calculateUserPosition(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();

    // 计算用户组件的位置，使其显示在点击元素的下方
    this.userPosition = {
      x: rect.left + 10, // 向左偏移一些，使其更好对齐
      y: 40
    };

    // 确保用户组件不会超出窗口边界
    const windowWidth = window.innerWidth;
    const userComponentWidth = 260; // 用户组件的宽度

    if (this.userPosition.x + userComponentWidth > windowWidth) {
      this.userPosition.x = windowWidth - userComponentWidth - 3;
    }

    if (this.userPosition.x < 0) {
      this.userPosition.x = 10;
    }
  }

  closeUser() {
    this.showUser = false;
  }

  /**
   * 将开发板列表转换为菜单格式
   * @param boardList 原始开发板列表
   * @returns 转换后的菜单格式列表
   */
  convertBoardListFormat(boardList: any[]): any[] {
    console.log('转换开发板列表格式:', boardList);
    return boardList
      // .filter(board => !board.disabled) // 过滤掉被禁用的开发板
      .map(board => ({
        name: board.nickname || board.name, // 使用昵称，如果没有则使用name
        key: "BoardType",
        data: {
          board: {
            name: board.name,
            nickname: board.nickname,
            version: board.version,
            description: board.description,
            author: board.author,
            brand: board.brand,
            url: board.url,
            compatibility: board.compatibility,
            img: board.img
          }
        },
        check: false
      }));
  }

}

export interface RunState {
  state: 'default' | 'doing' | 'done' | 'error' | 'warn';
  text: string;
}