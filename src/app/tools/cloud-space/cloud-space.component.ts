import { Component } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '@core/app-shell/public-api';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { EditorComponent } from './editor/editor.component';
import { CloudService } from './services/cloud.service';
import {
  ProjectService,
  projectDataRuntime,
  assertNoOversizedInlineValues,
  extractStructuredAbsValues,
  detectProjectMode,
} from '@domain/project/public-api';
import { CmdService, ElectronService, PlatformService, CrossPlatformCmdService } from '@core/platform/public-api';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AuthService } from '@core/auth/public-api';
import { LoginDialogComponent } from '../../main-window/components/login-dialog/login-dialog.component';
import { NzModalService } from 'ng-zorro-antd/modal';
import { distinctUntilChanged } from 'rxjs/operators';
import { firstValueFrom, Subscription } from 'rxjs';
import { resolveTranslatedApiErrorMessage } from '../../utils/api-error.utils';
import { AILY_LOCAL_LIBRARY_SOURCES_KEY } from '@domain/dependencies/public-api';
import { TranslateService } from '@ngx-translate/core';
import { ConfigService } from '@core/preferences/public-api';
import { readSavedProjectProgram, type SavedProjectProgram } from '../../integrations/blockly/abs/abs-program-reader';
import { publishProjectText } from '../../services/core/platform/project-file-publication';
import { chooseCloudSyncConflictAction, confirmCloudSyncOverwrite } from './services/cloud-sync-conflict';
import {
  archiveHash, cloudSourceStamp, projectCloudIdentity, readLocalCloudArchive,
  readCloudSyncConflict, readCloudSyncState, writeCloudSyncState, type CloudSyncState,
} from './services/cloud-sync-state';


@Component({
  selector: 'app-cloud-space',
  imports: [
    ToolContainerComponent,
    FormsModule,
    CommonModule,
    NzButtonModule,
    EditorComponent
  ],
  templateUrl: './cloud-space.component.html',
  styleUrl: './cloud-space.component.scss'
})
export class CloudSpaceComponent {

  itemList = []
  filteredItemList = [] // 过滤后的项目列表
  isSyncing = false;
  canSync = false; // 是否可以同步（当前有打开项目且项目已保存）

  editorProjectData = null;
  searchKeyword = ''; // 搜索关键词
  isLoginDialogOpen = false; // 标记登录对话框是否已打开

  openingProjectIds = new Set<string>();
  projectView: 'mine' | 'students' = 'mine';
  isStudent = false;
  isTeacher = false;
  isLoading = false;
  private subscriptions = new Subscription();
  private listSubscription = new Subscription();
  private editorSubscription = new Subscription();
  private imageObjectUrls: string[] = [];
  private openIntent = 0;
  private readonly incompleteOpens = new Map<string, { path: string; identity: string; archiveSha256: string }>();

  private cloudScope(): string {
    const userId = this.authService.currentUser?.id;
    return userId === undefined || userId === null ? '' : JSON.stringify([this.cloudService.baseUrl, String(userId)]);
  }


  constructor(
    private uiService: UiService,
    private cloudService: CloudService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private message: NzMessageService,
    private authService: AuthService,
    private modal: NzModalService,
    private electronService: ElectronService,
    private platformService: PlatformService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private translate: TranslateService,
    private configService: ConfigService,
  ) { }

  // 分页参数
  currentPage = 1;
  pageSize = 100;
  totalProjects = 0;

  ngOnInit(): void {
    this.subscriptions.add(this.projectService.currentProjectPath$.subscribe(path => {
      // console.log('当前项目路径变化:', path);
      this.canSync = !!path;
    }));

    // this.authService.checkAndSyncAuthStatus().then((res) => {
    //   if (!res) {
    //     this.openLoginDialog();
    //   }
    // });

    // 检查用户是否登录
    this.subscriptions.add(this.authService.userInfo$
      .pipe(distinctUntilChanged((previous, current) => previous?.id === current?.id
        && previous?.education_student === current?.education_student
        && previous?.education_teacher === current?.education_teacher))
      .subscribe(user => {
        ++this.openIntent;
        this.clearProjects();
        this.isStudent = user?.education_student === true;
        this.isTeacher = user?.education_teacher === true;
        this.projectView = 'mine';
        this.currentPage = 1;
        if (user) {
          // 用户已登录时关闭可能存在的登录对话框状态标记
          this.isLoginDialogOpen = false;
          this.getCloudProjects().then(
            () => { console.log('云项目列表获取完成'); }
          );
          // 初始化时显示所有项目
          this.filteredItemList = [...this.itemList];
        }
      }));
  }

  ngOnDestroy(): void {
    ++this.openIntent;
    this.subscriptions.unsubscribe();
    this.clearProjects();
  }

