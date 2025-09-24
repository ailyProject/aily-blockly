import { Component, OnInit, AfterViewInit } from '@angular/core';
import { GUIDE_MENU } from '../../configs/menu.config';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import { version } from '../../../../package.json';
import { TranslateModule } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import Splide from '@splidejs/splide';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-guide',
  imports: [TranslateModule, CommonModule],
  templateUrl: './guide.component.html',
  styleUrl: './guide.component.scss'
})
export class GuideComponent implements OnInit, AfterViewInit {
  version = version;
  guideMenu = GUIDE_MENU;
  showMenu = true;
  showMore = false;
  sponsors: any[] = [];

  get recentlyProjects() {
    return this.projectService.recentlyProjects
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private http: HttpClient
  ) { }

  ngOnInit() {
    this.loadSponsors();
  }

  ngAfterViewInit() {
    // 延迟初始化轮播，确保DOM已渲染
    setTimeout(() => {
      this.initSplide();
    }, 100);
  }

  private loadSponsors() {
    this.http.get<any[]>('sponsor/sponsor.json').subscribe({
      next: (data) => {
        // 对获取到的数据进行随机排序
        this.sponsors = this.shuffleArray([...data]);
        // 数据加载完成后重新初始化轮播
        setTimeout(() => {
          this.initSplide();
        }, 100);
      },
      error: (error) => {
        console.error('Failed to load sponsors:', error);
      }
    });
  }

  private shuffleArray(array: any[]): any[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  private initSplide() {
    const splideElement = document.querySelector('#sponsor-splide');
    if (splideElement && this.sponsors.length > 0) {
      const splide = new Splide('#sponsor-splide', {
        type: 'loop',
        autoplay: true,
        interval: 3000,
        perPage: 3,
        perMove: 1,
        gap: '10px',
        arrows: false,
        pagination: false,
        breakpoints: {
          400: {
            perPage: 2,
          },
          300: {
            perPage: 1,
          }
        }
      });
      splide.mount();
    }
  }

  onMenuClick(e: any) {
    this.process(e);
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: '',
    });
    console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async openProject(data) {
    const path = await this.selectFolder();
    if (path) {
      await this.projectService.projectOpen(path);
    }
  }

  async openProjectByPath(data) {
    await this.projectService.projectOpen(data.path);
  }

  process(item) {
    switch (item.action) {
      case 'project-new':
        this.router.navigate(['/main/project-new']);
        // this.uiService.openWindow(item.data);
        break;
      case 'project-open':
        this.openProject(item.data);
        break;
      case 'browser-open':
        this.electronService.openUrl(item.data.url);
        break;
      case 'playground-open':
        this.router.navigate(['/main/playground']);
        break;
      default:
        break;
    }
  }

  openUrl(url: string) {
    this.electronService.openUrl(url);
  }

  gotoPlayground() {
    this.router.navigate(['/main/playground']);
  }

  // 重新加载微信二维码图片
  retryLoadImage() {
    setTimeout(() => {
      const img = document.querySelector('.qrcode') as HTMLImageElement;
      if (img) {
        const originalSrc = 'https://dl.diandeng.tech/blockly/wechat.jpg';
        img.src = `${originalSrc}?t=${Date.now()}`;
      }
    }, 1000);

  }
}
