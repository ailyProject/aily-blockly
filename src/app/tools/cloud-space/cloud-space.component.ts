import { Component } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { EditorComponent } from './editor/editor.component';
import { CloudService } from './services/cloud.service';
import { ProjectService } from '../../services/project.service';
import { CmdService } from '../../services/cmd.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AuthService } from '../../services/auth.service';
import { LoginDialogComponent } from '../../main-window/components/login-dialog/login-dialog.component';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ElectronService } from '../../services/electron.service';
import { distinctUntilChanged } from 'rxjs/operators';

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

  constructor(
    private uiService: UiService,
    private cloudService: CloudService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private message: NzMessageService,
    private authService: AuthService,
    private modal: NzModalService,
    private electronService: ElectronService
  ) { }

  // 分页参数
  currentPage = 1;
  pageSize = 100;
  totalProjects = 0;

  ngOnInit(): void {
    this.projectService.currentProjectPath$.subscribe(path => {
      console.log('当前项目路径变化:', path);
      this.canSync = !!path;
    });

    this.authService.checkAndSyncAuthStatus().then((res) => {
      if (!res) {
        this.openLoginDialog();
      }
    });

    // 检查用户是否登录
    this.authService.isLoggedIn$
      .pipe(distinctUntilChanged()) // 只有当登录状态真正改变时才触发
      .subscribe(isLoggedIn => {
        if (!isLoggedIn) {
          this.itemList = [];
          this.filteredItemList = [];
        } else {
          // 用户已登录时关闭可能存在的登录对话框状态标记
          this.isLoginDialogOpen = false;
          this.getCloudProjects().then(
            () => { console.log('云项目列表获取完成'); }
          );
          // 初始化时显示所有项目
          this.filteredItemList = [...this.itemList];
        }
      });
  }

  openLoginDialog() {
    this.isLoginDialogOpen = true;
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '350px',
      nzContent: LoginDialogComponent
    });

    // 当对话框关闭时重置状态
    modalRef.afterClose.subscribe(() => {
      this.isLoginDialogOpen = false;
    });
  }

  // 打开项目
  openInNewTab(item) {
    if (!item || !item.id) return;
    console.log('打开云上项目:', item);
    this.cloudService.getProjectArchive(item.archive_url).subscribe(async res => {
      // 直接添加随机数避免重名
      const randomNum = Math.floor(100000 + Math.random() * 900000);
      const uniqueName = `${item.nickname || item.name || 'cloud_project'}_${randomNum}`;
      const targetPath = this.projectService.projectRootPath + '\\' + uniqueName;
      
      // 使用 Move-Item 将下载/临时文件移动到目标项目目录
      // -Force 用于覆盖同名目标（如果存在）
      await this.cmdService.runAsync(`Move-Item -Path "${res}" -Destination "${targetPath}" -Force`);

      // 更新 package.json 中的项目信息
      const packageJson = JSON.parse(this.electronService.readFile(`${targetPath}/package.json`));
      packageJson.nickname = item.nickname
      packageJson.description = item.description || ''
      packageJson.doc_url = item.doc_url || ''
      this.electronService.writeFile(`${targetPath}/package.json`, JSON.stringify(packageJson, null, 2));

      this.projectService.projectOpen(targetPath);
    });
  }

  // 获取云上项目列表
  async getCloudProjects() {
    this.cloudService.getProjects(this.currentPage, this.pageSize).subscribe(res => {
      if (res && res.status === 200) {
        this.itemList = [];
        res.data.list.forEach(prj => {
          // 图片url
          let imageUrl = '';
          if (prj.image_url) {
            const timestamp = new Date().getTime();
            const separator = prj.image_url.includes('?') ? '&' : '?';
            imageUrl = this.cloudService.baseUrl + prj.image_url + separator + 't=' + timestamp;
          } else {
            imageUrl = 'imgs/subject.webp';
          }

          if (prj.archive_url) {
            prj.archive_url = this.cloudService.baseUrl + prj.archive_url;
          }

          prj.image_url = imageUrl;

          this.itemList.push(prj);
        });
        this.totalProjects = res.data.total;
        console.log('获取云上项目列表成功:', this.itemList);
        // 应用搜索过滤
        this.filterProjects();
      } else {
        console.error('获取云上项目列表失败, 服务器返回错误:', res);
      }
    });
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
        return nickname.includes(keyword) || description.includes(keyword) || name.includes(keyword);
      });
    }
    console.log('过滤后的项目列表:', this.filteredItemList);
  }

  // 搜索关键词变化时触发
  onSearchChange() {
    this.filterProjects();
  }

  // 删除7z文件
  async delete7zFile(archivePath: string) {
    if (await window['fs'].existsSync(archivePath)) {
      await window['fs'].unlinkSync(archivePath);
      console.log('删除已存在的7z文件:', archivePath);
    }
  }

  // 打包项目
  async packageProject(prjPath: string): Promise<string | undefined> {
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
    
    console.log('开始打包项目:', prjPath);
    
    // 构建更安全的打包命令
    // 使用绝对路径避免路径问题，并明确指定文件
    let packCommand = `7za.exe a -t7z -mx=9 "${archivePath}" package.json`;
    
    // 检查是否有.abi文件
    const files = window['fs'].readDirSync(prjPath, { withFileTypes: true });
    const abiFiles = files.filter(file => file.name.endsWith('.abi'));
    
    if (abiFiles.length > 0) {
      console.log('找到abi文件:', abiFiles.map(f => f.name));
      // 逐个添加abi文件
      for (const abiFile of abiFiles) {
        packCommand += ` "${abiFile.name}"`;
      }
    } else {
      console.log('未找到abi文件，只打包package.json');
    }

    // 检查是否有partitions.csv文件
    const partitionFile = files.find(file => file.name.toLowerCase() === 'partitions.csv');
    if (partitionFile) {
      console.log('找到partitions.csv文件:', partitionFile.name);
      packCommand += ` "${partitionFile.name}"`;
    } else {
      console.log('未找到partitions.csv文件');
    }
    
    console.log('执行打包命令:', packCommand);
    
    // 打包文件
    const result = await this.cmdService.runAsync(packCommand, prjPath, false);
    
    console.log('打包命令执行结果:', result);
    
    // 检查打包是否成功
    if (result.type === 'error' || (result.code && result.code !== 0)) {
      this.message.error('项目打包失败: ' + (result.error || result.data));
      console.error('7za打包失败:', result);
      return;
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
      console.log(`文件大小为0，等待重试... (${retryCount + 1}/5)`);
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
    
    console.log('7z文件生成成功:', {
      path: archivePath,
      size: fileStats.size
    });

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

  async setCurrentProjectCloudId(cloudId: string) {
    const currentProjectData = this.projectService.currentPackageData;
    if (!currentProjectData) return;

    currentProjectData.cloudId = cloudId;

    // 同步更新package.json
    await this.projectService.setPackageJson(currentProjectData);
  }

  async syncToCloud() {
    this.isSyncing = true;
    
    // 保存当前项目
    await this.projectService.save(this.projectService.currentProjectPath);

    // 获取当前项目数据
    const currentProjectData = this.projectService.currentPackageData;
    if (!currentProjectData) {
      this.isSyncing = false;
      return;
    }

    const archivePath = await this.packageProject(this.projectService.currentProjectPath);
    if (!archivePath) {
      this.isSyncing = false;
      return;
    }

    // 等待一小段时间确保文件完全写入
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log("archivePath:", archivePath);

    this.cloudService.syncProject({
      pid: currentProjectData?.cloudId,
      projectData: currentProjectData,
      archive: archivePath
    }).subscribe(async res => {
      if (res && res.status === 200) {
        await this.setCurrentProjectCloudId(res.data.id);
        this.message.success('同步成功');
        // 更新项目列表
        await this.getCloudProjects();
        console.log('同步成功, 云端项目ID:', res.data.id);
      } else {
        console.error('同步失败, 服务器返回错误:', res);
        this.message.error('同步失败: ' + (res?.messages || '未知错误'));
      }
      this.isSyncing = false;
      this.delete7zFile(archivePath);
    }, err => {
      this.isSyncing = false;
      console.error('同步失败:', err);
      this.message.error('同步失败: ' + err);
      this.delete7zFile(archivePath);
    });
  }  showEditor = false;

  openEditor(item) {
    this.showEditor = true;
    this.editorProjectData = item;
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

  toggleVisibility(item) {
    // 切换公开/私有状态
    console.log('切换项目可见性:', item);
    if (item.is_published) {
      this.cloudService.unpublishProject(item.id).subscribe(res => {
        this.message.info(`项目 "${item.nickname}" 已设为私有`);
        item.is_published = false;
      });
    } else {
      this.cloudService.publishProject(item.id).subscribe(res => {
        this.message.info(`项目 "${item.nickname}" 已设为公开`);
        item.is_published = true;
      });
    }
  }

  deleteCloudProject(item) {
    if (!item || !item.id) return;
    this.cloudService.deleteProject(item.id).subscribe(res => {
      this.message.success(`项目 "${item.nickname}" 已删除`);
      this.getCloudProjects();
    });
  }

  close() {
    this.uiService.closeTool('cloud-space');
  }
}
