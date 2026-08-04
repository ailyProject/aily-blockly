import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  QueryList,
  ViewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { IMenuItem } from '../../configs/menu.config';
import { Router } from '@angular/router';
import { PlatformService } from '../../services/platform.service';

const MENU_ANCHOR_ALIGNMENT_EPSILON = 4;
const CHAT_MODEL_SUBMENU_OPEN_BODY_CLASS = 'aily-chat-model-submenu-open';
const SUBMENU_HOVER_SCROLL_SPEED_PX_PER_SECOND = 28;
const SUBMENU_HOVER_SCROLL_MIN_DURATION_SECONDS = 1.2;

@Component({
  selector: 'app-menu',
  imports: [CommonModule, FormsModule, TranslateModule, NzToolTipModule],
  templateUrl: './menu.component.html',
  styleUrl: './menu.component.scss',
})
export class MenuComponent implements AfterViewChecked {
  @ViewChild('menuBox') menuBox: ElementRef;
  @ViewChild('submenuBox') submenuBox: ElementRef;
  @ViewChild('globalFilterInput') globalFilterInput?: ElementRef<HTMLInputElement>;
  @ViewChildren('menuItem') menuItems: QueryList<ElementRef>;

  private _menuList: readonly any[] = [];
  private _position: { x: number; y: number; anchorBottom?: number } = {
    x: 2,
    y: 40,
  };
  private menuListSignature = '';

  @Input()
  set menuList(value: readonly any[]) {
    const nextMenuList = Array.isArray(value) ? value : [];
    const nextSignature = this.buildMenuListSignature(nextMenuList);
    const menuStructureChanged = nextSignature !== this.menuListSignature;

    this._menuList = nextMenuList;
    this.menuListSignature = nextSignature;
    this.initializeSectionState();

    if (menuStructureChanged) {
      this.pendingAnchorAlignment = true;
      this.pendingViewportAdjustment = true;
    }
  }

  get menuList(): readonly any[] {
    return this._menuList;
  }

  @Input()
  set position(value: { x: number; y: number; anchorBottom?: number }) {
    this._position = value && typeof value.x === 'number' && typeof value.y === 'number'
      ? value
      : { x: 2, y: 40, anchorBottom: undefined };
  }

  get position(): { x: number; y: number; anchorBottom?: number } {
    return this._position;
  }

  @Input() width;

  @Input() maxHeight: number | null = null;

  @Input() globalFilterPlaceholder = '';

  @Input() focusGlobalFilterOnOpen = false;

  @Input() tooltipOverlayClassName = 'aily-menu-item-tooltip';

  @Input() tooltipPlacement = 'rightTop';

  @Output() itemClickEvent = new EventEmitter();

  @Output() subItemClickEvent = new EventEmitter();

  @Output() actionClickEvent = new EventEmitter();

  @Output() closeEvent = new EventEmitter();

  @Input() keywords: readonly string[] = [];

  sectionCollapsedState: Record<string, boolean> = {};
  sectionFilterState: Record<string, string> = {};
  sectionExpandedAnchorY: Record<string, number> = {};
  globalFilterValue = '';
  private pendingGlobalFilterFocus = false;
  private pendingViewportAdjustment = false;
  private pendingAnchorAlignment = false;
  private pendingSubmenuGeometry = false;
  private pendingMenuGeometryCorrection = false;
  private menuGeometryCorrectionTimeout: ReturnType<typeof setTimeout> | null = null;

  // 添加子菜单显示状态管理
  activeSubmenuItem: IMenuItem | null = null;
  submenuTimeout: ReturnType<typeof setTimeout> | null = null;
  submenuPosition = { left: '0px', top: '0px' };
  submenuWidth = 'auto';
  submenuMaxWidth = 'none';
  submenuMaxHeight = 'none';
  submenuOverflow = 'visible';
  private submenuInteractionVersion = 0;
  private submenuGeometryTimeout: ReturnType<typeof setTimeout> | null = null;
  private activeSubmenuAnchor: {
    menuLeft: number;
    menuRight: number;
    itemTop: number;
    itemHeight: number;
  } | null = null;

  constructor(
    private hostRef: ElementRef<HTMLElement>,
    private router: Router,
    private platformService: PlatformService
  ) { }

  /** 按平台格式化快捷键显示：macOS 显示 ⌘，Windows 显示 Ctrl */
  formatShortcutForDisplay(text: string): string {
    if (!text) return '';
    if (this.platformService.isMac()) {
      return text.replace(/Ctrl\/⌘|Ctrl/gi, '⌘');
    }
    return text.replace(/Ctrl\/⌘|⌘/g, 'Ctrl');
  }

