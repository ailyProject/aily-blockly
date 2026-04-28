import { ChangeDetectorRef, Component, EventEmitter, OnDestroy, Output } from '@angular/core';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { NpmService } from '../../../../services/npm.service';
import { ConfigService } from '../../../../services/config.service';
import { ProjectService } from '../../../../services/project.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { CompatibleDialogComponent } from '../compatible-dialog/compatible-dialog.component';
import { CmdOutput, CmdService } from '../../../../services/cmd.service';
import { ElectronService } from '../../../../services/electron.service';
import { BlocklyService } from '../../services/blockly.service';
import { PlatformService } from '../../../../services/platform.service';
import { WorkflowService } from '../../../../services/workflow.service';
import { CrossPlatformCmdService } from '../../../../services/cross-platform-cmd.service';
import {
  AILY_LOCAL_LIBRARY_SOURCES_KEY,
  LocalLibrarySyncService,
} from '../../../../services/local-library-sync.service';
import { createLibrarySearchIndex, searchLibraries } from '../../../../utils/fuzzy-search.utils';
import type { AnyOrama } from '@orama/orama';

@Component({
  selector: 'app-lib-manager',
  imports: [
    FormsModule,
    CommonModule,
    NzInputModule,
    NzButtonModule,
    NzToolTipModule,
    NzSelectModule,
    NzTagModule,
    TranslateModule
  ],
  templateUrl: './lib-manager.component.html',
  styleUrl: './lib-manager.component.scss'
})
export class LibManagerComponent implements OnDestroy {

  @Output() close = new EventEmitter();

  keyword: string = '';
  tagList: { key: string; label: string }[] = [];
  displayTagList: { key: string; label: string }[] = [];
  libraryList: PackageInfo[] = [];
  _libraryList: PackageInfo[] = [];
  installedPackageList: string[] = [];

  loading = false;

  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private searchIndex: AnyOrama | null = null;

