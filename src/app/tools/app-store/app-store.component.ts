import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  isDevMode
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { TranslateService } from '@ngx-translate/core';
import Sortable from 'sortablejs';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import {
  APP_STORE_ZONES,
  AppItem,
  AppPlacementZone,
  AppStoreZone
} from './app-store.config';
import { AppStoreService } from './app-store.service';
import { Subscription } from 'rxjs';
import { ToolI18nService } from '../../services/tool-i18n.service';
import { SubappManagerService } from '../../services/subapp-manager.service';
import { ChildToolProcessService } from '../../services/child-tool-process.service';
import { MainUiAutomationService } from '../../services/main-ui-automation.service';
import { ChildAppHostRegistryService } from '../../services/child-app-host-registry.service';

@Component({
  selector: 'app-app-store',
  imports: [
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule,
    TranslateModule,
    NzToolTipModule
  ],
  templateUrl: './app-store.component.html',
  styleUrl: './app-store.component.scss'
})
export class AppStoreComponent implements OnInit, AfterViewInit, OnDestroy {
  currentUrl = '';
  windowInfo = 'MENU.APP_STORE';
  zones: AppStoreZone[] = APP_STORE_ZONES;

  headerZoneApps: AppItem[] = [];
  catalogApps: AppItem[] = [];
  catalogLoading = true;
  catalogError = '';
  catalogWarning = '';
  installRoot = '';
  pendingCatalogId = '';
  checkingCatalogId = '';
  confirmUninstallCatalogId = '';
  openMoreCatalogId = '';

  private visibleCatalogIds: string[] = [];
  private sortables: Sortable[] = [];
  private layoutSubscription?: Subscription;
  private catalogSubscription?: Subscription;
  private confirmUninstallTimer?: ReturnType<typeof setTimeout>;
  private isDraggingToolbarApp = false;
  private activeSubappVersions = new Map<string, string>();

  @ViewChild('headerZone') headerZone?: ElementRef<HTMLElement>;

  constructor(
    private uiService: UiService,
    private router: Router,
    private appStoreService: AppStoreService,
    private projectService: ProjectService,
    private cdr: ChangeDetectorRef,
    private toolI18n: ToolI18nService,
    private subappManager: SubappManagerService,
    private childToolProcess: ChildToolProcessService,
    private mainUiAutomation: MainUiAutomationService,
    private childHostRegistry: ChildAppHostRegistryService,
    private message: NzMessageService,
    private modal: NzModalService,
    private translate: TranslateService,
  ) { }

  ngOnInit(): void {
    void this.initTool();
  }