  getTooltipTitle(tooltip: string | null | undefined): string | null {
    if (typeof tooltip !== 'string') {
      return null;
    }

    const normalizedTooltip = tooltip.trim();
    return normalizedTooltip.length > 0 ? normalizedTooltip : null;
  }

  hasHoverFlyout(item: IMenuItem | null | undefined): boolean {
    return !!item?.extra?.hoverFlyout;
  }

  private getHoverFlyoutData(item: IMenuItem | null | undefined): Record<string, unknown> | null {
    const hoverFlyout = item?.extra?.hoverFlyout;
    return hoverFlyout && typeof hoverFlyout === 'object'
      ? hoverFlyout as Record<string, unknown>
      : null;
  }

  getSubmenuTooltipTitle(item: IMenuItem | null | undefined): string | null {
    return this.hasHoverFlyout(item)
      ? this.getTooltipTitle(item?.tooltip)
      : null;
  }

  getSubmenuTitle(item: IMenuItem | null | undefined): string {
    if (!this.hasHoverFlyout(item)) {
      return '';
    }

    const hoverFlyout = this.getHoverFlyoutData(item);
    const explicitTitle = typeof hoverFlyout?.['title'] === 'string'
      ? hoverFlyout['title'].trim()
      : '';
    if (explicitTitle) {
      return explicitTitle;
    }

    return typeof item?.name === 'string' ? item.name : '';
  }

  shouldShowSubmenuDetail(item: IMenuItem | null | undefined): boolean {
    return this.hasHoverFlyout(item)
      && (!!this.getSubmenuTitle(item) || this.hasSubmenuIntroContent(item));
  }

  shouldUseRichSubmenuOption(subItem: IMenuItem | null | undefined): boolean {
    return !!this.getSubmenuItemDetail(subItem);
  }

  getSubmenuSimpleItemTitle(subItem: IMenuItem | null | undefined): string {
    const text = typeof subItem?.text === 'string' ? subItem.text.trim() : '';
    if (text) {
      return text;
    }

    const path = typeof subItem?.data?.path === 'string' ? subItem.data.path.trim() : '';
    return path;
  }

  getSubmenuRichItemTitle(subItem: IMenuItem | null | undefined): string {
    const name = typeof subItem?.name === 'string' ? subItem.name.trim() : '';
    const detail = this.getSubmenuItemDetail(subItem)?.trim() ?? '';
    return [name, detail].filter(Boolean).join(' - ');
  }

  getSubmenuSectionLabel(item: IMenuItem | null | undefined): string | null {
    const hoverFlyout = this.getHoverFlyoutData(item);
    const label = typeof hoverFlyout?.['sectionLabel'] === 'string'
      ? hoverFlyout['sectionLabel'].trim()
      : '';
    return label.length > 0 ? label : null;
  }

  getSubmenuChildren(item: IMenuItem | null | undefined): IMenuItem[] {
    return Array.isArray(item?.children) ? item.children : [];
  }

  hasSubmenuContent(item: IMenuItem | null | undefined): boolean {
    return this.getSubmenuChildren(item).length > 0 || !!this.getSubmenuTooltipTitle(item);
  }

  shouldRenderSubmenu(): boolean {
    return this.hasSubmenuContent(this.activeSubmenuItem);
  }

  getSubmenuDescriptionLines(item: IMenuItem | null | undefined): string[] {
    const hoverFlyout = this.getHoverFlyoutData(item);
    const explicitDescription = typeof hoverFlyout?.['description'] === 'string'
      ? hoverFlyout['description'].trim()
      : '';
    if (explicitDescription) {
      return this.splitDisplayLines(explicitDescription);
    }

    return this.getSubmenuTooltipLines(item)
      .filter((line) => !this.isCapabilityLine(line));
  }

  hasSubmenuIntroContent(item: IMenuItem | null | undefined): boolean {
    return this.getSubmenuDescriptionLines(item).length > 0 || !!this.getSubmenuContextValue(item);
  }

  getSubmenuContextLabel(item: IMenuItem | null | undefined): string | null {
    const hoverFlyout = this.getHoverFlyoutData(item);
    const explicitLabel = typeof hoverFlyout?.['contextLabel'] === 'string'
      ? hoverFlyout['contextLabel'].trim()
      : '';
    if (explicitLabel) {
      return explicitLabel;
    }

    return this.getSubmenuContextValue(item) ? '上下文长度' : null;
  }