  constructor(
    private npmService: NpmService,
    private configService: ConfigService,
    private projectService: ProjectService,
    private blocklyService: BlocklyService,
    private message: NzMessageService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService,
    private modal: NzModalService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    private platformService: PlatformService,
    private workflowService: WorkflowService,
    private localLibrarySyncService: LocalLibrarySyncService,
  ) {
    this.searchSubject.pipe(
      debounceTime(200),
      takeUntil(this.destroy$)
    ).subscribe(keyword => this.doSearch(keyword));
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async ngOnInit() {
    // 从 tags.json 加载标签列表，根据当前语言显示本地化名称
    this.tagList = this.buildLocalizedTagList();
    this.displayTagList = this.getRandomTags(10);

    this._libraryList = this.process(this.configService.libraryList);
    this.libraryList = this.applyLocalization(await this.checkInstalled());
    this.cd.detectChanges();
  }

  async checkInstalled(libraryList = null) {
    let isNull = false;
    if (libraryList === null) {
      isNull = true;
      libraryList = JSON.parse(JSON.stringify(this._libraryList));
    }
    // 获取已经安装的包，用于在界面上显示"移除"按钮
    let installedLibraries = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
    installedLibraries = installedLibraries.map(item => {
      item['state'] = 'installed';
      item['fulltext'] = `installed${item.name}${item.nickname}${item.keywords}${item.description}${item.brand}`.replace(/\s|aily|blockly/gi, '').toLowerCase();
      return item;
    });

    // console.log('所有库列表：', libraryList);
    // console.log('已安装的库列表：', installedLibraries);
    // 遍历installedLibraries, 如果this.libraryList存在name相同的库，则将installedLibraries中的库合并到this.libraryList中
    libraryList.forEach(lib => {
      const installedLib = installedLibraries.find(installed => installed.name === lib.name);
      if (installedLib) {
        Object.assign(lib, installedLib);
      } else {
        lib.state = 'default'; // 如果没有安装，则设置状态为默认
      }
    });

    // 将只存在于installedLibraries中但不在libraryList中的库添加到libraryList中
    if (isNull) {
      installedLibraries.forEach(installedLib => {
        const existsInLibraryList = libraryList.find(lib => lib.name === installedLib.name);
        if (!existsInLibraryList) {
          // 为新添加的库设置默认属性
          installedLib['versionList'] = [installedLib.version];
          libraryList.push(installedLib);
        }
      });
    }

    // console.log('合并后的库列表：', libraryList);
    return this.applyLibraryOperationStates(libraryList);
  }

  // 处理库列表数据，为显示做准备
  process(array) {
    for (let index = 0; index < array.length; index++) {
      const item = array[index];
      // 为版本选择做准备
      item['versionList'] = [item.version];
      // 为状态做准备
      item['state'] = 'default'; // default, installed, installing, uninstalling
      // 为全文搜索做准备
      item['fulltext'] = `${item.name}${item.nickname}${item.keywords}${item.tags}${item.description}${item.brand}`.replace(/\s|aily|blockly|ailyproject/gi, '').toLowerCase();
    }
    return array;
  }

  async search(keyword = this.keyword) {
    this.keyword = keyword;
    this.searchSubject.next(keyword);
  }

  private async doSearch(keyword: string) {
    if (!keyword) {
      this.libraryList = this.applyLocalization(await this.checkInstalled());
      this.cd.detectChanges();
      return;
    }

    const keywordLower = keyword.toLowerCase();
    let libraryList = await this.checkInstalled();

    // 特殊标签搜索（installed / lib-core 等）保持精确子串匹配
    if (keywordLower === 'installed' || keywordLower === 'lib-core') {
      const stripped = keywordLower.replace(/\s/g, '');
      const matchedItems = libraryList
        .filter(item => item.fulltext.indexOf(stripped) !== -1);
      this.libraryList = this.applyLocalization(matchedItems);
      this.cd.detectChanges();
      return;
    }

    // 使用 Orama 进行模糊搜索
    const localizedList = this.applyLocalization(libraryList);
    this.searchIndex = createLibrarySearchIndex(localizedList);
    const matchedNames = searchLibraries(this.searchIndex, keyword);

    // 按 Orama 返回的顺序（相关度排序）还原库对象
    const nameIndexMap = new Map<string, number>();
    matchedNames.forEach((name, i) => nameIndexMap.set(name, i));

    const results = localizedList
      .filter(lib => nameIndexMap.has(lib.name))
      .sort((a, b) => (nameIndexMap.get(a.name) ?? 0) - (nameIndexMap.get(b.name) ?? 0));

    this.libraryList = results;
    this.cd.detectChanges();
  }

  private getRandomTags(count: number): { key: string; label: string }[] {
    if (this.tagList.length <= count) return [...this.tagList];
    const shuffled = [...this.tagList].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  private buildLocalizedTagList(): { key: string; label: string }[] {
    const tagsData = this.configService.tagList;
    if (!tagsData?.tags || !Array.isArray(tagsData.tags)) {
      return [];
    }
    const lang = this.translate.currentLang || 'en';
    const localizedMap = tagsData[`tags_${lang}`] || tagsData['tags_en'] || {};
    return tagsData.tags.map((key: string) => ({
      key,
      label: localizedMap[key] || key
    }));
  }

  back() {
    this.close.emit();
  }

  async getVerisons(lib) {
    this.loading = true;
    lib.versionList = this.npmService.getPackageVersionList(lib.name);
    this.loading = false;
  }

  output = '';
  private libraryOperationQueue: LibraryOperation[] = [];
  private isProcessingLibraryOperationQueue = false;
  private libraryOperationStates = new Map<string, LibraryOperationState>();

  async installLib(lib: PackageInfo) {
    if (this.isLibraryOperationPending(lib.name)) {
      return;
    }

    // 检查库兼容性
    // console.log('当前开发板内核：', this.projectService.currentBoardConfig.core.replace('aily:', ''));
    // console.log('当前库兼容内核：', JSON.stringify(lib.compatibility.core));
    // if (!await this.checkCompatibility(lib.compatibility.core, this.projectService.currentBoardConfig.core.replace('aily:', ''))) {
    //   return;
    // }
    // 处理 core 字符串，去掉第一个以 ':' 分割的部分
    const boardCore = this.projectService.currentBoardConfig.core.split(':').slice(1).join(':');
    if (!await this.checkCompatibility(lib.compatibility.core, boardCore)) {
      return;
    }

    if (this.isLibraryOperationPending(lib.name)) {
      return;
    }

    this.enqueueLibraryOperation('install', lib);
  }

  async removeLib(lib: PackageInfo) {
    if (this.isLibraryOperationPending(lib.name)) {
      return;
    }

    // 移除库前，应先检查项目代码是否使用了该库，如果使用了，应提示用户
    if (this.checkLibUsage(lib)) {
      this.message.warning(this.translate.instant('LIB_MANAGER.LIB_IN_USE'), { nzDuration: 5000 });
      return;
    }

    this.enqueueLibraryOperation('uninstall', lib);
  }

  private enqueueLibraryOperation(type: LibraryOperationType, lib: PackageInfo) {
    const queuedLib = { ...lib };
    const state = type === 'install' ? 'installing' : 'uninstalling';

    this.setLibraryOperationState(lib.name, state);
    this.libraryOperationQueue.push({ type, lib: queuedLib });
    void this.processLibraryOperationQueue();
  }

  private async processLibraryOperationQueue() {
    if (this.isProcessingLibraryOperationQueue) {
      return;
    }

    this.isProcessingLibraryOperationQueue = true;
    const workflowStarted = this.workflowService.startInstall();
    const errors: string[] = [];

    try {
      while (this.libraryOperationQueue.length > 0) {
        const operation = this.libraryOperationQueue.shift();
        if (!operation) {
          continue;
        }

        const result = operation.type === 'install'
          ? await this.runInstallOperation(operation.lib)
          : await this.runUninstallOperation(operation.lib);

        if (!result.success) {
          const detail = result.error ? `: ${result.error}` : '';
          errors.push(`${this.getLibraryDisplayName(result.lib)}${detail}`);
        }
      }
    } finally {
      this.isProcessingLibraryOperationQueue = false;
      if (workflowStarted) {
        this.workflowService.finishInstall(errors.length === 0, errors.join('\n'));
      }
    }
  }

  private async runInstallOperation(lib: PackageInfo): Promise<LibraryOperationResult> {
    // console.log('当前项目路径：', this.projectService.currentProjectPath);
    // console.log('当前已安装的库列表：', packageList_old);

    this.setLibraryOperationState(lib.name, 'installing');
    this.message.loading(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.INSTALLING')}...`);
    this.output = '';
    try {
      const packageList_old = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      const packageSpec = lib.version ? `${lib.name}@${lib.version}` : lib.name;
      const { code, stderr } = await this.cmdService.runAsync(`npm install ${packageSpec}`, this.projectService.currentProjectPath);

      if (code !== 0) {
        throw new Error(stderr || `退出码: ${code}`);
      }

      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();
      // lib.state = 'default';
      this.message.success(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.INSTALLED')}`);

      let packageList_new = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      // console.log('新的已安装的库列表：', packageList_new);
      // 比对相较于旧的已安装库列表，找出新增的库
      const newPackages = packageList_new.filter(pkg => !packageList_old.some(oldPkg => oldPkg.name === pkg.name && oldPkg.version === pkg.version));
      // console.log('新增的库：', newPackages);
      for (const pkg of newPackages) {
        this.blocklyService.loadLibrary(pkg.name, this.projectService.currentProjectPath);
      }

      return { type: 'install', lib, success: true };
    } catch (error) {
      const errorMessage = this.getErrorMessage(error, 'Install failed');
      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();
      this.setDisplayedLibraryState(lib.name, 'error');
      this.message.error(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.INSTALL_FAILED')}: ${errorMessage}`);
      return { type: 'install', lib, success: false, error: errorMessage };
    }
  }

  private async runUninstallOperation(lib: PackageInfo): Promise<LibraryOperationResult> {
    this.setLibraryOperationState(lib.name, 'uninstalling');
    this.message.loading(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.UNINSTALLING')}...`);
    // 使用pathJoin处理路径，正确处理包含'/'的包名（如@aily-project/test）
    const libPackagePath = this.electronService.pathJoin(
      this.projectService.currentProjectPath,
      'node_modules',
      ...lib.name.split('/')
    );
    this.output = '';
    let libraryRemoved = false;

    try {
      if (this.checkLibUsage(lib)) {
        const message = this.translate.instant('LIB_MANAGER.LIB_IN_USE');
        this.message.warning(message, { nzDuration: 5000 });
        throw new Error(message);
      }

      this.blocklyService.removeLibrary(libPackagePath);
      libraryRemoved = true;

      const { code, stderr } = await this.cmdService.runAsync(`npm uninstall ${lib.name}`, this.projectService.currentProjectPath);
      if (code !== 0) {
        throw new Error(stderr || `退出码: ${code}`);
      }

      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();
      // lib.state = 'default';
      this.message.success(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
      return { type: 'uninstall', lib, success: true };
    } catch (error) {
      const errorMessage = this.getErrorMessage(error, 'Uninstall failed');
      this.clearLibraryOperationState(lib.name);
      await this.refreshCurrentLibraryList();

      if (libraryRemoved) {
        await this.blocklyService.loadLibrary(lib.name, this.projectService.currentProjectPath);
      }

      this.message.error(`${this.getLibraryDisplayName(lib)} ${this.translate.instant('NPM.UNINSTALL_FAILED_TITLE')}: ${errorMessage}`);
      return { type: 'uninstall', lib, success: false, error: errorMessage };
    }
  }

  private async refreshCurrentLibraryList() {
    this.libraryList = this.applyLocalization(await this.checkInstalled(this.libraryList));
    this.cd.detectChanges();
  }

  private isLibraryOperationPending(packageName: string): boolean {
    return this.libraryOperationStates.has(packageName);
  }

  private setLibraryOperationState(packageName: string, state: LibraryOperationState) {
    this.libraryOperationStates.set(packageName, state);
    this.setDisplayedLibraryState(packageName, state);
  }

  private clearLibraryOperationState(packageName: string) {
    this.libraryOperationStates.delete(packageName);
  }

  private applyLibraryOperationStates(libraryList: PackageInfo[]) {
    for (const lib of libraryList) {
      const state = this.libraryOperationStates.get(lib.name);
      if (state) {
        lib.state = state;
      }
    }
    return libraryList;
  }

  private setDisplayedLibraryState(packageName: string, state: PackageInfo['state']) {
    for (const lib of this.libraryList) {
      if (lib.name === packageName) {
        lib.state = state;
      }
    }
    this.cd.detectChanges();
  }

  private getLibraryDisplayName(lib: PackageInfo): string {
    return lib._nickname || lib.nickname || lib.name;
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


  checkLibUsage(lib) {
    // 检查项目代码是否使用了该库
    const separator = this.platformService.getPlatformSeparator();
    const libPackagePath = this.projectService.currentProjectPath + `${separator}node_modules${separator}` + lib.name;
    const libBlockPath = libPackagePath + `${separator}block.json`;
    const blocksData = JSON.parse(this.electronService.readFile(libBlockPath));
    const abiJson = JSON.stringify(this.blocklyService.getProjectDocument());
    for (let index = 0; index < blocksData.length; index++) {
      const element = blocksData[index];
      if (abiJson.includes(element.type)) {
        return true;
      }
    }
    return false;
  }

  async checkCompatibility(libCompatibility, boardCore): Promise<boolean> {
    // 检查项目是否有未保存的更改
    if (!libCompatibility || libCompatibility.length == 0 || libCompatibility.includes(boardCore)) {
      return true;
    }
    // 遍历libCompatibility，判断每个元素是否包含boardCore
    for (let i = 0; i < libCompatibility.length; i++) {
      const element = libCompatibility[i];
      if (element.includes(boardCore)) {
        return true;
      }
    }

    return new Promise<boolean>((resolve) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '360px',
        nzContent: CompatibleDialogComponent,
        nzData: { libCompatibility, boardCore },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'continue':
            resolve(true);
            break;
          case 'cancel':
            resolve(false);
            break;
          default:
            resolve(false);
            break;
        }
      });
    });
  }

  private applyLocalization(list: any[]) {
    const lang = this.translate.currentLang;
    for (const lib of list) {
      lib._nickname = (lang && lib[`nickname_${lang}`]) || lib.nickname || '';
      lib._description = (lang && lib[`description_${lang}`]) || lib.description || '';
    }
    return list;
  }

  openExample(packageName) {
    this.electronService.openNewInStance('/main/playground/s/' + packageName.replace('@aily-project/', ''))
  }

  private getImportedLibraryBasePath() {
    return this.electronService.pathJoin(this.projectService.currentProjectPath, 'local-libraries');
  }

  private resolveImportedLibraryPath(packageName: string) {
    return this.electronService.pathJoin(this.getImportedLibraryBasePath(), ...packageName.split('/'));
  }

  private async copyLibraryToProject(folderPath: string): Promise<{ importedLibraryPath: string; packageName: string }> {
    const packageJsonPath = this.electronService.pathJoin(folderPath, 'package.json');
    const packageJson = JSON.parse(this.electronService.readFile(packageJsonPath));
    const packageName = packageJson?.name;

    if (!packageName) {
      throw new Error('package.json 缺少 name 字段');
    }

    const importedLibraryPath = this.resolveImportedLibraryPath(packageName);
    const importedLibraryParentPath = this.electronService.pathJoin(importedLibraryPath, '..');

    await this.crossPlatformCmdService.createDirectory(importedLibraryParentPath, true);

    if (folderPath !== importedLibraryPath && this.electronService.exists(importedLibraryPath)) {
      await this.crossPlatformCmdService.removeItem(importedLibraryPath, true, true);
    }

    if (folderPath !== importedLibraryPath) {
      await this.crossPlatformCmdService.copyItem(folderPath, importedLibraryPath, true, true);
    }

    return { importedLibraryPath, packageName };
  }

  /** 记录包名 → 本机原库目录，供打开项目时监听原库变更并同步到 local-libraries */
  private mergeAilyLocalLibrarySource(packageName: string, sourceFolderPath: string): void {
    const projectPath = this.projectService.currentProjectPath;
    const pkgPath = this.electronService.pathJoin(projectPath, 'package.json');
    const pkg = JSON.parse(this.electronService.readFile(pkgPath));
    if (!pkg[AILY_LOCAL_LIBRARY_SOURCES_KEY] || typeof pkg[AILY_LOCAL_LIBRARY_SOURCES_KEY] !== 'object') {
      pkg[AILY_LOCAL_LIBRARY_SOURCES_KEY] = {};
    }
    pkg[AILY_LOCAL_LIBRARY_SOURCES_KEY][packageName] = sourceFolderPath;
    this.electronService.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    window['packageJson'] = pkg;
    if (this.projectService.currentPackageData) {
      Object.assign(this.projectService.currentPackageData, pkg);
    }
  }

  /** 将绝对路径转为 npm file: 用的 POSIX 相对路径（相对项目根） */
  private fileDependencyFromProject(importedLibraryPath: string): string {
    const projectPath = this.projectService.currentProjectPath;
    const rel = window['path'].relative(projectPath, importedLibraryPath);
    const normalized = rel.split(/[/\\]/).join('/');
    return normalized.startsWith('.') ? normalized : `./${normalized}`;
  }

  async importLib() {
    try {
      // 弹出文件夹选择对话框
      const folderPath = await window['ipcRenderer'].invoke('select-folder', {
        path: this.projectService.currentProjectPath,
      });

      // 如果用户取消选择，返回
      if (!folderPath || folderPath === this.projectService.currentProjectPath) {
        return;
      }

      // console.log('选择的文件夹路径：', folderPath);

      // 检查选择的路径下是否有package.json、block.json、generator.js文件
      const hasPackageJson = await this.electronService.exists(this.electronService.pathJoin(folderPath, 'package.json'));
      const hasBlockJson = await this.electronService.exists(this.electronService.pathJoin(folderPath, 'block.json'));
      const hasGeneratorJs = await this.electronService.exists(this.electronService.pathJoin(folderPath, 'generator.js'));

      if (!hasPackageJson || !hasBlockJson || !hasGeneratorJs) {
        this.message.error(`${this.translate.instant('LIB_MANAGER.IMPORT_FAILED')}: 该路径下不是aily blockly库`);
        return;
      }

      this.message.loading(`${this.translate.instant('LIB_MANAGER.IMPORTING')}...`);

      // 获取安装前的库列表
      let packageList_old = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      // console.log('导入前已安装的库列表：', packageList_old);

      // 先复制库到当前项目目录下，再从项目内的副本执行安装（file: 相对路径，便于整项目拷贝/压缩）
      const { importedLibraryPath, packageName } = await this.copyLibraryToProject(folderPath);
      this.mergeAilyLocalLibrarySource(packageName, folderPath);

      const fileDep = this.fileDependencyFromProject(importedLibraryPath);
      const installSpec = `${packageName}@file:${fileDep}`;
      const { code, stderr } = await this.cmdService.runAsync(
        `npm install "${installSpec}"`,
        this.projectService.currentProjectPath,
      );

      if (code !== 0) {
        throw new Error(stderr || '安装导入库失败');
      }

      this.localLibrarySyncService.stop();
      this.localLibrarySyncService.start(this.projectService.currentProjectPath);

      // 重新检查已安装的库
      this.libraryList = this.applyLocalization(await this.checkInstalled());

      this.message.success(`${this.translate.instant('LIB_MANAGER.IMPORTED')}`);

      // 获取安装后的库列表并加载新增的库
      let packageList_new = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      // console.log('导入后已安装的库列表：', packageList_new);

      // 比对相较于旧的已安装库列表，找出新增的库
      const newPackages = packageList_new.filter(pkg => !packageList_old.some(oldPkg => oldPkg.name === pkg.name && oldPkg.version === pkg.version));
      // console.log('新导入的库：', newPackages);

      // 加载新增的库到 Blockly
      for (const pkg of newPackages) {
        this.blocklyService.loadLibrary(pkg.name, this.projectService.currentProjectPath);
      }
    } catch (error) {
      console.error('导入库失败：', error);
      this.message.error(`${this.translate.instant('LIB_MANAGER.IMPORT_FAILED')}: ${error.message || error}`);
    }
  }

  help() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries/blob/main/readme.md');
  }

  report() {
    this.electronService.openUrl('https://github.com/ailyProject/aily-blockly-libraries/issues');
  }

  openUrl(url: string) {
    this.electronService.openUrl(url);
  }
}

interface PackageInfo {
  "name": string,
  "nickname": string,
  "scope"?: string,
  "description"?: string,
  "version"?: string,
  "versionList"?: string[],
  "keywords"?: string[],
  "date"?: string,
  "author"?: {
    "name"?: string
  },
  icon?: string,
  "publisher"?: any,
  "maintainers"?: any[],
  "links"?: any,
  "brand"?: string,
  compatibility?: {
    core?: string[],
    [key: string]: any
  },
  "fulltext"?: string,
  url?: string,
  tested: boolean,
  state: 'default' | 'installed' | 'installing' | 'uninstalling' | 'error',
  example?: string,
  _nickname?: string,
  _description?: string,
  [key: string]: any
}

type LibraryOperationType = 'install' | 'uninstall';
type LibraryOperationState = 'installing' | 'uninstalling';

interface LibraryOperation {
  type: LibraryOperationType;
  lib: PackageInfo;
}

interface LibraryOperationResult extends LibraryOperation {
  success: boolean;
  error?: string;
}