  private async initTool(): Promise<void> {
    await this.toolI18n.load('app-store');
    this.currentUrl = this.router.url;
    this.refreshApps();
    this.layoutSubscription = this.appStoreService.layout$.subscribe(() => {
      this.refreshApps();
      this.cdr.markForCheck();
    });
    this.catalogSubscription = this.subappManager.state$.subscribe((state) => {
      this.catalogLoading = state.loading;
      this.catalogError = state.error || '';
      this.catalogWarning = state.warning || '';
      this.installRoot = state.installRoot;
      this.cdr.markForCheck();
    });
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.initSortables(), 0);
  }

  ngOnDestroy(): void {
    this.layoutSubscription?.unsubscribe();
    this.catalogSubscription?.unsubscribe();
    this.sortables.forEach(sortable => sortable.destroy());
    this.sortables = [];
    this.closeSubappMore();
  }

  getZoneApps(zone: AppPlacementZone): AppItem[] {
    return this.headerZoneApps;
  }

  getZoneRef(zone: AppPlacementZone): ElementRef<HTMLElement> | undefined {
    return this.headerZone;
  }

  emptySlots(zone: AppPlacementZone): number[] {
    const count = this.appStoreService.getZoneLimit(zone) - this.getZoneApps(zone).length;
    return count > 0 ? Array.from({ length: count }, (_, index) => index) : [];
  }

  isPinned(app: AppItem, zone: AppPlacementZone): boolean {
    return this.appStoreService.isAppInZone(zone, app.id);
  }

  isZoneFull(zone: AppPlacementZone): boolean {
    return this.appStoreService.getZoneIds(zone).length >= this.appStoreService.getZoneLimit(zone);
  }

  toggleZone(app: AppItem, zone: AppPlacementZone): void {
    if (app.lock) {
      return;
    }

    if (this.isPinned(app, zone)) {
      this.appStoreService.removeAppFromZone(zone, app.id);
      return;
    }

    this.appStoreService.addAppToZone(zone, app.id);
  }

  removeFromZone(app: AppItem, zone: AppPlacementZone): void {
    if (app.lock) {
      return;
    }

    this.appStoreService.removeAppFromZone(zone, app.id);
  }

  openApp(app: AppItem): void {
    if (app.subapp && !app.subapp.installed) {
      this.installSubapp(app);
      return;
    }
    const toolName = app.data?.data;
    if (toolName) {
      this.uiService.openTool(toolName);
    }
  }

  openToolbarApp(app: AppItem): void {
    if (this.isDraggingToolbarApp) {
      return;
    }

    this.openApp(app);
  }

  resetToDefault(): void {
    this.appStoreService.resetToDefault();
  }

  refreshCatalog(): void {
    if (this.catalogLoading || this.pendingCatalogId || this.checkingCatalogId) return;
    void this.subappManager.refresh(true);
  }

  private installSubapp(app: AppItem): void {
    if (this.isSubappPending(app)) return;
    this.clearUninstallConfirmation();
    void this.runSubappAction('install', app);
  }

  runSubappMenuAction(app: AppItem): void {
    const catalogId = app.subapp?.catalogId;
    if (!catalogId || !app.subapp?.installed || this.pendingCatalogId || this.checkingCatalogId) return;

    if (app.subapp.updateAvailable) {
      this.closeSubappMore();
      this.startSubappUpdate(app);
      return;
    }

    if (this.isSubappRestartRequired(app)) {
      this.closeSubappMore();
      this.confirmSubappRestart(app);
      return;
    }

    this.closeSubappMore();
    void this.checkSubappUpdateFromCatalog(catalogId);
  }

  isSubappActive(app: AppItem): boolean {
    return !!app.subapp?.installed && this.uiService.isToolOpen(app.id);
  }

  isSubappRestartRequired(app: AppItem): boolean {
    const installedVersion = String(app.subapp?.installedVersion || '').trim();
    const activeVersion = this.getSubappActiveVersion(app);
    return this.isSubappActive(app)
      && !!installedVersion
      && !!activeVersion
      && activeVersion !== installedVersion;
  }

  toggleSubappMore(app: AppItem, event: Event): void {
    event.stopPropagation();
    const catalogId = app.subapp?.catalogId;
    if (!catalogId || !app.subapp?.installed || this.pendingCatalogId) return;
    if (this.openMoreCatalogId === catalogId) {
      this.closeSubappMore();
      return;
    }
    this.clearUninstallConfirmation();
    this.openMoreCatalogId = catalogId;
    void this.refreshSubappActiveVersion(app);
    this.cdr.markForCheck();
  }

  isSubappMoreOpen(app: AppItem): boolean {
    return !!app.subapp && this.openMoreCatalogId === app.subapp.catalogId;
  }

  uninstallSubapp(app: AppItem): void {
    const catalogId = app.subapp?.catalogId;
    if (!catalogId || this.pendingCatalogId) return;
    if (this.confirmUninstallCatalogId !== catalogId) {
      this.clearUninstallConfirmation();
      this.confirmUninstallCatalogId = catalogId;
      this.confirmUninstallTimer = setTimeout(() => {
        this.confirmUninstallCatalogId = '';
        this.confirmUninstallTimer = undefined;
        this.cdr.markForCheck();
      }, 5000);
      this.cdr.markForCheck();
      return;
    }

    this.clearUninstallConfirmation();
    this.openMoreCatalogId = '';
    void this.runSubappAction('uninstall', app);
  }

  isSubappPending(app: AppItem): boolean {
    return !!app.subapp && this.pendingCatalogId === app.subapp.catalogId;
  }

  isCheckingSubapp(app: AppItem): boolean {
    return !!app.subapp && this.checkingCatalogId === app.subapp.catalogId;
  }

  isUninstallConfirming(app: AppItem): boolean {
    return !!app.subapp && this.confirmUninstallCatalogId === app.subapp.catalogId;
  }

  resetUninstallConfirmation(): void {
    this.clearUninstallConfirmation();
  }

  @HostListener('document:click')
  closeSubappMoreOnOutsideClick(): void {
    if (this.openMoreCatalogId) {
      this.closeSubappMore();
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:keydown.escape')
  closeSubappMoreOnEscape(): void {
    this.closeSubappMoreOnOutsideClick();
  }

  close(): void {
    this.uiService.closeTool('app-store');
  }

  private initSortables(): void {
    this.sortables.forEach(sortable => sortable.destroy());
    this.sortables = [];

    this.initSortableForZone('header');
  }

  private initSortableForZone(zone: AppPlacementZone): void {
    const element = this.getZoneRef(zone)?.nativeElement;
    if (!element) {
      return;
    }

    const sortable = Sortable.create(element, {
      animation: 150,
      draggable: '.placement-card',
      handle: '.placement-main',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      onStart: () => {
        this.isDraggingToolbarApp = true;
      },
      onEnd: () => {
        this.syncZoneFromDom(zone, element);
        setTimeout(() => {
          this.isDraggingToolbarApp = false;
        }, 0);
      }
    });

    this.sortables.push(sortable);
  }

  private syncZoneFromDom(zone: AppPlacementZone, element: HTMLElement): void {
    const ids = Array.from(element.querySelectorAll<HTMLElement>('.placement-card'))
      .map(card => card.dataset['id'])
      .filter((id): id is string => !!id);

    this.appStoreService.setVisibleZoneOrder(zone, ids, this.visibleCatalogIds);
  }

  private refreshApps(): void {
    const context = this.createVisibilityContext();
    const canShow = (app: AppItem) => this.appStoreService.isAppVisible(app, context);

    this.catalogApps = this.appStoreService.getEnabledApps().filter(canShow);
    this.visibleCatalogIds = this.catalogApps.map(app => app.id);
    this.headerZoneApps = this.appStoreService.getAppsForZone('header').filter(canShow);
  }

  private async runSubappAction(action: 'install' | 'uninstall', app: AppItem): Promise<void> {
    const subapp = app.subapp;
    if (!subapp || this.pendingCatalogId) return;
    this.pendingCatalogId = subapp.catalogId;
    try {
      if (action !== 'install') {
        await this.childToolProcess.stop(app.id);
      }
      if (action === 'uninstall') {
        this.uiService.closeTool(app.id);
      }
      await this.subappManager[action](subapp.catalogId);
      this.message.success(this.translate.instant(`APP_STORE.${action.toUpperCase()}_SUCCESS`, { name: app.name }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      this.message.error(this.translate.instant('APP_STORE.ACTION_FAILED', { message }));
    } finally {
      this.pendingCatalogId = '';
      this.cdr.markForCheck();
    }
  }

  private startSubappUpdate(app: AppItem): void {
    if (!app.subapp?.updateAvailable) return;
    void this.updateSubapp(app);
  }

  private confirmSubappRestart(app: AppItem): void {
    this.modal.confirm({
      nzClassName: 'subapp-service-confirm-modal',
      nzTitle: this.translate.instant('APP_STORE.RESTART_CONFIRM', { name: app.name }),
      nzContent: this.translate.instant('APP_STORE.RESTART_HINT', { name: app.name }),
      nzOkText: this.translate.instant('APP_STORE.CONFIRM_RESTART'),
      nzCancelText: this.translate.instant('APP_STORE.CANCEL'),
      nzMaskClosable: false,
      nzOnOk: () => this.restartSubapp(app),
    });
  }

  private async updateSubapp(app: AppItem): Promise<void> {
    const subapp = app.subapp;
    if (!subapp?.updateAvailable || this.pendingCatalogId) return;

    const wasActive = this.isSubappActive(app);
    const previousInstalledVersion = String(subapp.installedVersion || '').trim();
    let restartTarget: AppItem | null = null;
    this.pendingCatalogId = subapp.catalogId;
    this.cdr.markForCheck();
    try {
      await this.subappManager.update(subapp.catalogId);
      const updatedApp = this.subappManager.getCatalogApps()
        .find((item) => item.subapp?.catalogId === subapp.catalogId);
      const updatedInstalledVersion = String(updatedApp?.subapp?.installedVersion || '').trim();
      if (wasActive
        && updatedApp?.subapp?.installed
        && !!updatedInstalledVersion
        && updatedInstalledVersion !== previousInstalledVersion) {
        restartTarget = updatedApp;
      }
      this.message.success(this.translate.instant('APP_STORE.UPDATE_SUCCESS', { name: app.name }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      this.message.error(this.translate.instant('APP_STORE.ACTION_FAILED', { message }));
    } finally {
      this.pendingCatalogId = '';
      this.cdr.markForCheck();
    }

    if (restartTarget) {
      this.confirmSubappRestart(restartTarget);
    }
  }

  private async restartSubapp(app: AppItem): Promise<void> {
    const catalogId = app.subapp?.catalogId;
    if (!catalogId || this.pendingCatalogId) return;

    this.pendingCatalogId = catalogId;
    this.cdr.markForCheck();
    try {
      const result = await this.mainUiAutomation.controlChildApp({
        toolId: app.id,
        action: 'restart',
      });
      if (result['ok'] !== true) {
        throw new Error(String(result['message'] || this.translate.instant('APP_STORE.RESTART_FAILED')));
      }
      await this.refreshSubappActiveVersion(app);
      this.message.success(this.translate.instant('APP_STORE.RESTART_SUCCESS', { name: app.name }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      this.message.error(this.translate.instant('APP_STORE.ACTION_FAILED', { message }));
      throw error;
    } finally {
      this.pendingCatalogId = '';
      this.cdr.markForCheck();
    }
  }

  private async checkSubappUpdateFromCatalog(catalogId: string): Promise<void> {
    this.clearUninstallConfirmation();
    this.checkingCatalogId = catalogId;
    this.cdr.markForCheck();

    try {
      await this.subappManager.refresh(true);
      if (this.subappManager.state.error) {
        throw new Error(this.subappManager.state.error);
      }

      const refreshedApp = this.subappManager.getCatalogApps()
        .find((item) => item.subapp?.catalogId === catalogId);
      if (!refreshedApp?.subapp?.installed) {
        throw new Error(`Installed subapp was not found after refreshing the catalog: ${catalogId}`);
      }

      if (!refreshedApp.subapp.updateAvailable) {
        this.message.info(this.translate.instant('APP_STORE.LATEST_VERSION', { name: refreshedApp.name }));
        return;
      }

      this.startSubappUpdate(refreshedApp);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      this.message.error(this.translate.instant('APP_STORE.CHECK_UPDATE_FAILED', { message }));
    } finally {
      this.checkingCatalogId = '';
      this.cdr.markForCheck();
    }
  }

  private clearUninstallConfirmation(): void {
    if (this.confirmUninstallTimer) {
      clearTimeout(this.confirmUninstallTimer);
      this.confirmUninstallTimer = undefined;
    }
    this.confirmUninstallCatalogId = '';
  }

  private getSubappActiveVersion(app: AppItem): string {
    const localVersion = this.childHostRegistry.getStatus(app.id)?.['version'];
    if (typeof localVersion === 'string' && localVersion.trim()) {
      return localVersion.trim();
    }
    return this.activeSubappVersions.get(app.id) || '';
  }

  private async refreshSubappActiveVersion(app: AppItem): Promise<void> {
    if (!this.isSubappActive(app)) {
      this.activeSubappVersions.delete(app.id);
      return;
    }

    const result = await this.mainUiAutomation.getChildApp({ toolId: app.id });
    const describedApp = result['app'] as Record<string, any> | undefined;
    const version = describedApp?.['ui']?.['host']?.['version'];
    if (typeof version === 'string' && version.trim()) {
      this.activeSubappVersions.set(app.id, version.trim());
      this.cdr.markForCheck();
    }
  }

  private closeSubappMore(): void {
    this.openMoreCatalogId = '';
    this.clearUninstallConfirmation();
  }

  private createVisibilityContext() {
    return {
      boardCore: this.projectService.currentBoardConfig?.core,
      isDevMode: isDevMode()
    };
  }
}
