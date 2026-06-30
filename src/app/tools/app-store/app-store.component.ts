import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  isDevMode
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
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

  private visibleCatalogIds: string[] = [];
  private sortables: Sortable[] = [];
  private layoutSubscription?: Subscription;
  private isDraggingToolbarApp = false;

  @ViewChild('headerZone') headerZone?: ElementRef<HTMLElement>;

  constructor(
    private uiService: UiService,
    private router: Router,
    private appStoreService: AppStoreService,
    private projectService: ProjectService,
    private cdr: ChangeDetectorRef,
    private toolI18n: ToolI18nService
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
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.initSortables(), 0);
  }

  ngOnDestroy(): void {
    this.layoutSubscription?.unsubscribe();
    this.sortables.forEach(sortable => sortable.destroy());
    this.sortables = [];
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

  private createVisibilityContext() {
    return {
      boardCore: this.projectService.currentBoardConfig?.core,
      isDevMode: isDevMode()
    };
  }
}