  getSubmenuContextValue(item: IMenuItem | null | undefined): string | null {
    const hoverFlyout = this.getHoverFlyoutData(item);
    const explicitValue = typeof hoverFlyout?.['contextValue'] === 'string'
      ? hoverFlyout['contextValue'].trim()
      : '';
    if (explicitValue) {
      return explicitValue;
    }

    const capabilityTags = this.getSubmenuCapabilityTags(item);
    return capabilityTags.length > 0 ? capabilityTags[0] : null;
  }

  getSubmenuItemDetail(item: IMenuItem | null | undefined): string | null {
    const explicitDetail = typeof item?.extra?.detail === 'string'
      ? item.extra.detail.trim()
      : '';
    if (explicitDetail) {
      return explicitDetail;
    }

    return this.getTooltipTitle(item?.tooltip);
  }

  getSubmenuCapabilityLabel(item: IMenuItem | null | undefined): string | null {
    const capabilityLine = this.getSubmenuTooltipLines(item)
      .find((line) => this.isCapabilityLine(line));
    if (!capabilityLine) {
      return null;
    }

    const separatorIndex = capabilityLine.search(/[:：]/);
    if (separatorIndex === -1) {
      return '能力';
    }

    const label = capabilityLine.slice(0, separatorIndex).trim();
    return label.length > 0 ? label : '能力';
  }

