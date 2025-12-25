import { Component, OnInit, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfigService } from '../../../services/config.service';
import { ActivatedRoute } from '@angular/router';
import { PlaygroundService } from '../playground.service';
import { NzPaginationModule } from 'ng-zorro-antd/pagination';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { CloudService } from '../../../tools/cloud-space/services/cloud.service';
import { ProjectService } from '../../../services/project.service';
import { CmdService } from '../../../services/cmd.service';
import { ElectronService } from '../../../services/electron.service';
import { PlatformService } from "../../../services/platform.service";
import { CrossPlatformCmdService } from "../../../services/cross-platform-cmd.service";
import { updateBlocksInFile } from '../../../utils/blockly_updater';
import { Buffer } from 'buffer';
import { jsonrepair } from 'jsonrepair';

@Component({
  selector: 'app-example-list',
  imports: [
    RouterModule,
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    TranslateModule,
    NzPaginationModule,
    NzToolTipModule
  ],
  templateUrl: './example-list.component.html',
  styleUrl: './example-list.component.scss'
})
export class ExampleListComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('contentBox', { static: false }) contentBox!: ElementRef;
  
  exampleList: any[] = [];
  resourceUrl: string = '';
  keyword: string = '';
  id: string = '';
  params: any = {};
  version: string = '';
  sessionId: string = '';
  isOpened: boolean = false;

  pageIndex: number = 1; // 当前页码
  pageSize: number = 10; // 每页显示数量，默认值
  total: number = 500; // 总条目数
  loadingExampleIndex: number | null = null; // 当前正在加载的示例索引
  private pageSizeCalculated: boolean = false; // 标记 pageSize 是否已计算
  
  private destroy$ = new Subject<void>();
  private examplesSub: Subscription | null = null;

  constructor(
    private configService: ConfigService,
    private translate: TranslateService,
    private route: ActivatedRoute,
    private playgroundService: PlaygroundService,
    private cloudService: CloudService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private electronService: ElectronService,
    private platformService: PlatformService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private messageService: NzMessageService
  ) {
  }

  parseParams(paramsStr: string): any {
    try {
      if (!paramsStr || paramsStr.trim() === '') {
        return {};
      }
      // 兼容处理：将 URL 中的空格替换回 + (防止被错误解码)
      const base64Str = paramsStr.replace(/ /g, '+');
      let jsonStr = Buffer.from(base64Str, 'base64').toString('utf8');
      
      // 尝试修复 JSON 字符串中的控制字符和格式问题
      try {
        jsonStr = jsonrepair(jsonStr);
      } catch (err) {
        console.warn('jsonrepair failed, trying raw parse', err);
        // 兜底：移除可能导致解析错误的不可见控制字符
        jsonStr = jsonStr.replace(/[\x00-\x1F]+/g, "");
      }

      if (jsonStr.startsWith("'") && jsonStr.endsWith("'")) {
        jsonStr = jsonStr.substring(1, jsonStr.length - 1);
      }
      const paramsObj = JSON.parse(jsonStr);
      return paramsObj;
    } catch (e) {
      console.error('解析params失败:', e);
      return {};
    }
  }

  ngOnInit() {
    // 订阅 URL 参数变化并在每次变化时获取示例列表。
    // queryParams 会立即发出当前值，因此不需要额外的初始 getExamples() 调用，
    // 这样可以避免组件创建时重复请求。
    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        // console.log('URL参数:', params);
        this.id = params['id'] || '';
        this.sessionId = params['sessionId'] || '';

        this.keyword = params['keyword'] || '';
        this.params = this.parseParams(params['params'] || '');

        this.version = params['version'] || '';
        // 当通过 URL 搜索时，重置回第一页
        this.pageIndex = 1;
        // 只有在 pageSize 已计算后才获取数据

        if (this.pageSizeCalculated) {
          this.getExamples();
        }
      });
    // this.resourceUrl = this.configService.data.resource[0] + "/imgs/examples/";

    // // 如果数据已经加载，直接使用
    // if (this.playgroundService.isLoaded) {
    //   this.exampleList = this.playgroundService.processedExamplesList;
    //   console.log(this.exampleList);

    //   // 如果URL中有关键词，执行搜索
    //   if (this.keyword) {
    //     this.search(this.keyword);
    //   }
    // } else {
    //   // 如果数据未加载，等待加载完成
    //   this.playgroundService.loadExamplesList().then(() => {
    //     this.exampleList = this.playgroundService.processedExamplesList;
    //     console.log(this.exampleList);

    //     // 如果URL中有关键词，执行搜索
    //     if (this.keyword) {
    //       this.search(this.keyword);
    //     }
    //   });
    // }
  }

  getExamples() {
    if (this.examplesSub) {
      this.examplesSub.unsubscribe();
    }
    this.examplesSub = this.cloudService.getPublicProjects(this.pageIndex, this.pageSize, this.keyword, this.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe(res => {
      if (res && res.status === 200) {
        this.exampleList = []
        this.total = res.data.total;
        
        res.data.list.forEach(prj => {
          // 图片url - 添加时间戳参数避免缓存
          if (prj.image_url) {
            const timestamp = new Date().getTime();
            const separator = prj.image_url.includes('?') ? '&' : '?';
            prj.image_url = this.cloudService.baseUrl + prj.image_url + separator + 't=' + timestamp;
          } else {
            prj.image_url = 'imgs/subject.webp';
          }

          // archive_url
          if (prj.archive_url) {
            prj.archive_url = this.cloudService.baseUrl + prj.archive_url;
          } else {
            prj.archive_url = '';
          }

          this.exampleList.push(prj);
        });

        console.log('获取公开项目列表:', this.exampleList);
        if (this.exampleList.length === 0 && this.pageIndex === 1) {
          this.messageService.warning("No examples found.");
          return;
        }

        if (this.id && !this.isOpened) {
          this.isOpened = true;
          this.loadExample(0);
        }
      }
    });
  }

  ngAfterViewInit() {
    // 初始计算可显示的数量
    setTimeout(() => {
      this.calculatePageSize();
    }, 100);

    // 监听 content-box 元素的大小变化
    if (this.contentBox) {
      const resizeObserver = new ResizeObserver(() => {
        this.calculatePageSize();
      });
      
      resizeObserver.observe(this.contentBox.nativeElement);
      
      // 在组件销毁时断开观察
      this.destroy$.subscribe(() => {
        resizeObserver.disconnect();
      });
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * 计算容器中可以显示多少个示例项
   * 每个示例项：280px x 280px，间距10px
   */
  calculatePageSize() {
    if (!this.contentBox) return;

    const container = this.contentBox.nativeElement;
    const containerWidth = container.clientWidth - 30; // 减去padding (15px * 2)
    const containerHeight = container.clientHeight - 30; // 减去padding (15px * 2)

    const itemWidth = 280;
    const itemHeight = 280;
    const gap = 15; // 根据scss中的gap值

    // 计算每行可以显示多少个
    const itemsPerRow = Math.floor((containerWidth + gap) / (itemWidth + gap));
    
    // 计算可以显示多少行
    const rows = Math.floor((containerHeight + gap) / (itemHeight + gap));

    // 总共可以显示的数量
    const calculatedPageSize = Math.max(1, itemsPerRow * rows);
    
    // console.log('Container size:', containerWidth, 'x', containerHeight);
    // console.log('Items per row:', itemsPerRow, 'Rows:', rows, 'Calculated page size:', calculatedPageSize);
    
    // 如果计算出的 pageSize 与当前值不同,更新并重新获取数据
    if (this.pageSize !== calculatedPageSize) {
      const oldPageSize = this.pageSize;
      this.pageSize = calculatedPageSize;
      // console.log(`Page size changed from ${oldPageSize} to ${this.pageSize}, refreshing data...`);
      
      // 重置到第一页并重新获取数据
      this.pageIndex = 1;
      this.getExamples();
    } else if (!this.pageSizeCalculated) {
      // 第一次计算完成后，即使值没变也要获取数据
      this.getExamples();
    }
    
    // 标记 pageSize 已计算
    this.pageSizeCalculated = true;
  }

  search(keyword = this.keyword) {
    this.exampleList = this.playgroundService.searchExamples(keyword);
  }

  onImgError(event) {
    (event.target as HTMLImageElement).src = 'imgs/subject.webp';
  }

  clearSearch() {
    console.log('清除搜索');
    this.keyword = '';
    this.getExamples();
  }

  loadExample(index: number) {
    // 设置当前加载的示例索引
    this.loadingExampleIndex = index;

    const item = this.exampleList[index];
    this.cloudService.getProjectArchive(item.archive_url)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: async res => {
          try {
            // 直接添加随机数避免重名
            const randomNum = Math.floor(100000 + Math.random() * 900000);
            const uniqueName = `${item.name || 'cloud_project'}_${randomNum}`;
            const targetPath = this.projectService.projectRootPath + this.platformService.getPlatformSeparator() + uniqueName;

            // 确保目标目录的父目录存在
            const targetParent = window['path'].dirname(targetPath);
            if (!window['fs'].existsSync(targetParent)) {
              window['fs'].mkdirSync(targetParent, { recursive: true });
            }
            
            // 如果目标目录已存在，先删除它（确保干净复制）
            if (window['fs'].existsSync(targetPath)) {
              window['fs'].rmdirSync(targetPath, { recursive: true });
            }
            
            console.log('复制解压文件:', res, '->', targetPath);
            // 使用 Move-Item 将下载/临时文件移动到目标项目目录
            // -Force 用于覆盖同名目标（如果存在）
            await this.crossPlatformCmdService.copyItem(res, targetPath, true, true);
            
            // 验证复制是否成功
            if (!window['fs'].existsSync(targetPath)) {
              throw new Error(`复制失败：目标目录不存在 ${targetPath}`);
            }
            
            // 等待一小段时间，确保文件系统操作完成
            await new Promise(resolve => setTimeout(resolve, 100));

            // 检查解压后的目录结构，可能有一个子目录包含实际项目文件
            let actualProjectPath = targetPath;
            
            // 检查目标目录是否存在且可读
            if (!window['fs'].existsSync(targetPath)) {
              throw new Error(`目标目录不存在: ${targetPath}`);
            }
            
            const files = window['fs'].readDirSync(targetPath);
            
            // 如果目标目录只有一个子目录，且该子目录包含 package.json，则使用子目录
            if (files.length === 1) {
              const firstItem = files[0];
              const itemName = typeof firstItem === 'object' && firstItem !== null ? firstItem.name : firstItem;
              const subPath = `${targetPath}${this.platformService.getPlatformSeparator()}${itemName}`;
              
              // 检查子目录是否是目录且包含 package.json
              if (window['fs'].isDirectory(subPath)) {
                const subFiles = window['fs'].readDirSync(subPath);
                const hasPackageJson = subFiles.some((file: any) => {
                  const fileName = typeof file === 'object' && file !== null ? file.name : file;
                  return fileName === 'package.json';
                });
                
                if (hasPackageJson) {
                  actualProjectPath = subPath;
                  console.log('检测到嵌套目录结构，使用子目录:', actualProjectPath);
                }
              }
            }

            // 验证 package.json 是否存在
            const packageJsonPath = `${actualProjectPath}${this.platformService.getPlatformSeparator()}package.json`;
            if (!window['fs'].existsSync(packageJsonPath)) {
              // 列出目录内容以便调试
              const dirContents = window['fs'].readDirSync(actualProjectPath).map((file: any) => {
                return typeof file === 'object' && file !== null ? file.name : file;
              });
              throw new Error(`package.json 不存在于 ${actualProjectPath}。目录内容: ${dirContents.join(', ')}`);
            }

            // 更新 package.json 中的项目信息
            const packageJson = JSON.parse(this.electronService.readFile(packageJsonPath));
            packageJson.nickname = item.nickname
            packageJson.description = item.description || ''
            packageJson.doc_url = item.doc_url || ''
            packageJson.keywords = item?.tags ? JSON.parse(item.tags) : ""
            packageJson.cloudId = item.id;

            this.electronService.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

            if (this.params && Object.keys(this.params).length > 0) {
              const abiFilePath = `${actualProjectPath}${this.platformService.getPlatformSeparator()}project.abi`;
              if (window['fs'].existsSync(abiFilePath)) {
                updateBlocksInFile(abiFilePath, this.params);
              }
            }

            this.projectService.projectOpen(actualProjectPath);
            this.loadingExampleIndex = null;
          } catch (error) {
            console.error('加载示例处理失败:', error);
            // 将错误写入日志文件
            if ((window as any)['electronAPI']?.log) {
              (window as any)['electronAPI'].log.error('加载示例处理失败', error);
            }
            this.messageService.error('加载示例失败: ' + (error?.message || '未知错误'));
            this.loadingExampleIndex = null;
          }
        },
        error: (error) => {
          console.error('加载示例失败:', error);
          // 将错误写入日志文件
          if ((window as any)['electronAPI']?.log) {
            (window as any)['electronAPI'].log.error('加载示例失败', error);
          }
          this.messageService.error('加载示例失败: ' + (error?.message || '网络错误或文件下载失败'));
          this.loadingExampleIndex = null;
        }
      });
  }

  isLoading(index: number): boolean {
    return this.loadingExampleIndex === index;
  }

  isDisabled(index: number): boolean {
    return this.loadingExampleIndex !== null && this.loadingExampleIndex !== index;
  }

  openDoc(index: number) {
    const item = this.exampleList[index];
    if (item.doc_url && item.doc_url.trim() !== '') {
      this.electronService.openUrl(item.doc_url);
    }
  }

  onPageChange(page: number) {
    console.log('页码变化:', page);
    this.pageIndex = page;
    this.getExamples();
  }
}