  private clearProjects(): void {
    this.listSubscription.unsubscribe();
    this.editorSubscription.unsubscribe();
    this.showEditor = false;
    this.editorProjectData = null;
    this.imageObjectUrls.forEach(url => URL.revokeObjectURL(url));
    this.imageObjectUrls = [];
    this.itemList = [];
    this.filteredItemList = [];
    this.totalProjects = 0;
    this.isLoading = false;
  }

  switchProjectView(view: 'mine' | 'students'): void {
    if (view === 'students' && !this.isTeacher) return;
    this.projectView = view;
    this.currentPage = 1;
    this.searchKeyword = '';
    this.getCloudProjects();
  }

  changePage(page: number): void {
    this.currentPage = page;
    this.getCloudProjects();
  }

  canEditProject(item): boolean {
    return !item?.student || (this.isTeacher && item.student.active === true);
  }

  canPublishProject(item): boolean {
    return !this.isStudent && this.canEditProject(item);
  }

  async requestSync(): Promise<void> {
    if (this.isSyncing || !this.projectService.currentProjectPath) return;
    const projectPath = this.projectService.currentProjectPath;
    try {
      const manifest = JSON.parse(this.electronService.readFile(`${projectPath}/package.json`));
      let target: any;
      if (this.isTeacher && manifest.cloudId) {
        const response = await firstValueFrom(this.cloudService.getProject(manifest.cloudId));
        if (this.projectService.currentProjectPath !== projectPath
          || JSON.parse(this.electronService.readFile(`${projectPath}/package.json`)).cloudId !== manifest.cloudId) {
          throw new Error('当前项目已切换，请重新同步');
        }
        if (response.status === 404) {
          target = null;
        } else {
          if (response.status !== 200) throw new Error(response.messages || '无法确认项目权限');
          target = response.data;
        }
      }
      if (target?.student) {
        if (!this.canEditProject(target)) {
          this.message.error('该学生已停用，项目仅可查看和打开');
          return;
        }
        this.modal.confirm({
          nzTitle: '更新学生原项目',
          nzContent: `将用当前本地项目更新 ${target.student.nickname || target.student.email} 的“${target.nickname || target.name}”，项目仍归该学生所有。`,
          nzOkText: '更新原项目',
          nzOnOk: () => this.syncToCloud(target),
        });
      } else {
        await this.syncToCloud();
      }
    } catch (error) {
      this.message.error('无法同步项目: ' + error);
    }
  }

  // openLoginDialog() {
  //   this.isLoginDialogOpen = true;
  //   const modalRef = this.modal.create({
  //     nzTitle: null,
  //     nzFooter: null,
  //     nzClosable: false,
  //     nzBodyStyle: {
  //       padding: '0',
  //     },
  //     nzWidth: '350px',
  //     nzContent: LoginDialogComponent
  //   });

  //   // 当对话框关闭时重置状态
  //   modalRef.afterClose.subscribe(() => {
  //     this.isLoginDialogOpen = false;
  //   });
  // }

