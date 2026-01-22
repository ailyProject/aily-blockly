import { Component, OnInit, AfterViewInit } from '@angular/core';
import { GUIDE_MENU } from '../../configs/menu.config';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import { ConfigService } from '../../services/config.service';
import { version } from '../../../../package.json';
import { TranslateModule } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import Splide from '@splidejs/splide';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { OnboardingService } from '../../services/onboarding.service';
import { GUIDE_ONBOARDING_CONFIG } from '../../configs/onboarding.config';

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
  showImgUrl: string | null = null;
  imgLoading = false;
  private imgRetryCount = 0;
  private readonly maxRetry = 1;

  showImg(url: string) {
    this.imgLoading = true;
    this.imgRetryCount = 0;
    this.showImgUrl = url;
  }

  hideImg() {
    this.showImgUrl = null;
    this.imgLoading = false;
    this.imgRetryCount = 0;
  }

  onImgLoad() {
    this.imgLoading = false;
  }

  onImgError() {
    if (this.imgRetryCount < this.maxRetry && this.showImgUrl) {
      this.imgRetryCount++;
      const currentUrl = this.showImgUrl;
      // 200ms 后重新加载
      setTimeout(() => {
        if (this.showImgUrl === currentUrl) {
          // 添加时间戳强制重新加载
          this.showImgUrl = currentUrl + (currentUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
        }
      }, 200);
    } else {
      this.imgLoading = false;
    }
  }

  get recentlyProjects() {
    return this.projectService.recentlyProjects
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private http: HttpClient,
    private configService: ConfigService,
    private onboardingService: OnboardingService
  ) { }

  /**
   * 获取微信二维码 URL（根据当前 region 动态生成）
   */
  get wechatQrcodeUrl(): string {
    const resourceUrl = this.configService.getCurrentResourceUrl();
    return `${resourceUrl}/wechat.jpg`;
  }

  get qqQrcodeUrl(): string {
    const resourceUrl = this.configService.getCurrentResourceUrl();
    return `${resourceUrl}/qq.jpg`
  }

  ngOnInit() {
    this.loadSponsors();
    this.checkFirstLaunch();
  }

  // 检查是否是第一次启动
  private checkFirstLaunch() {
    const hasSeenOnboarding = this.configService.data.onboardingCompleted;
    if (!hasSeenOnboarding) {
      // 延迟显示引导，确保页面已渲染
      setTimeout(() => {
        this.onboardingService.start(GUIDE_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed()
        });
      }, 500);
    }
  }

  // 跳过或关闭引导
  private onOnboardingClosed() {
    this.configService.data.onboardingCompleted = true;
    this.configService.save();
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
    console.log(new Date().toLocaleTimeString() + '.' + new Date().getMilliseconds().toString().padStart(3, '0'));
    await this.projectService.projectOpen(data.path);
    console.log(new Date().toLocaleTimeString() + '.' + new Date().getMilliseconds().toString().padStart(3, '0'));
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
      case 'tool-open':
        this.uiService.turnTool(item.data);
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
  // retryLoadImage() {
  //   setTimeout(() => {
  //     const img = document.querySelector('.qrcode') as HTMLImageElement;
  //     if (img) {
  //       const originalSrc = 'https://dl.diandeng.tech/blockly/wechat.jpg';
  //       img.src = `${originalSrc}?t=${Date.now()}`;
  //     }
  //   }, 1000);
  // }

  // test() {
  //   console.log(this.electronService.isWindowFocused());
  //   setTimeout(() => {
  //     // if (!this.electronService.isWindowFocused()) {
  //     // }
  //   }, 12000)
  // }

  openFeedback() {
    this.uiService.openFeedback();
  }
}