  getSubmenuCapabilityTags(item: IMenuItem | null | undefined): string[] {
    const capabilityLine = this.getSubmenuTooltipLines(item)
      .find((line) => this.isCapabilityLine(line));
    if (!capabilityLine) {
      return [];
    }

    const separatorIndex = capabilityLine.search(/[:：]/);
    const value = separatorIndex === -1
      ? capabilityLine.trim()
      : capabilityLine.slice(separatorIndex + 1).trim();
    if (!value) {
      return [];
    }

    return value
      .split(/\s*[·•]\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  ngAfterViewInit(): void {
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleDocumentClick);
    this.pendingGlobalFilterFocus = this.focusGlobalFilterOnOpen && !!this.globalFilterPlaceholder;

    // Defer the first geometry correction until after the initial change-detection
    // pass so the menu can align against its rendered height without triggering NG0100.
    this.pendingAnchorAlignment = true;
    this.pendingViewportAdjustment = true;
    this.scheduleMenuGeometryCorrection();
  }

  ngAfterViewChecked(): void {
    if (this.pendingGlobalFilterFocus && this.globalFilterInput?.nativeElement) {
      this.globalFilterInput.nativeElement.focus();
      this.globalFilterInput.nativeElement.select();
      this.pendingGlobalFilterFocus = false;
    }

    if (this.pendingSubmenuGeometry) {
      this.refineSubmenuPosition();
    }

    if (this.pendingAnchorAlignment || this.pendingViewportAdjustment) {
      this.scheduleMenuGeometryCorrection();
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentClick);
    if (this.menuGeometryCorrectionTimeout) {
      clearTimeout(this.menuGeometryCorrectionTimeout);
      this.menuGeometryCorrectionTimeout = null;
    }
    this.cancelSubmenuClose();
    if (this.submenuGeometryTimeout) {
      clearTimeout(this.submenuGeometryTimeout);
      this.submenuGeometryTimeout = null;
    }
    this.setModelSubmenuBodyState(false);
  }

  itemClick(item) {
    if (item.disabled) return;
    if (this.isSectionToggle(item)) {
      this.toggleSection(item);
      return;
    }
    if (this.isSectionFilter(item)) {
      return;
    }
    // 有二级菜单时不触发主菜单项（最近项目入口在无子项时也不触发）
    if (item.children?.length && item.action !== 'select-model') return;
    if (item.action === 'recent-projects-root') return;
    this.itemClickEvent.emit(item);
  }

  actionClick(event: MouseEvent, action: { icon: string; action: string }, item: any) {
    event.stopPropagation();
    this.actionClickEvent.emit({ event, action: action.action, item });
  }

  handleDocumentClick = (event: MouseEvent) => {
    event.preventDefault();
    const target = event.target as Node;

    // 检查点击是否在主菜单或子菜单内
    const isClickInMainMenu = this.menuBox && this.menuBox.nativeElement.contains(target);
    const isClickInSubmenu = this.submenuBox && this.submenuBox.nativeElement && this.submenuBox.nativeElement.contains(target);

    if (!isClickInMainMenu && !isClickInSubmenu) {
      this.closeMenu();
    }
  };

  closeMenu() {
    this.activeSubmenuItem = null;
    this.setModelSubmenuBodyState(false);
    this.setSubmenuReady(false);
    this.pendingSubmenuGeometry = false;
    this.activeSubmenuAnchor = null;
    this.closeEvent.emit('');
  }

  get visibleMenuItems(): IMenuItem[] {
    const visibleItems: IMenuItem[] = [];
    const globalFilter = this.getGlobalFilterValue();

    for (const item of this.menuList) {
      if (item.sep) {
        visibleItems.push(item);
        continue;
      }

      if (this.isSectionFilter(item) && this.hasGlobalFilter()) {
        continue;
      }

      if (globalFilter && !this.shouldKeepItemForGlobalFilter(item, globalFilter)) {
        continue;
      }

      if (this.isSectionScoped(item) && !this.isSectionItemVisible(item)) {
        continue;
      }

      if (this.isSectionFilter(item) && !this.isSectionExpanded(this.getSectionId(item))) {
        continue;
      }

      if (
        (item.children && item.children.length > 0) ||
        item.action === 'recent-projects-root' ||
        (!item.children && this.showInRouter(item))
      ) {
        visibleItems.push(item);
      }
    }

    return this.trimSectionSeparators(visibleItems);
  }

  isHighlight(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return this.keywords.some((keyword) =>
      keyword && lowerText.includes(keyword.toLowerCase())
    );
  }

  showInRouter(menuItem: IMenuItem) {
    if (!menuItem.router) {
      return true;
    } else {
      for (const router of menuItem.router) {
        if (this.router.url.indexOf(router) > -1) {
          return true;
        }
      }
    }
  }

  isSectionToggle(item: IMenuItem | null | undefined): boolean {
    return typeof item?.action === 'string' && item.action.startsWith('section-toggle-');
  }

  isSectionFilter(item: IMenuItem | null | undefined): boolean {
    return typeof item?.action === 'string' && item.action.startsWith('section-filter-');
  }

  getSectionId(item: IMenuItem | null | undefined): string {
    const explicitSectionId = typeof item?.extra?.sectionId === 'string' ? item.extra.sectionId.trim() : '';
    if (explicitSectionId) {
      return explicitSectionId;
    }

    const action = typeof item?.action === 'string' ? item.action : '';
    if (action.startsWith('section-toggle-')) {
      return action.slice('section-toggle-'.length);
    }
    if (action.startsWith('section-filter-')) {
      return action.slice('section-filter-'.length);
    }

    return typeof item?.extra?.section === 'string' ? item.extra.section : '';
  }

  isSectionExpanded(sectionId: string): boolean {
    return !this.sectionCollapsedState[sectionId];
  }

  hasGlobalFilter(): boolean {
    return this.globalFilterPlaceholder.trim().length > 0;
  }

  updateGlobalFilter(value: string): void {
    this.globalFilterValue = typeof value === 'string' ? value : '';
    this.pendingViewportAdjustment = true;
  }

  getGlobalFilterValue(): string {
    return this.globalFilterValue.trim().toLowerCase();
  }

  toggleSection(item: IMenuItem): void {
    const sectionId = this.getSectionId(item);
    if (!sectionId) {
      return;
    }

    const isExpanding = !this.isSectionExpanded(sectionId);
    if (isExpanding) {
      this.reserveExpandedSectionViewport(sectionId);
    } else {
      this.restoreCollapsedSectionViewport(sectionId);
    }

    this.sectionCollapsedState[sectionId] = !this.sectionCollapsedState[sectionId];
    this.activeSubmenuItem = null;

    if (isExpanding) {
      this.pendingViewportAdjustment = true;
      return;
    }

    // Wait until the collapsed DOM height is rendered before re-checking the
    // viewport, otherwise the stale expanded height pulls the menu upward.
    setTimeout(() => {
      this.adjustMenuPositionWithinViewport();
    });
  }

  updateSectionFilter(sectionId: string, value: string): void {
    this.sectionFilterState[sectionId] = typeof value === 'string' ? value : '';
  }

  getSectionFilterValue(sectionId: string): string {
    return this.sectionFilterState[sectionId] ?? '';
  }

  getSectionToggleIcon(item: IMenuItem): string {
    return this.isSectionExpanded(this.getSectionId(item)) ? 'fa-light fa-chevron-down' : 'fa-light fa-chevron-right';
  }

  private initializeSectionState(): void {
    for (const item of this.menuList) {
      if (this.isSectionToggle(item)) {
        const sectionId = this.getSectionId(item);
        if (!sectionId || this.sectionCollapsedState[sectionId] !== undefined) {
          continue;
        }
        this.sectionCollapsedState[sectionId] = item.extra?.collapsed !== false;
      }
      if (this.isSectionFilter(item)) {
        const sectionId = this.getSectionId(item);
        if (sectionId && this.sectionFilterState[sectionId] === undefined) {
          this.sectionFilterState[sectionId] = '';
        }
      }
    }
  }

  private isSectionScoped(item: IMenuItem): boolean {
    return typeof item?.extra?.section === 'string' && item.extra.section.trim().length > 0;
  }

  private isSectionItemVisible(item: IMenuItem): boolean {
    const sectionId = this.getSectionId(item);
    if (!sectionId) {
      return true;
    }

    const globalFilter = this.getGlobalFilterValue();
    if (globalFilter) {
      return this.matchesGlobalFilter(item, globalFilter);
    }

    if (!this.isSectionExpanded(sectionId)) {
      return false;
    }

    const filterValue = this.getSectionFilterValue(sectionId).trim().toLowerCase();
    if (!filterValue) {
      return true;
    }

    const haystack = [item.name, item.text, item.tooltip]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();
    return haystack.includes(filterValue);
  }

  private shouldKeepItemForGlobalFilter(item: IMenuItem, filterValue: string): boolean {
    if (!filterValue) {
      return true;
    }

    if (this.isSectionFilter(item)) {
      return false;
    }

    if (this.isSectionToggle(item)) {
      const sectionId = this.getSectionId(item);
      return sectionId ? this.sectionHasGlobalFilterMatch(sectionId, filterValue) : true;
    }

    if (typeof item?.action === 'string' && item.action.startsWith('section-')) {
      const sectionId = this.getSectionId(item);
      return sectionId ? this.sectionHasGlobalFilterMatch(sectionId, filterValue) : true;
    }

    return this.matchesGlobalFilter(item, filterValue);
  }

  private sectionHasGlobalFilterMatch(sectionId: string, filterValue: string): boolean {
    if (!sectionId) {
      return false;
    }

    return this.menuList.some((candidate) => {
      if (!candidate || candidate.sep || this.isSectionToggle(candidate) || this.isSectionFilter(candidate)) {
        return false;
      }

      return this.getSectionId(candidate) === sectionId && this.matchesGlobalFilter(candidate, filterValue);
    });
  }

  private matchesGlobalFilter(item: IMenuItem, filterValue: string): boolean {
    if (!filterValue) {
      return true;
    }

    const haystack = [item.name, item.text, item.tooltip]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();
    return haystack.includes(filterValue);
  }

  private reserveExpandedSectionViewport(sectionId: string): void {
    if (!this.position || this.getGlobalFilterValue()) {
      return;
    }

    const viewportPadding = 8;
    const revealedHeight = this.estimateSectionRevealHeight(sectionId);
    if (revealedHeight <= 0) {
      return;
    }

    const currentTop = this.menuBox?.nativeElement
      ? (this.menuBox.nativeElement as HTMLElement).getBoundingClientRect().top
      : this.position.y;
    this.sectionExpandedAnchorY[sectionId] = currentTop;

    this.position = {
      ...this.position,
      y: Math.max(viewportPadding, currentTop - revealedHeight),
    };
  }

  private restoreCollapsedSectionViewport(sectionId: string): void {
    if (!this.position || this.getGlobalFilterValue()) {
      delete this.sectionExpandedAnchorY[sectionId];
      return;
    }

    const anchorY = this.sectionExpandedAnchorY[sectionId];
    delete this.sectionExpandedAnchorY[sectionId];
    if (typeof anchorY !== 'number' || Number.isNaN(anchorY)) {
      return;
    }

    this.position = {
      ...this.position,
      y: anchorY,
    };
  }

  private estimateSectionRevealHeight(sectionId: string): number {
    let height = 0;

    for (const item of this.menuList) {
      if (this.isSectionFilter(item) && this.getSectionId(item) === sectionId) {
        height += 34;
        continue;
      }

      if (this.isSectionScoped(item) && this.getSectionId(item) === sectionId) {
        const filterValue = this.getSectionFilterValue(sectionId).trim().toLowerCase();
        if (!filterValue || this.matchesGlobalFilter(item, filterValue)) {
          height += 28;
        }
      }
    }

    return height;
  }

  private alignMenuPositionToAnchor(): void {
    const anchorBottom = this.position?.anchorBottom;
    if (typeof anchorBottom !== 'number' || Number.isNaN(anchorBottom) || !this.menuBox?.nativeElement) {
      return;
    }

    const viewportPadding = 8;
    const menuRect = (this.menuBox.nativeElement as HTMLElement).getBoundingClientRect();
    const anchoredTop = Math.max(viewportPadding, anchorBottom - menuRect.height);
    if (Math.abs(anchoredTop - this.position.y) <= MENU_ANCHOR_ALIGNMENT_EPSILON) {
      return;
    }

    this.position = {
      ...this.position,
      y: anchoredTop,
    };
  }

  private scheduleMenuGeometryCorrection(): void {
    if (this.pendingMenuGeometryCorrection) {
      return;
    }

    this.pendingMenuGeometryCorrection = true;
    this.menuGeometryCorrectionTimeout = setTimeout(() => {
      this.pendingMenuGeometryCorrection = false;
      this.menuGeometryCorrectionTimeout = null;

      if (this.pendingAnchorAlignment) {
        this.alignMenuPositionToAnchor();
        this.pendingAnchorAlignment = false;
      }

      if (this.pendingViewportAdjustment) {
        this.adjustMenuPositionWithinViewport();
      }
    });
  }

  private adjustMenuPositionWithinViewport(): void {
    if (!this.menuBox?.nativeElement || !this.position) {
      this.pendingViewportAdjustment = false;
      return;
    }

    const viewportPadding = 8;
    const menuRect = (this.menuBox.nativeElement as HTMLElement).getBoundingClientRect();
    let nextTop = this.position.y;

    const overflowBottom = menuRect.bottom - (window.innerHeight - viewportPadding);
    if (overflowBottom > 0) {
      nextTop = Math.max(viewportPadding, nextTop - overflowBottom);
    }

    if (menuRect.top < viewportPadding) {
      nextTop = Math.max(nextTop, viewportPadding);
    }

    if (nextTop !== this.position.y) {
      this.position = {
        ...this.position,
        y: nextTop,
      };
    }

    this.pendingViewportAdjustment = false;
  }

  private trimSectionSeparators(items: IMenuItem[]): IMenuItem[] {
    const normalized: IMenuItem[] = [];

    for (const item of items) {
      if (item.sep && (normalized.length === 0 || normalized[normalized.length - 1].sep)) {
        continue;
      }
      normalized.push(item);
    }

    while (normalized.length > 0 && normalized[normalized.length - 1].sep) {
      normalized.pop();
    }

    return normalized;
  }

  private buildMenuListSignature(items: readonly any[]): string {
    return items
      .map((item) => {
        if (!item) {
          return 'empty';
        }
        if (item.sep) {
          return 'sep';
        }

        const action = typeof item.action === 'string' ? item.action : '';
        const name = typeof item.name === 'string' ? item.name : '';
        const text = typeof item.text === 'string' ? item.text : '';
        const current = item.current ? 'current' : '';
        const disabled = item.disabled ? 'disabled' : '';
        const childCount = Array.isArray(item.children) ? item.children.length : 0;
        const actionCount = Array.isArray(item.actions) ? item.actions.length : 0;
        const section = typeof item.extra?.section === 'string' ? item.extra.section : '';
        const sectionId = typeof item.extra?.sectionId === 'string' ? item.extra.sectionId : '';
        const collapsed = item.extra?.collapsed === false ? 'expanded' : 'collapsed';
        return [action, name, text, current, disabled, childCount, actionCount, section, sectionId, collapsed].join(':');
      })
      .join('|');
  }

  // 显示子菜单
  showSubMenu(event: MouseEvent, item: IMenuItem) {
    this.cancelSubmenuClose();

    if (!this.hasSubmenuContent(item)) {
      this.activeSubmenuItem = null;
      this.setModelSubmenuBodyState(false);
      this.setSubmenuReady(false);
      this.pendingSubmenuGeometry = false;
      this.activeSubmenuAnchor = null;
      return;
    }

    if (this.activeSubmenuItem === item) {
      const submenuElement = this.submenuBox?.nativeElement as HTMLElement | undefined;
      if (!submenuElement?.classList.contains('ready')) {
        this.calculateSubmenuPosition(event.currentTarget as HTMLElement | null);
      }
      return;
    }

    this.activeSubmenuItem = item;
    this.setModelSubmenuBodyState(true);
    this.setSubmenuReady(false);
    this.calculateSubmenuPosition(event.currentTarget as HTMLElement | null);
  }

  // 计算子菜单位置
  calculateSubmenuPosition(menuItemElement: HTMLElement | null) {
    if (menuItemElement && this.menuBox?.nativeElement) {
      const menuBoxElement = this.menuBox.nativeElement;
      const menuBoxRect = menuBoxElement.getBoundingClientRect();
      const itemRect = menuItemElement.getBoundingClientRect();
      const primaryMenuWidth = menuBoxRect.width;
      const estimatedSubmenuWidth = Math.min(
        this.estimateSubmenuWidth(this.activeSubmenuItem),
        primaryMenuWidth,
      );
      const estimatedSubmenuHeight = this.estimateSubmenuHeight(this.activeSubmenuItem);

      const left = this.resolveSubmenuLeft(menuBoxRect.left, menuBoxRect.right, estimatedSubmenuWidth);
      const top = this.resolveSubmenuTop(itemRect.top, itemRect.height, estimatedSubmenuHeight);

      this.activeSubmenuAnchor = {
        menuLeft: menuBoxRect.left,
        menuRight: menuBoxRect.right,
        itemTop: itemRect.top,
        itemHeight: itemRect.height,
      };

      this.submenuWidth = 'max-content';
      this.submenuMaxWidth = `${primaryMenuWidth}px`;
      this.submenuMaxHeight = 'none';
      this.submenuOverflow = 'visible';

      this.submenuPosition = {
        left: left + 'px',
        top: top + 'px'
      };
      this.pendingSubmenuGeometry = true;
      this.scheduleSubmenuGeometryRefinement(this.activeSubmenuItem);
    }
  }

  private scheduleSubmenuGeometryRefinement(item: IMenuItem | null): void {
    if (this.submenuGeometryTimeout) {
      clearTimeout(this.submenuGeometryTimeout);
    }

    this.submenuGeometryTimeout = setTimeout(() => {
      this.submenuGeometryTimeout = null;
      if (this.activeSubmenuItem === item && this.pendingSubmenuGeometry) {
        this.refineSubmenuPosition();
      }
    }, 0);
  }

  private estimateSubmenuWidth(item: IMenuItem | null | undefined): number {
    return this.hasHoverFlyout(item) ? 304 : 168;
  }

  private estimateSubmenuDetailHeight(item: IMenuItem | null | undefined): number {
    if (!this.shouldShowSubmenuDetail(item)) {
      return 0;
    }

    const descriptionLines = this.getSubmenuDescriptionLines(item);
    const hasContextValue = !!this.getSubmenuContextValue(item);
    const titleHeight = this.getSubmenuTitle(item) ? 20 : 0;
    const separatorHeight = this.hasSubmenuIntroContent(item) ? 11 : 0;
    const descriptionHeight = descriptionLines.length > 0 ? descriptionLines.length * 18 + 4 : 0;
    const contextHeight = hasContextValue ? 34 : 0;
    return titleHeight + separatorHeight + descriptionHeight + contextHeight + 18;
  }

  private estimateSubmenuHeight(item: IMenuItem | null | undefined): number {
    const submenuItems = this.getSubmenuChildren(item);
    const detailHeight = this.estimateSubmenuDetailHeight(item);
    const childrenHeight = submenuItems.reduce((total, subItem) => total + this.estimateSubmenuItemHeight(subItem), 0);
    const sectionLabelHeight = this.getSubmenuSectionLabel(item) && submenuItems.length > 0 ? 28 : 0;
    const separatorHeight = submenuItems.length > 0 && detailHeight > 0 ? 9 : 0;
    const verticalPadding = 10;
    return detailHeight + sectionLabelHeight + separatorHeight + childrenHeight + verticalPadding;
  }

  private estimateSubmenuItemHeight(item: IMenuItem | null | undefined): number {
    const detail = this.getSubmenuItemDetail(item);
    const detailLines = detail ? this.splitDisplayLines(detail).length : 0;
    return 32 + (detailLines > 0 ? detailLines * 16 + 6 : 0);
  }

  private resolveSubmenuLeft(menuLeft: number, menuRight: number, submenuWidth: number): number {
    const viewportPadding = 8;
    const submenuGap = this.usesMainMenuParity() ? 2 : -4;
    let left = menuRight + submenuGap;
    if (left + submenuWidth > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, menuLeft - submenuWidth - submenuGap);
    }
    return left;
  }