  async openInNewTab(item): Promise<void> {
    if (!item?.id || this.openingProjectIds.has(item.id)) return;
    const scope = this.cloudScope();
    const key = JSON.stringify([scope, String(item.id)]);
    const intent = ++this.openIntent;
    const currentView = this.projectService.projectViewRevision;
    const current = () => this.openIntent === intent && this.cloudScope() === scope
      && this.projectService.projectViewRevision === currentView;
    this.openingProjectIds.add(item.id);
    let extracted: string | undefined;
    let target = this.incompleteOpens.get(key);
    try {
      if (!target) {
        const result = await firstValueFrom(this.cloudService.openProjectArchive(item.id));
        extracted = result.path;
        if (!current()) return;
        const randomNum = Math.floor(100000 + Math.random() * 900000);
        const coder = item.category === 'coder' || this.configService.isCoderProduct();
        const entries: Array<{ name: string; _isFile: boolean }> = coder ? [] : window['fs'].readDirSync(extracted);
        const useArchiveImport = coder || !entries.some(entry => entry.name.toLowerCase() === 'package.json' && entry._isFile)
          || entries.some(entry => entry.name.toLowerCase() === '.workspace-history');
        const projectName = String(item.name || 'cloud_project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
          .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60) || 'cloud_project';
        let targetPath = this.projectService.projectRootPath + this.platformService.getPlatformSeparator() + `${projectName}_${randomNum}`;
        if (useArchiveImport) targetPath = this.projectService.importProjectDirectory(extracted, targetPath, true);
        else await this.crossPlatformCmdService.copyItem(extracted, targetPath, true, true);
        target = { path: targetPath, identity: projectCloudIdentity(targetPath), archiveSha256: result.archiveSha256 };
        this.incompleteOpens.set(key, target);
      }
      if (!current()) return;
      const projectPath = target.path, attachment = target.identity;
      if (projectCloudIdentity(projectPath) !== attachment) {
        this.incompleteOpens.delete(key);
        throw new Error('原下载目录已被替换，请重新下载');
      }
      const packagePath = `${target.path}/package.json`;
      const original = this.electronService.readFile(packagePath);
      const manifest = JSON.parse(original);
      manifest.nickname = item.nickname;
      manifest.description = item.description || '';
      manifest.doc_url = item.doc_url || '';
      manifest.keywords = item.tags ? JSON.parse(item.tags) : [];
      manifest.cloudId = item.id;
      await publishProjectText(projectPath, 'package.json', JSON.stringify(manifest, null, 2), original, () => {
        if (!current() || projectCloudIdentity(projectPath) !== attachment) throw new Error('下载目标已切换');
      });
      if (current() && projectCloudIdentity(projectPath) === attachment && archiveHash(target.archiveSha256) && scope) {
        writeCloudSyncState(projectPath, { version: 1, identity: attachment, scope,
          binding: { cloudId: String(item.id), archiveSha256: target.archiveSha256 } });
      }
      if (current() && await this.projectService.projectOpen(projectPath) === true) this.incompleteOpens.delete(key);
      else if (this.openIntent === intent) this.message.warning(`项目已下载到 ${projectPath}，尚未打开，可点同一项目继续打开`);
    } catch (error) {
      if (this.openIntent === intent && this.cloudScope() === scope) {
        const detail = error instanceof Error ? error.message : String(error);
        this.message.error(target
          ? `项目已下载到 ${target.path}，打开失败：${detail}。可点同一项目继续打开`
          : `下载失败：${detail}`);
      }
    } finally {
      if (extracted) this.cloudService.cleanupExtractedFiles(extracted);
      this.openingProjectIds.delete(item.id);
    }
  }

  // 获取云上项目列表
  async getCloudProjects() {
    this.clearProjects();
    this.isLoading = true;
    this.listSubscription = new Subscription();
    const request = this.projectView === 'students'
      ? this.cloudService.getStudentProjects(this.currentPage, this.pageSize)
      : this.cloudService.getProjects(this.currentPage, this.pageSize);
    this.listSubscription.add(request.subscribe({ next: res => {
      this.isLoading = false;
      if (res && res.status === 200) {
        const lastPage = Math.max(1, Math.ceil(res.data.total / this.pageSize));
        if (this.currentPage > lastPage) {
          this.currentPage = lastPage;
          this.getCloudProjects();
          return;
        }
        this.itemList = [];
        res.data.list.forEach(prj => {
          // 图片url
          const imagePath = prj.image_url;
          prj.image_url = this.configService.getDefaultProjectImageSrc();
          if (imagePath) {
            const separator = imagePath.includes('?') ? '&' : '?';
            this.listSubscription.add(this.cloudService.getProjectImage(`${imagePath}${separator}t=${Date.now()}`).subscribe({
              next: blob => {
                const imageUrl = URL.createObjectURL(blob);
                this.imageObjectUrls.push(imageUrl);
                prj.image_url = imageUrl;
              },
              error: () => { /* 无权访问或无封面时保留默认图。 */ },
            }));
          }
          this.itemList.push(prj);
        });
        this.totalProjects = res.data.total;
        // console.log('获取云上项目列表成功:', this.itemList);
        // 应用搜索过滤
        this.filterProjects();
      } else {
        this.message.error(res?.messages || '获取云上项目列表失败');
      }
    }, error: error => {
      this.isLoading = false;
      this.message.error('获取云上项目列表失败: ' + error);
    } }));
  }

  // 过滤项目列表
  filterProjects() {
    if (!this.searchKeyword || this.searchKeyword.trim() === '') {
      this.filteredItemList = [...this.itemList];
    } else {
      const keyword = this.searchKeyword.toLowerCase().trim();
      this.filteredItemList = this.itemList.filter(item => {
        const nickname = (item.nickname || '').toLowerCase();
        const description = (item.description || '').toLowerCase();
        const name = (item.name || '').toLowerCase();
        const student = `${item.student?.nickname || ''} ${item.student?.email || ''}`.toLowerCase();
        return nickname.includes(keyword) || description.includes(keyword) || name.includes(keyword) || student.includes(keyword);
      });
    }
    // console.log('过滤后的项目列表:', this.filteredItemList);
  }

  // 搜索关键词变化时触发
  onSearchChange() {
    this.filterProjects();
  }

  // 删除7z文件
  async delete7zFile(archivePath: string) {
    if (window['fs'].existsSync(archivePath)) {
      window['fs'].unlinkSync(archivePath);
      // console.log('删除已存在的7z文件:', archivePath);
    }
  }

