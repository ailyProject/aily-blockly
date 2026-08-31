import { Component, OnDestroy, OnInit } from '@angular/core';
import { GUIDE_MENU } from '../../configs/menu.config';
import { UiService, OnboardingService } from '@core/app-shell/public-api';
import { getGuideRecentProjects, ProjectService } from '@domain/project/public-api';
import { ConfigService, ThemeService } from '@core/preferences/public-api';
import packageJson from '../../../../package.json';
import { TranslateModule } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { ElectronService } from '@core/platform/public-api';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { GUIDE_ONBOARDING_CONFIG } from '../../configs/onboarding.config';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

@Component({
  selector: 'app-guide',
  imports: [TranslateModule, CommonModule],
  templateUrl: './guide.component.html',
  styleUrl: './guide.component.scss'
})
export class GuideComponent implements OnInit, OnDestroy {
  version = packageJson.version;
  guideMenu = GUIDE_MENU;
  showMenu = true;
  private readonly guidePageDefaultUrl: SafeResourceUrl;
  private readonly guidePageCnUrl: SafeResourceUrl;

  get logoSrc(): string {
    return this.themeService.theme() === 'light' ? 'imgs/logo-light.webp' : 'imgs/logo.webp';
  }

  get sensecraftImg(): string {
    return this.themeService.theme() === 'light' ? 'brands/sensecraft-light.webp' : 'brands/sensecraft.webp';
  }

  get guidePageIframeSrc(): SafeResourceUrl {
    return this.isCnRegion ? this.guidePageCnUrl : this.guidePageDefaultUrl;
  }

  getSponsorImg(sponsor: any): string {
    if (this.themeService.theme() === 'light' && sponsor.imgLight) {
      return 'sponsor/' + sponsor.imgLight;
    }
    return 'sponsor/' + sponsor.img;
  }
  showMore = false;
  sponsors: any[] = [];
  sponsorPages: any[][] = [];
  sponsorRenderPages: any[][] = [];
  sponsorPageIndex = 0;
  sponsorPageTransitionEnabled = true;
  showImgUrl: string | null = null;
  imgLoading = false;
  private imgRetryCount = 0;
  private readonly maxRetry = 1;
  private readonly sponsorPageSize = 3;
  private readonly sponsorPauseMs = 3000;
  private readonly sponsorTransitionMs = 500;
  private sponsorCarouselTimer: ReturnType<typeof setTimeout> | null = null;
  private sponsorResetTimer: ReturnType<typeof setTimeout> | null = null;

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
    return getGuideRecentProjects(this.projectService.recentlyProjects);
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private http: HttpClient,
    private configService: ConfigService,
    private onboardingService: OnboardingService,
    private themeService: ThemeService,
    private sanitizer: DomSanitizer
  ) {
    this.guidePageDefaultUrl = this.sanitizer.bypassSecurityTrustResourceUrl('https://guide-page.aily.pro');
    this.guidePageCnUrl = this.sanitizer.bypassSecurityTrustResourceUrl('https://guide-page.yiyu.pro');
  }

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

  get isCnRegion(): boolean {
    return this.configService.isCnRegion;
  }

  ngOnInit() {
    this.loadSponsors();
    this.checkFirstLaunch();
  }

  ngOnDestroy() {
    this.stopSponsorCarousel();
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

  private loadSponsors() {
    this.http.get<any[]>('sponsor/sponsor.json').subscribe({
      next: (data) => {
        // 对获取到的数据进行随机排序
        this.sponsors = this.shuffleArray([...data]);
        this.buildSponsorPages();
        this.startSponsorCarousel();
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

  private buildSponsorPages() {
    const pages: any[][] = [];

    for (let i = 0; i < this.sponsors.length; i += this.sponsorPageSize) {
      const page = this.sponsors.slice(i, i + this.sponsorPageSize);
      let padIndex = 0;
      while (page.length > 0 && page.length < this.sponsorPageSize) {
        page.push(this.sponsors[padIndex % this.sponsors.length]);
        padIndex++;
      }
      pages.push(page);
    }

    this.sponsorPages = pages;
    this.sponsorRenderPages = pages.length > 1 ? [...pages, pages[0]] : pages;
    this.sponsorPageIndex = 0;
    this.sponsorPageTransitionEnabled = true;
  }

  private startSponsorCarousel() {
    this.stopSponsorCarousel();
    if (this.sponsorPages.length <= 1) {
      return;
    }

    this.sponsorCarouselTimer = setTimeout(() => {
      this.advanceSponsorPage();
    }, this.sponsorPauseMs);
  }

  private stopSponsorCarousel() {
    if (this.sponsorCarouselTimer) {
      clearTimeout(this.sponsorCarouselTimer);
      this.sponsorCarouselTimer = null;
    }
    if (this.sponsorResetTimer) {
      clearTimeout(this.sponsorResetTimer);
      this.sponsorResetTimer = null;
    }
  }

  private advanceSponsorPage() {
    this.sponsorPageTransitionEnabled = true;
    this.sponsorPageIndex++;

    if (this.sponsorPageIndex === this.sponsorPages.length) {
      this.sponsorResetTimer = setTimeout(() => {
        this.sponsorPageTransitionEnabled = false;
        this.sponsorPageIndex = 0;

        this.sponsorResetTimer = setTimeout(() => {
          this.sponsorPageTransitionEnabled = true;
          this.sponsorResetTimer = null;
        }, 50);
      }, this.sponsorTransitionMs);
    }

    this.sponsorCarouselTimer = setTimeout(() => {
      this.advanceSponsorPage();
    }, this.sponsorPauseMs + this.sponsorTransitionMs);
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

  removeProject(event: Event, project: any) {
    event.stopPropagation();
    this.projectService.removeRecentlyProject({ path: project.path });
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
  //       const originalSrc = 'https://dl.yysc.tech/blockly/wechat.jpg';
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