  private resolveSubmenuTop(itemTop: number, itemHeight: number, submenuHeight: number): number {
    const viewportPadding = 8;
    const viewportHeight = window.innerHeight;
    const preferredTop = this.usesMainMenuParity()
      ? itemTop
      : Math.round(itemTop + itemHeight / 2 - submenuHeight / 2);
    const maxTop = Math.max(viewportPadding, viewportHeight - submenuHeight - viewportPadding);
    return Math.min(maxTop, Math.max(viewportPadding, preferredTop));
  }

  private usesMainMenuParity(): boolean {
    return this.hostRef.nativeElement.classList.contains('main-menu-parity');
  }

  private refineSubmenuPosition(): void {
    const submenuElement = this.submenuBox?.nativeElement as HTMLElement | undefined;
    if (!submenuElement || !this.activeSubmenuAnchor) {
      this.pendingSubmenuGeometry = false;
      return;
    }

    const submenuRect = submenuElement.getBoundingClientRect();
    const left = this.resolveSubmenuLeft(
      this.activeSubmenuAnchor.menuLeft,
      this.activeSubmenuAnchor.menuRight,
      submenuRect.width,
    );
    const top = this.resolveSubmenuTop(
      this.activeSubmenuAnchor.itemTop,
      this.activeSubmenuAnchor.itemHeight,
      submenuRect.height,
    );

    submenuElement.style.left = `${left}px`;
    submenuElement.style.top = `${top}px`;
    submenuElement.style.maxHeight = 'none';
    submenuElement.style.overflowY = 'visible';
    this.updateSubmenuHoverScrollDistances(submenuElement);
    this.setSubmenuReady(true);
    this.pendingSubmenuGeometry = false;
  }