  // 打包项目
  async packageProject(prjPath: string, { detachCloudProject = false } = {}): Promise<string | undefined> {
    // 判断路径是否存在
    if (!await window['fs'].existsSync(prjPath)) {
      this.message.error('当前未打开项目，无法同步');
      console.warn('项目路径不存在:', prjPath);
      return;
    }

    const archivePath = `${prjPath}/project.7z`;
    await this.delete7zFile(archivePath);

    // 检查要打包的文件是否存在
    const packageJsonPath = `${prjPath}/package.json`;
    if (!await window['fs'].existsSync(packageJsonPath)) {
      this.message.error('package.json 文件不存在，无法打包');
      console.warn('package.json 不存在:', packageJsonPath);
      return;
    }

    let cloudPackageJson;
    try {
      cloudPackageJson = JSON.parse(this.electronService.readFile(packageJsonPath));
    } catch (error) {
      this.message.error('package.json 格式错误，无法打包');
      console.error('读取 package.json 失败:', error);
      return;
    }

    const abiPath = window['path'].join(prjPath, 'project.abi');
    const aciPath = window['path'].join(prjPath, 'project.aci');
    const hasAci = window['fs'].existsSync(aciPath);
    const isCoder = detectProjectMode({
      manifest: cloudPackageJson,
      hasAbi: window['fs'].existsSync(abiPath),
      hasAci,
    }) === 'coder';
    let savedProgram: SavedProjectProgram | undefined;
    if (isCoder) {
      // Coder 保存的是源码工作区，不依赖 Blockly ABI/ABS 或外置数据运行时。
      let hasSource = window['fs'].existsSync(window['path'].join(prjPath, 'sketch'));
      if (!hasSource && hasAci) {
        try {
          const aci = window['fs'].statSync(aciPath);
          hasSource = aci._isFile && aci.size > 0;
        } catch { /* Treat unavailable legacy source as missing. */ }
      }
      if (!hasSource) {
        this.message.error('Coder 项目源码不存在，无法打包');
        return;
      }
    } else {
      try {
        await projectDataRuntime.flushPending();
        savedProgram = await readSavedProjectProgram(prjPath, () => undefined);
        cloudPackageJson = JSON.parse(savedProgram.packageText);
        const abiText = savedProgram.files['project.abi'];
        if (abiText === null) throw new Error('A complete saved project document is unavailable.');
        const abi = JSON.parse(abiText);
        assertNoOversizedInlineValues(abi);
        const roots: unknown[] = [abi];
        const abs = savedProgram.files['project.abs'];
        if (abs !== null) {
          roots.push(...extractStructuredAbsValues(abs, { strict: true }));
        }
        const validation = await projectDataRuntime.getStore().validateReferences(
          roots.flatMap((root) => projectDataRuntime.getStore().collectReferences(root)),
        );
        if (!validation.valid) {
          throw new Error(validation.issues.map((issue) => issue.error).join('; '));
        }
      } catch (error) {
        this.message.error('项目数据资源不完整，无法打包');
        console.error('项目数据资源预检失败:', error);
        return;
      }
    }
    const hasLocalLibrarySources = Object.prototype.hasOwnProperty.call(
      cloudPackageJson,
      AILY_LOCAL_LIBRARY_SOURCES_KEY,
    );
    delete cloudPackageJson[AILY_LOCAL_LIBRARY_SOURCES_KEY];
    if (detachCloudProject) delete cloudPackageJson.cloudId;
    const replacePackage = hasLocalLibrarySources || detachCloudProject;

    // console.log('开始打包项目:', prjPath);

    // 构建更安全的打包命令
    // 打包所有文件，但排除特定目录和文件
    // -x!node_modules: 排除 node_modules
    // -xr!.*: 递归排除所有以 "." 开头的文件和目录
    // -x!package-lock.json: 排除 package-lock.json
    // -x!project.7z: 排除自身
    // 注意：在某些shell环境下，!可能需要转义或引用，这里使用引号包裹排除项
    // Cloud projects reopen from ABI; ABS identity maps belong to the source's local baseline.
    let packCommand = `${this.platformService.za7} a -t7z -mx=9 "${archivePath}" * "-x!node_modules" "-xr!.*" "-x!package-lock.json" "-x!project.7z" "-x!project.abi" "-x!package.json" "-x!project.abi.backup" "-x!project.abs" "-x!project.abs.map.json"`;
    if (isCoder) {
      // 保留 sketch 源码、本地库和 .aily-component-library.json 来源记录。
      // 通配符末尾的 / 让 7-Zip 只匹配点开头的目录，保留其他点开头的文件。
      const exclusions = [
        '-x!node_modules', '-x!package-lock.json', '-x!project.7z',
        '-x!project.abi', '-x!project.abi.backup', '-x!project.abs', '-x!project.abs.map.json',
        '-xr!.*/', '-xr!.git', '-xr!.aily', '-xr!.temp', '-xr!.build', '-xr!.cache', '-xr!.pio',
        '-xr!.DS_Store', '-xr!.env*',
        '-x!sketch/preprocess.json', '-x!sketch/library-cache.json',
        '-x!sketch/build-config.json', '-x!sketch/upload-config.json',
        '-x!sketch/target-compile.json',
        '-x!sketch/compile-preprocess-*.json',
      ];
      packCommand = `${this.platformService.za7} a -t7z -mx=9 "${archivePath}" * ${exclusions.map(value => `"${value}"`).join(' ')}`;
    }
    if (replacePackage && isCoder) {
      packCommand += ` "-x!package.json"`;
    }
    
    // console.log('执行打包命令:', packCommand);
    const result = await this.cmdService.runAsync(packCommand, prjPath, false);

    // console.log('打包命令执行结果:', result);

    // 检查打包是否成功
    if (result.type === 'error' || (result.code && result.code !== 0)) {
      this.message.error('项目打包失败：' + (result.error || result.data || '请检查本地磁盘空间和文件写入权限'));
      console.error('7za打包失败:', result);
      return;
    }

    if (savedProgram || replacePackage) {
      const stagingDir = window['path'].join(
        window['os'].tmpdir(),
        `aily-cloud-package-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      let stagingOwned = false;
      try {
        window['fs'].mkdirSync(stagingDir);
        stagingOwned = true;
        window['fs'].writeFileSync(
          window['path'].join(stagingDir, 'package.json'),
          JSON.stringify(cloudPackageJson, null, 2),
        );
        if (savedProgram) window['fs'].writeFileSync(window['path'].join(stagingDir, 'project.abi'), savedProgram.files['project.abi']);
        const addPackageResult = await this.cmdService.runAsync(
          `${this.platformService.za7} a -t7z "${archivePath}" "package.json"${savedProgram ? ' "project.abi"' : ''}`,
          stagingDir,
          false,
        );
        if (addPackageResult.type === 'error' || (addPackageResult.code && addPackageResult.code !== 0)) {
          this.message.error('项目打包失败: 无法写入已保存的项目快照');
          console.error('写入云端 package.json 失败:', addPackageResult);
          return;
        }
      } finally {
        if (stagingOwned) window['fs'].rmSync(stagingDir, { recursive: true, force: true });
      }
    }

    // 等待文件系统完成写入
    await new Promise(resolve => setTimeout(resolve, 500));

    // 验证生成的7z文件
    if (!window['fs'].existsSync(archivePath)) {
      this.message.error('7z文件生成失败');
      console.error('7z文件不存在:', archivePath);
      return;
    }

    // 检查文件大小（多次检查确保文件完整）
    let fileStats = window['fs'].statSync(archivePath);
    let retryCount = 0;

    // 如果文件大小为0，等待一段时间后重试
    while (fileStats.size === 0 && retryCount < 5) {
      // console.log(`文件大小为0，等待重试... (${retryCount + 1}/5)`);
      await new Promise(resolve => setTimeout(resolve, 300));
      fileStats = window['fs'].statSync(archivePath);
      retryCount++;
    }

    if (fileStats.size === 0) {
      this.message.error('生成的7z文件为空，打包过程可能失败');
      console.error('7z文件为空:', archivePath);

      // 尝试手动检查打包命令的输出
      console.error('打包命令输出:', result.data);
      return;
    }

    // console.log('7z文件生成成功:', {
    //   path: archivePath,
    //   size: fileStats.size
    // });

    return archivePath;
  }

  syncProject() {
    let project = {
      name: '项目名称',  // packagename, 唯一的
      nickname: '项目昵称',  // 显示出来的名字
      description: '项目描述', // 项目描述
      image: "hhaha.webp", // 项目图片 500x250
      createTime: '2024-01-01 12:00:00', // 实际不传，服务器生成
      updateTime: '2024-01-01 12:00:00', // 实际不传，服务器生成

    }

    // cloudService.uploadProject(project)
  }

  private async finishCloudSync(projectPath: string, state: CloudSyncState, result: any): Promise<void> {
    const pending = state.pending;
    const savedAsNew = pending?.resolution?.kind === 'save-new';
    const previousCloudId = state.binding?.cloudId;
    const resultId = String(result?.id ?? '');
    if (!pending || result?.request_id !== pending.requestId || result.state !== 'committed'
      || !resultId || (typeof result.id !== 'number' && typeof result.id !== 'string')
      || result.archive_sha256 !== pending.archiveSha256
      || (savedAsNew ? !previousCloudId || resultId === previousCloudId : previousCloudId && resultId !== previousCloudId)) {
      throw new Error('云端返回的同步回执无法确认');
    }

    const assertSource = () => {
      if (this.cloudScope() !== state.scope || projectCloudIdentity(projectPath) !== state.identity) {
        throw new Error('同步来源目录或账号已切换');
      }
    };
    assertSource();
    // Compare before updating the local cloud association, which changes package.json.
    const changed = cloudSourceStamp(projectPath, pending.category) !== pending.before ||
      (this.projectService.currentProjectPath === projectPath && await this.projectService.hasUnsavedChanges());
    const packagePath = `${projectPath}/package.json`;
    assertSource();
    const original = this.electronService.readFile(packagePath), manifest = JSON.parse(original);
    const localCloudId = String(manifest.cloudId ?? '');
    if (localCloudId !== resultId && localCloudId !== (previousCloudId ?? '')) {
      throw new Error('本地工程的云端关联已变化');
    }
    manifest.cloudId = result.id;
    const updated = JSON.stringify(manifest, null, 2);
    if (updated !== original) await publishProjectText(projectPath, 'package.json', updated, original, assertSource);
    assertSource();
    writeCloudSyncState(projectPath, { version: 1, identity: state.identity, scope: state.scope,
      binding: { cloudId: resultId, archiveSha256: result.archive_sha256 } });
    if (this.projectService.currentProjectPath === projectPath) this.projectService.currentPackageData = manifest;
    try {
      await this.delete7zFile(`${projectPath}/project.7z`);
    } catch (error) {
      console.warn('云同步临时归档清理失败', error);
    }
    if (changed) this.message.warning(savedAsNew ? '已另存为新云工程，还有新的本地修改待同步'
      : '上次提交已同步，工程还有新的本地修改，尚未同步');
    else this.message.success(savedAsNew ? '已另存为新云工程' : '同步成功');
    await this.getCloudProjects();
  }

  private async observeCloudSync(requestId: string): Promise<any> {
    const response = await firstValueFrom(this.cloudService.observeSyncRequest(requestId));
    if (response?.status !== 200 || response.data?.request_id !== requestId
      || !['unconfirmed', 'running', 'committed'].includes(response.data.state)) {
      throw new Error('云端未提供可核对的同步回执');
    }
    return response.data;
  }

  async syncToCloud(studentProject?): Promise<void> {
    if (this.isSyncing || !this.projectService.currentProjectPath) return;
    this.isSyncing = true;
    const projectPath = this.projectService.currentProjectPath;
    const scope = this.cloudScope();
    const archivePath = `${projectPath}/project.7z`;
    let identity: string, retainArchive = false, archiveOwned = false;
    try {
      if (!scope) throw new Error('请登录后同步项目');
      identity = projectCloudIdentity(projectPath);
      const active = this.projectService.captureCurrentProjectGuard();
      const assertActive = () => {
        if (!active() || this.cloudScope() !== scope || projectCloudIdentity(projectPath) !== identity) {
          throw new Error('当前项目或登录账号已切换，请重新同步');
        }
      };
      const state = readCloudSyncState(projectPath, identity, scope);
      const readManifest = () => JSON.parse(this.electronService.readFile(`${projectPath}/package.json`));
      let manifest = readManifest();
      if (studentProject && (String(manifest.cloudId) !== String(studentProject.id) || !this.canEditProject(studentProject))) {
        throw new Error('当前本地项目与学生项目不一致，请重新打开学生项目');
      }
      let pending = state.pending;
      let archive: Awaited<ReturnType<typeof readLocalCloudArchive>>;
      retainArchive = !!pending;
      archiveOwned = !!pending;
      if (pending) {
        const original = await this.observeCloudSync(pending.requestId);
        if (original.state === 'committed') {
          await this.finishCloudSync(projectPath, state, original);
          return;
        }
        if (original.state === 'running') {
          this.message.info('上次同步仍在处理，请稍后再次检查');
          return;
        }
        assertActive();
        archive = await readLocalCloudArchive(archivePath);
        if (archive.sha256 !== pending.archiveSha256) {
          throw new Error('上次同步的归档已变化，请先检查云空间的原提交结果');
        }
      } else {
        if (manifest.cloudId && state.binding?.cloudId !== String(manifest.cloudId)) {
          throw new Error('缺少此云工程的原始版本，请重新下载云工程，或另存为新工程以保留本地修改');
        }
        const save = await this.projectService.save(projectPath);
        if (!save.success) {
          this.message.error(`项目保存失败，无法同步：${save.error || '未确认保存'}`);
          return;
        }
        assertActive();
        manifest = readManifest();
        if (String(manifest.cloudId || '') !== (state.binding?.cloudId || '')) throw new Error('当前工程的云端关联已变化');
        const category = this.projectService.getProjectMode(projectPath) === 'coder' ? 'coder' : 'blockly';
        const before = cloudSourceStamp(projectPath, category), requestId = crypto.randomUUID();
        archiveOwned = true;
        if (!await this.packageProject(projectPath)) return;
        assertActive();
        if (cloudSourceStamp(projectPath, category) !== before) throw new Error('工程在打包期间已变化，请重新同步');
        archive = await readLocalCloudArchive(archivePath);
        const observed = await this.observeCloudSync(requestId);
        assertActive();
        if (observed.state !== 'unconfirmed') throw new Error('无法建立新同步请求');
        delete manifest[AILY_LOCAL_LIBRARY_SOURCES_KEY];
        pending = { requestId, archiveSha256: archive.sha256, category, projectData: manifest, before };
        state.pending = pending;
        writeCloudSyncState(projectPath, state);
        retainArchive = true;
      }
      assertActive();
      while (true) {
        const saveNew = pending.resolution?.kind === 'save-new';
        const overwrite = pending.resolution?.kind === 'overwrite' ? pending.resolution.remote : undefined;
        const cloudId = state.binding?.cloudId;
        assertActive();
        if (String(readManifest().cloudId ?? '') !== (cloudId ?? '')) throw new Error('当前工程的云端关联已变化');
        let response: any;
        try {
          response = await firstValueFrom(this.cloudService.syncProject({
            pid: saveNew ? undefined : cloudId,
            expectedArchiveSha256: saveNew ? undefined : overwrite?.archiveSha256 ?? state.binding?.archiveSha256,
            expectedArchiveRevision: overwrite?.archiveRevision,
            requestId: pending.requestId, projectData: pending.projectData,
            archive: archivePath, archiveContents: archive.contents, category: pending.category,
          }));
        } catch (error) {
          response = error?.error;
        }
        if (response?.status === 200) {
          await this.finishCloudSync(projectPath, state, response.data);
          return;
        }
        if (!(response?.status >= 400 && response.status < 500) || response.errorCode === 'WORKSPACE_SYNC_REQUEST_RUNNING') {
          // A transport failure only observes the original request.
          const observed = await this.observeCloudSync(pending.requestId).catch(() => undefined);
          if (observed?.state === 'committed') await this.finishCloudSync(projectPath, state, observed);
          else this.message.warning('上次同步结果待确认，已保留原请求。可再次点同步，先检查原结果。');
          return;
        }

        if (this.cloudScope() === scope && projectCloudIdentity(projectPath) === identity) {
          delete state.pending;
          writeCloudSyncState(projectPath, state);
          retainArchive = false;
        }
        if (saveNew && response.errorCode === 'WORKSPACE_STORAGE_PROJECT_LIMIT_REACHED') {
          const { used, limit } = response.data ?? {};
          const usage = Number.isInteger(used) && Number.isInteger(limit) && limit >= 0 ? `（已使用 ${used}/${limit} 个）` : '';
          throw new Error(`云空间项目已达上限${usage}，无法另存为新云工程。本地修改已保留。`);
        }
        if (response.errorCode !== 'WORKSPACE_PROJECT_SOURCE_CHANGED') {
          throw new Error(response.errorMessage || response.messages || '云端拒绝此同步');
        }
        const conflict = !saveNew && cloudId ? readCloudSyncConflict(response.data, cloudId) : undefined;
        if (!conflict) {
          throw new Error(response.errorMessage || '云端工程已更新，本地修改已保留。请重新下载云端版本进行比较，再同步。');
        }
        assertActive();
        const action = await chooseCloudSyncConflictAction(this.modal, !!overwrite);
        if (action === 'cancel') return;
        assertActive();
        if (action === 'overwrite' && !await confirmCloudSyncOverwrite(this.modal)) return;

        const assertSnapshot = async () => {
          const unsaved = await this.projectService.hasUnsavedChanges();
          assertActive();
          if (unsaved || cloudSourceStamp(projectPath, pending.category) !== pending.before) {
            throw new Error('本地工程在确认期间已修改，请重新同步。');
          }
        };
        await assertSnapshot();
        const projectData = { ...pending.projectData };
        if (action === 'save-new') {
          delete projectData['cloudId'];
          if (!await this.packageProject(projectPath, { detachCloudProject: true })) return;
          archive = await readLocalCloudArchive(archivePath);
        } else if ((await readLocalCloudArchive(archivePath)).sha256 !== archive.sha256) {
          throw new Error('待同步的本地归档已变化，请重新同步。');
        }
        await assertSnapshot();
        pending = {
          ...pending, requestId: crypto.randomUUID(), archiveSha256: archive.sha256, projectData,
          resolution: action === 'overwrite' ? { kind: 'overwrite', remote: conflict } : { kind: 'save-new' },
        };
        state.pending = pending;
        writeCloudSyncState(projectPath, state);
        retainArchive = true;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (retainArchive) this.message.warning(`上次同步结果待处理：${detail}。已保留原请求。`);
      else this.message.error(`同步未完成：${detail}`);
    } finally {
      if (archiveOwned && !retainArchive) {
        try {
          if (projectCloudIdentity(projectPath) === identity) await this.delete7zFile(archivePath);
        } catch (error) {
          console.warn('云同步临时归档清理失败', error);
        }
      }
      this.isSyncing = false;
    }
  }

  showEditor = false;

  openEditor(item) {
    if (!this.canEditProject(item)) {
      this.message.error('该学生已停用，项目仅可查看和打开');
      return;
    }
    this.editorSubscription.unsubscribe();
    this.editorSubscription = this.cloudService.getProject(item.id).subscribe({
      next: res => {
        if (res.status !== 200) {
          this.message.error(res.messages || '获取项目信息失败');
          return;
        }
        if (!this.canEditProject(res.data)) {
          this.message.error('该学生已停用，项目仅可查看和打开');
          return;
        }
        this.editorProjectData = { ...res.data, image_url: item.image_url };
        this.showEditor = true;
      },
      error: error => this.message.error('获取项目信息失败: ' + error),
    });
  }

  // 项目保存成功后的回调
  onProjectSaved() {
    // 重新获取项目列表，以获取最新的项目信息（包括更新后的封面图）
    this.getCloudProjects();
  }

  showSearch = false;
  openSearch() {
    this.showSearch = true;
  }

  closeSearch() {
    this.showSearch = false;
    this.searchKeyword = '';
    this.filterProjects();
  }

  private getPublishErrorMessage(source: unknown): string {
    return resolveTranslatedApiErrorMessage(source, this.translate, {
      fallbackMessage: this.translate.instant('CLOUD_SPACE_ERRORS.PUBLISH_FAILED'),
      translationPrefix: 'CLOUD_SPACE_ERRORS',
    });
  }

  toggleVisibility(item) {
    if (!this.canEditProject(item) || (!item.is_published && !this.canPublishProject(item))) return;
    // 切换公开/私有状态
    // console.log('切换项目可见性:', item);
    if (item.is_published) {
      this.cloudService.unpublishProject(item.id).subscribe({
        next: res => {
          if (res.status !== 200) {
            this.message.error(this.getPublishErrorMessage(res));
            return;
          }
          this.message.info(`项目 "${item.nickname}" 已设为私有`);
          item.is_published = false;
        },
        error: error => this.message.error(this.getPublishErrorMessage(error)),
      });
    } else {
      this.cloudService.publishProject(item.id).subscribe({
        next: res => {
          if (res.status !== 200) {
            this.message.error(this.getPublishErrorMessage(res));
            return;
          }
          this.message.info(`项目 "${item.nickname}" 已设为公开`);
          item.is_published = true;
        },
        error: error => {
          this.message.error(this.getPublishErrorMessage(error));
        }
      });
    }
  }

  toggleTemplate(item) {
    if (item?.student || !this.canEditProject(item)) return;
    if (item.is_template) {
      this.cloudService.unsetTemplate(item.id).subscribe(res => {
        this.message.info(`项目 "${item.nickname}" 已取消模板`);
        item.is_template = false;
      });
    } else {
      this.cloudService.setTemplate(item.id).subscribe(res => {
        if (res.status !== 200) {
          this.message.error(`${res.messages}`);
          return;
        }
        this.message.info(`项目 "${item.nickname}" 已设为模板`);
        item.is_template = true;
      });
    }
  }

  deleteCloudProject(item) {
    if (!item?.id || !this.canEditProject(item)) return;
    this.modal.confirm({
      nzTitle: '删除云端项目',
      nzContent: `确定删除“${item.nickname || item.name}”吗？${item.student ? '此操作将删除学生的原项目。' : ''}删除后无法恢复。`,
      nzOkText: '删除',
      nzOkDanger: true,
      nzOnOk: async () => {
        try {
          const res = await firstValueFrom(this.cloudService.deleteProject(item.id));
          if (res.status !== 200) throw new Error(res.messages || '删除失败');
          this.message.success(`项目 "${item.nickname}" 已删除`);
          this.getCloudProjects();
        } catch (error) {
          this.message.error('删除项目失败: ' + error);
        }
      },
    });
  }

  close() {
    ++this.openIntent;
    this.uiService.closeTool('cloud-space');
  }
}
