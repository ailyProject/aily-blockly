import { AfterViewInit, Component, ElementRef, Injector, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActionService } from '../../../../services/action.service';
import { AuthService } from '../../../../services/auth.service';
import { BuilderService } from '../../../../services/builder.service';
import { ConfigService } from '../../../../services/config.service';
import { ElectronService } from '../../../../services/electron.service';
import { ProjectService } from '../../../../services/project.service';
import { ThemeService } from '../../../../services/theme.service';
import { UiService } from '../../../../services/ui.service';
import { WorkflowService, ProcessState } from '../../../../services/workflow.service';
import { ImageViewerComponent } from '../../../../components/image-viewer/image-viewer.component';
import { BackgroundAgentService } from '../../../../services/background-agent.service';

@Component({
  selector: 'app-dev-tool',
  imports: [
    FormsModule,
    NzToolTipModule,
    TranslateModule,
    ImageViewerComponent
  ],
  templateUrl: './dev-tool.component.html',
  styleUrl: './dev-tool.component.scss'
})
export class DevToolComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('imageViewer') imageViewer!: ImageViewerComponent;
  @ViewChild('devtoolBox') devtoolBox?: ElementRef<HTMLElement>;

  isDragging = false;
  dragStartX = 0;
  dragStartY = 0;
  currentX = 0;
  currentY = 1;
  offsetX = 0;
  offsetY = 0;
  positionReady = false;
  isViewportAdjusting = false;

  boardPackagePath = '';
  isReloading = false;

  private _autoSave = true;
  private loadBoardInfoTimer: ReturnType<typeof setTimeout> | null = null;
  private chatServicePromise?: Promise<any>;
  private viewportAdjustTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeAnimationFrame: number | null = null;

  get autoSave(): boolean {
    return this._autoSave;
  }

  get reloadDisabled(): boolean {
    return this.isReloading || this.projectService.isProjectOpening;
  }

  set autoSave(value: boolean) {
    this._autoSave = value;
    this.ensureDevModeConfig().autoSave = value;
    this.configService.save();
  }

  constructor(
    private projectService: ProjectService,
    private electronService: ElectronService,
    private messageService: NzMessageService,
    private configService: ConfigService,
    private builderService: BuilderService,
    private actionService: ActionService,
    private workflowService: WorkflowService,
    private modal: NzModalService,
    private uiService: UiService,
    private translate: TranslateService,
    private authService: AuthService,
    private themeService: ThemeService,
    private backgroundAgent: BackgroundAgentService,
    private injector: Injector,
    private ngZone: NgZone
  ) { }

  ngOnInit() {
    void this.backgroundAgent;
    const devmode = this.ensureDevModeConfig();
    this._autoSave = devmode.autoSave ?? true;
    this.loadBoardInfo();
  }

  ngAfterViewInit() {
    setTimeout(() => this.centerAtBottom(), 0);
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('resize', this.onViewportResize);
    });
  }

  ngOnDestroy() {
    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.onDragEnd);
    window.removeEventListener('resize', this.onViewportResize);

    if (this.loadBoardInfoTimer) {
      clearTimeout(this.loadBoardInfoTimer);
      this.loadBoardInfoTimer = null;
    }

    if (this.viewportAdjustTimer) {
      clearTimeout(this.viewportAdjustTimer);
      this.viewportAdjustTimer = null;
    }

    if (this.resizeAnimationFrame !== null) {
      window.cancelAnimationFrame(this.resizeAnimationFrame);
      this.resizeAnimationFrame = null;
    }
  }

  onDragStart(event: MouseEvent) {
    this.isDragging = true;
    this.dragStartX = event.clientX - this.currentX;
    this.dragStartY = event.clientY;
    this.offsetY = window.innerHeight - this.currentY;

    document.addEventListener('mousemove', this.onDrag);
    document.addEventListener('mouseup', this.onDragEnd);

    event.preventDefault();
  }

  onDrag = (event: MouseEvent) => {
    if (!this.isDragging) return;

    this.currentX = event.clientX - this.dragStartX;
    this.currentY = window.innerHeight - event.clientY + (this.dragStartY - this.offsetY);

    this.clampToViewport();
  }

  onDragEnd = () => {
    this.isDragging = false;

    document.removeEventListener('mousemove', this.onDrag);
    document.removeEventListener('mouseup', this.onDragEnd);
  }

  private centerAtBottom() {
    const bounds = this.getViewportBounds();
    this.currentX = Math.round(bounds.maxX / 2);
    this.currentY = bounds.minY;
    this.positionReady = true;
  }

  private onViewportResize = () => {
    if (!this.positionReady) return;
    if (this.resizeAnimationFrame !== null) return;

    this.resizeAnimationFrame = window.requestAnimationFrame(() => {
      this.resizeAnimationFrame = null;
      const clampedPosition = this.getClampedPosition();

      if (clampedPosition.x === this.currentX && clampedPosition.y === this.currentY) {
        return;
      }

      this.ngZone.run(() => {
        this.currentX = clampedPosition.x;
        this.currentY = clampedPosition.y;
        this.markViewportAdjusting();
      });
    });
  }

  private clampToViewport(): boolean {
    const originalX = this.currentX;
    const originalY = this.currentY;
    const clampedPosition = this.getClampedPosition();

    this.currentX = clampedPosition.x;
    this.currentY = clampedPosition.y;

    return this.currentX !== originalX || this.currentY !== originalY;
  }

  private getClampedPosition(): { x: number; y: number } {
    const bounds = this.getViewportBounds();

    return {
      x: this.clamp(this.currentX, 0, bounds.maxX),
      y: this.clamp(this.currentY, bounds.minY, bounds.maxY)
    };
  }

  private getViewportBounds(): { maxX: number; minY: number; maxY: number } {
    const topExclusionZone = 70;
    const minY = 1;
    const componentWidth = this.devtoolBox?.nativeElement.offsetWidth || 360;
    const componentHeight = this.devtoolBox?.nativeElement.offsetHeight || 40;

    return {
      maxX: Math.max(0, window.innerWidth - componentWidth),
      minY,
      maxY: Math.max(minY, window.innerHeight - topExclusionZone - componentHeight)
    };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
  }

  private markViewportAdjusting() {
    this.isViewportAdjusting = true;

    if (this.viewportAdjustTimer) {
      clearTimeout(this.viewportAdjustTimer);
    }

    this.viewportAdjustTimer = setTimeout(() => {
      this.isViewportAdjusting = false;
      this.viewportAdjustTimer = null;
    }, 120);
  }

  async reload() {
    if (this.reloadDisabled) {
      return;
    }

    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return;
    }

    this.isReloading = true;
    try {
      if (this.autoSave) {
        const result = await this.projectService.save(projectPath);
        if (!result.success) {
          this.messageService.error('Save project failed: ' + (result.error || 'unknown error'));
          return;
        }
      }

      await this.projectService.projectOpen(projectPath, { reason: 'reload' });
      this.loadBoardInfo();
    } catch (error) {
      console.error('Reload project failed:', error);
      this.messageService.error('Reload project failed: ' + ((error as Error)?.message || String(error)));
    } finally {
      this.isReloading = false;
    }
  }

  async clear() {
    const currentState = this.workflowService.currentState;
    if (currentState === ProcessState.BUILDING || currentState === ProcessState.UPLOADING) {
      this.messageService.warning('Cannot clear cache while compiling or uploading');
      return;
    }

    try {
      await new Promise<void>((resolve) => {
        this.actionService.dispatch('preprocess-stop', {}, (feedback) => {
          if (feedback.success) {
            console.log('preprocess stopped');
          }
          resolve();
        }, 3000);
      });

      const defaultBuildPath = await this.projectService.getBuildPath();

      if (window['fs'].existsSync(defaultBuildPath)) {
        console.log('Deleting build folder:', defaultBuildPath);
        this.electronService.deleteDir(defaultBuildPath);
      }

      const tempDirPath = this.electronService.pathJoin(this.projectService.currentProjectPath, '.temp');
      if (this.electronService.exists(tempDirPath)) {
        console.log('Deleting .temp directory:', tempDirPath);
        this.electronService.deleteDir(tempDirPath);
      }

      this.messageService.success('Clear build folder success');
    } catch (error) {
      if (error.message && error.message.includes('EBUSY')) {
        console.warn('Clear build folder failed: Folder is busy');
        this.messageService.warning('Clear build folder failed: Folder is busy, wait a moment and try again.');
      } else {
        console.error('Clear build folder error:', error);
        this.messageService.error('Clear build folder failed: ' + error.message);
      }
    }
  }

  openWebDevTools() {
    window['ipcRenderer'].send('open-dev-tools');
  }

  help() {

  }

  close() {

  }

  loadBoardInfo() {
    if (this.loadBoardInfoTimer) {
      clearTimeout(this.loadBoardInfoTimer);
    }

    this.loadBoardInfoTimer = setTimeout(async () => {
      this.loadBoardInfoTimer = null;
      this.boardPackagePath = await this.resolveBoardPackagePath();
      console.log('Board Package Path:', this.boardPackagePath);
    }, 1000);
  }

  async showPinmap() {
    const boardPackagePath = await this.resolveBoardPackagePath();
    if (!boardPackagePath) {
      this.messageService.error(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
      return;
    }

    const boardPackageData = JSON.parse(this.electronService.readFile(boardPackagePath + '/package.json'));

    if (boardPackageData.pinmap === false) {
      const pinmapWebpPath = boardPackagePath + '/pinmap.webp';
      if (this.electronService.exists(pinmapWebpPath)) {
        this.imageViewer.open(pinmapWebpPath);
        return;
      }
      this.messageService.error(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
      return;
    }

    const pinmapJsonPath = boardPackagePath + '/pinmap.json';
    if (this.electronService.exists(pinmapJsonPath)) {
      this.uiService.openWindow({
        title: this.translate.instant('FLOAT_SIDER.PINMAP'),
        path: `iframe?url=${encodeURIComponent('https://tool.aily.pro/component-viewer?type=json&theme=dark&lang=' + this.translate.currentLang)}`,
        data: this.electronService.readFile(pinmapJsonPath),
        width: 800,
        height: 600
      });
      return;
    }

    const pinmapWebpPath = boardPackagePath + '/pinmap.webp';
    if (this.electronService.exists(pinmapWebpPath)) {
      this.imageViewer.open(pinmapWebpPath);
      return;
    }

    this.messageService.error(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
  }

  async openDocUrl() {
    let data = await this.projectService.getPackageJson();
    if (data.doc_url) {
      this.electronService.openUrl(data.doc_url);
      return;
    }

    const boardPackagePath = await this.resolveBoardPackagePath();
    if (boardPackagePath) {
      data = JSON.parse(this.electronService.readFile(boardPackagePath + '/package.json'));
      if (data.url) {
        this.electronService.openUrl(data.url);
        return;
      }
    }

    this.messageService.error(this.translate.instant('FLOAT_SIDER.NO_DOCUMENTATION'));
  }

  openSettings() {
    this.uiService.openProjectSettings();
  }

  async showArch(): Promise<void> {
    if (!this.requireLogin()) return;
    if (!this.electronService.isElectron) {
      this.messageService.warning(this.translate.instant('FLOAT_SIDER.ARCH_ELECTRON_ONLY'));
      return;
    }

    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      this.messageService.error(this.translate.instant('FLOAT_SIDER.NO_PROJECT'));
      return;
    }

    const archPath = (window as any).path?.join
      ? (window as any).path.join(projectPath, 'arch.md')
      : `${projectPath}/arch.md`;

    if (!this.electronService.exists(archPath)) {
      this.uiService.openTool('aily-chat');
      const prompt = this.translate.instant('FLOAT_SIDER.GENERATE_ARCH_PROMPT');
//       const prompt = `${this.translate.instant('FLOAT_SIDER.GENERATE_ARCH_PROMPT')}

// Generate a Mermaid project architecture diagram and save it to arch.md. If the architecture save tool is deferred, use tool_search for blockly-architecture or save_arch, then call save_arch with raw Mermaid DSL in code. Do not only print Mermaid source.`;
      setTimeout(() => {
        void this.sendArchPrompt(prompt);
      }, 400);
      return;
    }

    try {
      const raw = this.electronService.readFile(archPath);
      const code = this.extractMermaidCode(raw);
      if (!code?.trim()) {
        this.messageService.warning(this.translate.instant('FLOAT_SIDER.ARCH_EMPTY'));
        return;
      }

      const [{ default: mermaid }, { MermaidComponent }] = await Promise.all([
        import('mermaid'),
        import('../../../../tools/aily-chat/components/aily-mermaid-viewer/mermaid/mermaid.component')
      ]);

      mermaid.initialize({ theme: this.themeService.getMermaidTheme() as any, startOnLoad: false });
      const diagramId = `mermaid-arch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const result = await mermaid.render(diagramId, code);
      const svg = typeof result === 'object' && result?.svg ? result.svg : typeof result === 'string' ? result : '';
      document.getElementById(diagramId)?.remove();
      if (!svg?.trim()) {
        this.messageService.warning(this.translate.instant('FLOAT_SIDER.ARCH_RENDER_FAILED'));
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
      this.messageService.error(this.translate.instant('FLOAT_SIDER.ARCH_RENDER_FAILED'));
    }
  }

  openFeedback() {
    this.uiService.openFeedback();
  }

  async showCircuit() {
    if (!this.requireLogin()) return;
    if (!this.requireFeaturePreviewAccess()) return;

    const boardPackagePath = await this.resolveBoardPackagePath();
    if (!this.electronService.isElectron || !boardPackagePath) {
      this.messageService.warning(this.translate.instant('FLOAT_SIDER.NO_PINMAP'));
      return;
    }

    const windowUrl = 'https://tool.aily.pro/connection-graph?type=json&theme=' + this.themeService.theme() + '&lang=' + this.translate.currentLang;

    this.uiService.openWindow({
      title: this.translate.instant('FLOAT_SIDER.CIRCUIT'),
      path: `iframe?url=${encodeURIComponent(windowUrl)}`,
      data: null,
      width: 900,
      height: 700,
    });
  }

  private ensureDevModeConfig(): { enabled: boolean; autoSave: boolean } {
    const data = this.configService.data as any;

    if (typeof data.devmode === 'boolean') {
      data.devmode = { enabled: data.devmode, autoSave: true };
    } else if (!data.devmode || typeof data.devmode !== 'object') {
      data.devmode = { enabled: false, autoSave: true };
    } else {
      data.devmode.enabled = !!data.devmode.enabled;
      data.devmode.autoSave = data.devmode.autoSave ?? true;
    }

    return data.devmode;
  }

  private requireLogin(): boolean {
    if (!this.authService.isLoggedIn) {
      this.messageService.warning(this.translate.instant('FLOAT_SIDER.LOGIN_REQUIRED'));
      this.uiService.openTool('aily-chat');
      return false;
    }
    return true;
  }

  private requireFeaturePreviewAccess(): boolean {
    return true;
  }

  private async resolveBoardPackagePath(): Promise<string> {
    if (!this.boardPackagePath) {
      this.boardPackagePath = await this.projectService.getBoardPackagePath();
    }

    return this.boardPackagePath;
  }

  private extractMermaidCode(content: string): string {
    const trimmed = content.trim();
    const blockMatch = trimmed.match(/```mermaid\s*([\s\S]*?)```/);
    if (blockMatch) return blockMatch[1].trim();
    return trimmed;
  }

  private async getChatService() {
    if (!this.chatServicePromise) {
      this.chatServicePromise = import('../../../../tools/aily-chat/public-api')
        .then(({ ChatService }) => this.injector.get(ChatService));
    }

    return this.chatServicePromise;
  }

  private async sendArchPrompt(prompt: string): Promise<void> {
    const chatService = await this.getChatService();
    if (chatService.isWaiting) {
      this.messageService.warning(this.translate.instant('FLOAT_SIDER.ARCH_AI_BUSY'));
      return;
    }

    const hasSession = !!chatService.currentSessionId;
    chatService.sendTextToChat(prompt, {
      sender: 'FloatSider',
      type: 'arch',
      autoSend: true,
      newChatFirst: hasSession
    });
  }
}
