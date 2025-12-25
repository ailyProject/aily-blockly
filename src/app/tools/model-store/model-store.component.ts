import { Component, OnInit, ViewChild, ElementRef, AfterViewInit, HostListener } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { Router } from '@angular/router';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { ModelStoreService, ModelItem } from './model-store.service';
import { NzBreadCrumbModule } from 'ng-zorro-antd/breadcrumb';
import { ModelDetailComponent } from './model-detail/model-detail.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzPaginationModule } from 'ng-zorro-antd/pagination';
import { ElectronService } from '../../services/electron.service';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-model-store',
  imports: [
    SubWindowComponent,
    ToolContainerComponent,
    FormsModule,
    CommonModule,
    NzTagModule,
    NzBreadCrumbModule,
    ModelDetailComponent,
    NzButtonModule,
    NzPaginationModule,
    TranslateModule
  ],
  templateUrl: './model-store.component.html',
  styleUrl: './model-store.component.scss'
})
export class ModelStoreComponent implements OnInit, AfterViewInit {
  @ViewChild('itemListContainer') itemListContainer!: ElementRef;
  currentUrl;

  constructor(
    private uiService: UiService,
    private router: Router,
    private modelStoreService: ModelStoreService,
    private message: NzMessageService,
    private electronService: ElectronService
  ) { }

  itemList: ModelItem[] = []
  filteredItemList: ModelItem[] = [] // 过滤后的项目列表
  showSearch = false;
  searchKeyword = ''; // 搜索关键词

  // 分页相关
  currentPage = 1;  // 当前页码
  totalPages = 1;   // 总页数
  totalCount = 0;   // 总模型数
  pageSize = 12;    // 每页数量
  loading = false;  // 加载状态

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit() {
    setTimeout(() => {
      this.calculatePageSize();
      this.loadModelList();
    }, 100);
  }

  @HostListener('window:resize')
  onResize() {
    this.calculatePageSize();
  }

  calculatePageSize() {
    if (!this.itemListContainer) return;
    const container = this.itemListContainer.nativeElement;
    const containerHeight = container.clientHeight;
    const containerWidth = container.clientWidth;

    // 如果容器高度太小，跳过计算
    if (containerHeight < 100) return;

    const itemHeight = 149;
    const gap = 10;
    const padding = 20;
    const paginationHeight = 40;

    // 始终预留分页高度，确保计算稳定
    const availableHeight = containerHeight - padding - paginationHeight;

    const rows = Math.max(1, Math.floor((availableHeight + gap) / (itemHeight + gap)));

    const columns = containerWidth >= 600 ? 2 : 1;

    // 最小显示2个item
    const newPageSize = Math.max(2, rows * columns);

    if (this.pageSize !== newPageSize) {
      this.pageSize = newPageSize;
      this.loadModelList(1);
    }
  }

  // 加载模型列表
  loadModelList(page: number = 1) {
    this.loading = true;
    this.modelStoreService.getModelList(page, this.pageSize, undefined, this.searchKeyword).subscribe({
      next: (result) => {
        console.log('加载的模型列表结果:', result);
        this.itemList = result.list;
        this.totalCount = result.total;
        this.totalPages = result.totalPages;
        this.currentPage = page;
        this.filterProjects();
        this.loading = false;
      },
      error: (error) => {
        console.error('加载模型列表失败:', error);
        this.loading = false;
      }
    });
  }

  // 跳转到指定页
  goToPage(page: number) {
    if (page < 1 || page > this.totalPages || page === this.currentPage) {
      return;
    }
    this.loadModelList(page);
  }

  // 上一页
  prevPage() {
    if (this.currentPage > 1) {
      this.goToPage(this.currentPage - 1);
    }
  }

  // 下一页
  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.goToPage(this.currentPage + 1);
    }
  }

  // 第一页
  firstPage() {
    this.goToPage(1);
  }

  // 最后一页
  lastPage() {
    this.goToPage(this.totalPages);
  }

  // 获取显示的页码列表
  getPageNumbers(): number[] {
    const pages: number[] = [];
    const maxVisible = 5; // 最多显示5个页码

    if (this.totalPages <= maxVisible) {
      // 总页数少于等于最大显示数，显示所有页码
      for (let i = 1; i <= this.totalPages; i++) {
        pages.push(i);
      }
    } else {
      // 总页数多于最大显示数，智能显示
      if (this.currentPage <= 3) {
        // 当前页靠前，显示前5页
        for (let i = 1; i <= maxVisible; i++) {
          pages.push(i);
        }
      } else if (this.currentPage >= this.totalPages - 2) {
        // 当前页靠后，显示后5页
        for (let i = this.totalPages - maxVisible + 1; i <= this.totalPages; i++) {
          pages.push(i);
        }
      } else {
        // 当前页在中间，显示当前页前后各2页
        for (let i = this.currentPage - 2; i <= this.currentPage + 2; i++) {
          pages.push(i);
        }
      }
    }

    return pages;
  }

  showDetail;
  modelID: string = '';
  currentModelName;
  loadModelDetail(item: ModelItem) {
    this.modelID = item.id;
    this.currentModelName = item.name;
    this.showDetail = true;
  }

  closeModelDetail() {
    this.showDetail = false;
    this.modelID = null;
    this.currentModelName = null;
  }

  openSearch() {
    this.showSearch = true;
  }

  closeSearch() {
    this.showSearch = false;
    this.searchKeyword = '';
    // this.filterProjects();
    this.loadModelList(1);
  }

  // 搜索关键词变化时触发
  onSearchChange() {
    this.loadModelList(1);
  }

  // 过滤项目列表
  filterProjects() {
    if (!this.searchKeyword || this.searchKeyword.trim() === '') {
      this.filteredItemList = [...this.itemList];
    } else {
      const keyword = this.searchKeyword.toLowerCase().trim();
      this.filteredItemList = this.itemList.filter(item => {
        const description = (item.description || '').toLowerCase();
        const name = (item.name || '').toLowerCase();
        const authorName = (item.author_name || '').toLowerCase();
        return name.includes(keyword) || description.includes(keyword) || authorName.includes(keyword);
      });
    }
    // console.log('过滤后的项目列表:', this.filteredItemList);
  }

  close() {
    this.uiService.closeTool('model-store');
  }


  onTrain(): void {
    // this.message.warning('当前版本暂不可用，敬请期待');
    this.electronService.openUrl('https://sensecraft.seeed.cc/ai/training');
    return;
    this.uiService.openWindow({
      path: 'model-train',
      title: '模型训练',
      alwaysOnTop: true,
      width: 960,
      height: 640
    });
  }
}