  private updateSubmenuHoverScrollDistances(submenuElement: HTMLElement): void {
    const scrollViewports = submenuElement.querySelectorAll<HTMLElement>('.submenu-hover-scroll');
    scrollViewports.forEach((viewport) => {
      const content = viewport.querySelector<HTMLElement>('.submenu-hover-scroll-content');
      if (!content) {
        return;
      }

      const distance = Math.max(0, content.scrollWidth - viewport.clientWidth);
      const duration = Math.max(
        SUBMENU_HOVER_SCROLL_MIN_DURATION_SECONDS,
        distance / SUBMENU_HOVER_SCROLL_SPEED_PX_PER_SECOND,
      );
      content.style.setProperty('--submenu-hover-scroll-distance', `${distance}px`);
      content.style.setProperty('--submenu-hover-scroll-duration', `${duration.toFixed(2)}s`);
    });
  }

  private getSubmenuTooltipLines(item: IMenuItem | null | undefined): string[] {
    const tooltip = this.getSubmenuTooltipTitle(item);
    if (!tooltip) {
      return [];
    }

    return this.splitDisplayLines(tooltip);
  }

  private splitDisplayLines(text: string): string[] {
    return text
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private isCapabilityLine(line: string): boolean {
    return /^能力\s*[:：]/.test(line);
  }

  private setSubmenuReady(ready: boolean): void {
    const submenuElement = this.submenuBox?.nativeElement as HTMLElement | undefined;
    if (!submenuElement) {
      return;
    }

    submenuElement.classList.toggle('ready', ready);
  }

  private setModelSubmenuBodyState(isOpen: boolean): void {
    if (typeof document === 'undefined' || !this.hostRef.nativeElement.classList.contains('model-menu')) {
      return;
    }

    document.body.classList.toggle(CHAT_MODEL_SUBMENU_OPEN_BODY_CLASS, isOpen);
  }

  // 隐藏子菜单
  hideSubMenu(event: MouseEvent, index: number) {
    if (this.submenuTimeout) {
      clearTimeout(this.submenuTimeout);
    }

    const interactionVersion = ++this.submenuInteractionVersion;
    const itemToClose = this.activeSubmenuItem;
    this.submenuTimeout = setTimeout(() => {
      this.submenuTimeout = null;
      if (
        interactionVersion !== this.submenuInteractionVersion
        || this.activeSubmenuItem !== itemToClose
      ) {
        return;
      }

      this.activeSubmenuItem = null;
      this.setModelSubmenuBodyState(false);
      this.setSubmenuReady(false);
      this.pendingSubmenuGeometry = false;
      this.activeSubmenuAnchor = null;
    }, 100);
  }

  // 保持子菜单打开
  keepSubMenuOpen() {
    this.cancelSubmenuClose();
  }

  private cancelSubmenuClose(): void {
    this.submenuInteractionVersion += 1;
    if (this.submenuTimeout) {
      clearTimeout(this.submenuTimeout);
      this.submenuTimeout = null;
    }
  }

  subItemClick(event, subItem) {
    if (subItem.disabled) {
      return;
    }
    const parent = this.activeSubmenuItem;
    // 串口/开发板子菜单保留单选勾选；最近项目等列表不切换勾选状态
    if (parent?.children && !parent.submenuNoRadio) {
      parent.children.forEach(item => {
        item['check'] = false;
      });
      subItem['check'] = true;
    }
    this.subItemClickEvent.emit(subItem);
  }
}
