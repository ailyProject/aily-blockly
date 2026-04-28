import { Component, Input, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { CommonModule } from '@angular/common';
import { ProjectService } from '../../services/project.service';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { UiService } from '../../services/ui.service';
import { ChatService } from '../../tools/aily-chat/public-api';
import { ConnectionGraphService } from '../../services/connection-graph.service';
import { BackgroundAgentService } from '../../services/background-agent.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../services/auth.service';
import { ImageViewerComponent } from '../image-viewer/image-viewer.component';
import { MermaidComponent } from '../../tools/aily-chat/components/aily-mermaid-viewer/mermaid/mermaid.component';
import mermaid from 'mermaid';
import { ThemeService } from '../../services/theme.service';
@Component({
  selector: 'app-float-sider',
  imports: [
    NzToolTipModule,
    CommonModule,
    TranslateModule,
    ImageViewerComponent
  ],
  templateUrl: './float-sider.component.html',
  styleUrl: './float-sider.component.scss'
})
export class FloatSiderComponent implements OnInit, OnDestroy {
  @Input() show = false;
  @ViewChild('imageViewer') imageViewer!: ImageViewerComponent;

  loaded = false;
  private routerSubscription: Subscription | undefined;

  constructor(
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private message: NzMessageService,
    private modal: NzModalService,
    private uiService: UiService,
    private chatService: ChatService,
    private connectionGraphService: ConnectionGraphService,
    private backgroundAgent: BackgroundAgentService,
    private translate: TranslateService,
    private authService: AuthService,
    private themeService: ThemeService
  ) { }

  private requireLogin(): boolean {
    if (!this.authService.isLoggedIn) {
      this.message.warning(this.translate.instant('FLOAT_SIDER.LOGIN_REQUIRED'));
      this.uiService.openTool('aily-chat');
      return false;
    }
    return true;
  }

  private requireFeaturePreviewAccess(): boolean {
    // if (!this.authService.hasFeaturePreviewAccess()) {
    //   this.message.warning('Coming Soon');
    //   return false;
    // }
    return true;
  }

  ngOnInit() {
    // 监听路由变化
    if (this.router.url.indexOf('/main/blockly-editor') !== -1) {
      this.loaded = true;
      this.loadBoardInfo();
    }
    this.routerSubscription = this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe((event: NavigationEnd) => {
        if (event.url.indexOf('/main/blockly-editor') !== -1) {
          this.loaded = true;
          this.loadBoardInfo();
        } else {
          this.loaded = false;
        }
      });
  }

  ngOnDestroy() {
    // 清理订阅
    if (this.routerSubscription) {
      this.routerSubscription.unsubscribe();
    }
  }

  boardPackagePath;
  async loadBoardInfo() {
    setTimeout(async () => {
      this.boardPackagePath = await this.projectService.getBoardPackagePath();
      console.log('Board Package Path:', this.boardPackagePath);
    }, 1000); // 延时1秒，确保项目服务已准备好
  }

  showPinmap() {
    if (!this.requireLogin()) return;
    let boardPackageData = JSON.parse(this.electronService.readFile(this.boardPackagePath + '/package.json'));

    // 如果 pinmap 被禁用，直接显示 webp 图片
    if (boardPackageData.pinmap === false) {
      const pinmapWebpPath = this.boardPackagePath + '/pinmap.webp';
      if (this.electronService.exists(pinmapWebpPath)) {
        this.imageViewer.open(pinmapWebpPath);
        return;
      }
      this.message.error(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
      return;
    }

    const pinmapJsonPath = this.boardPackagePath + '/pinmap.json';
    if (this.electronService.exists(pinmapJsonPath)) {
      // 使用子窗口打开，通过 URL 查询参数传递文件路径
      // this.uiService.openWindow({
      //   path: `pinjson?filePath=${encodeURIComponent(pinjsonPath)}`,
      //   width: 800,
      //   height: 600
      // });
      this.uiService.openWindow({
        title: this.translate.instant('FLOAT_SIDER.PINMAP'),
        path: `iframe?url=${encodeURIComponent('https://tool.aily.pro/component-viewer?type=json&theme=dark&lang=' + this.translate.currentLang)}`,
        // path: `iframe?url=${encodeURIComponent('http://localhost:4201/component-viewer?type=json&theme=dark&lang=' + this.translate.currentLang)}`,
        data: this.electronService.readFile(pinmapJsonPath),
        width: 800,
        height: 600
      });
      return;
    }
    const pinmapWebpPath = this.boardPackagePath + '/pinmap.webp';
    if (this.electronService.exists(pinmapWebpPath)) {
      this.imageViewer.open(pinmapWebpPath);
      return;
    }
    this.message.error(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
  }


  async openDocUrl() {
    let data = await this.projectService.getPackageJson();
    if (data.doc_url) {
      this.electronService.openUrl(data.doc_url);
      return;
    }

    data = JSON.parse(this.electronService.readFile(this.boardPackagePath + '/package.json'))
    if (data.url) {
      this.electronService.openUrl(data.url)
      return;
    }
    this.message.error(this.translate.instant('FLOAT_SIDER.NO_DOCUMENTATION'));
  }

  openSettings() {
    this.uiService.openProjectSettings();
  }

  /** 从 arch.md 提取 mermaid 代码（支持 ```mermaid 块或纯 mermaid 内容） */
  private extractMermaidCode(content: string): string {
    const trimmed = content.trim();
    const blockMatch = trimmed.match(/```mermaid\s*([\s\S]*?)```/);
    if (blockMatch) return blockMatch[1].trim();
    return trimmed;
  }

  /** 点击显示框架图：读取项目目录下 arch.md 并用 mermaid 全屏预览 */
  async showArch(): Promise<void> {
    if (!this.requireLogin()) return;
    if (!this.electronService.isElectron) {
      this.message.warning(this.translate.instant('FLOAT_SIDER.ARCH_ELECTRON_ONLY'));
      return;
    }
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      this.message.error(this.translate.instant('FLOAT_SIDER.NO_PROJECT'));
      return;
    }
    const archPath = (window as any).path?.join
      ? (window as any).path.join(projectPath, 'arch.md')
      : `${projectPath}/arch.md`;
    if (!this.electronService.exists(archPath)) {
      this.uiService.openTool('aily-chat');
      const prompt = this.translate.instant('FLOAT_SIDER.GENERATE_ARCH_PROMPT');
      setTimeout(() => {
        if (this.chatService.isWaiting) {
          this.message.warning(this.translate.instant('FLOAT_SIDER.ARCH_AI_BUSY'));
          return;
        }
        const hasSession = !!this.chatService.currentSessionId;
        this.chatService.sendTextToChat(prompt, {
          sender: 'FloatSider',
          type: 'arch',
          autoSend: true,
          newChatFirst: hasSession
        });
      }, 400);
      return;
    }
    try {
      const raw = this.electronService.readFile(archPath);
      const code = this.extractMermaidCode(raw);
      if (!code?.trim()) {
        this.message.warning(this.translate.instant('FLOAT_SIDER.ARCH_EMPTY'));
        return;
      }
      mermaid.initialize({ theme: this.themeService.getMermaidTheme() as any, startOnLoad: false });
      const diagramId = `mermaid-arch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const result = await mermaid.render(diagramId, code);
      const svg = typeof result === 'object' && result?.svg ? result.svg : typeof result === 'string' ? result : '';
      document.getElementById(diagramId)?.remove();
      if (!svg?.trim()) {
        this.message.warning(this.translate.instant('FLOAT_SIDER.ARCH_RENDER_FAILED'));
        return;
      }
      const forcedStyle = 'width: 60vw !important; height: 80vh !important; max-width: 100% !important; display: block !important;';
      const enhancedSvg = svg
        .replace('<svg', `<svg id="${diagramId}" data-mermaid-svg="true"`)
        .replace(/width="[^"]*"/, 'width="60vw"')
        .replace(/height="[^"]*"/, 'height="80vh"')
        .replace(/<svg([^>]*)>/, (_m: string, attrs: string) => {
          const merged = /style=/.test(attrs)
            ? attrs.replace(/style="[^"]*"/, `style="${forcedStyle}"`)
            : `${attrs} style="${forcedStyle}"`;
          return `<svg${merged}>`;
        });
      this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzContent: MermaidComponent,
        nzData: { svg: enhancedSvg },
        nzWidth: 'fit-content',
      });
    } catch (err) {
      console.warn('Arch diagram render failed:', err);
      this.message.error(this.translate.instant('FLOAT_SIDER.ARCH_RENDER_FAILED'));
    }
  }

  openFeedback() {
    this.uiService.openFeedback();
  }

  openHistory() {
    this.uiService.openHistory();
  }

  async showCircuit() {
    // this.message.warning('Coming Soon');
    // return;
    if (!this.requireLogin()) return;
    if (!this.requireFeaturePreviewAccess()) return;

    if (!this.electronService.isElectron || !this.boardPackagePath) {
      this.message.warning(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
      return;
    }

    let windowUrl = 'https://tool.aily.pro/connection-graph?type=json&theme=' + this.themeService.theme() + '&lang=' + this.translate.currentLang;
    // let windowUrl = 'http://localhost:4201/connection-graph?type=json&theme=' + this.themeService.theme() + '&lang=' + this.translate.currentLang;

    this.uiService.openWindow({
      title: this.translate.instant('FLOAT_SIDER.CIRCUIT'),
      path: `iframe?url=${encodeURIComponent(windowUrl)}`,
      data: null,
      width: 900,
      height: 700,
    });
  }
}
