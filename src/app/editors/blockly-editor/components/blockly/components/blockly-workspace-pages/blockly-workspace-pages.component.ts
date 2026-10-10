import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDropDownModule } from 'ng-zorro-antd/dropdown';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { TranslateModule } from '@ngx-translate/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { BlocklyPageSnapshot } from '../../../../services/blockly.service';
import { BlocklyFunctionViewState, emptyBlocklyFunctionView } from '../../../../utils/blockly-function-view';

@Component({
  selector: 'app-blockly-workspace-pages',
  imports: [
    CommonModule,
    NzButtonModule,
    NzDropDownModule,
    NzMenuModule,
    NzTabsModule,
    TranslateModule,
    CdkMenuModule,
  ],
  templateUrl: './blockly-workspace-pages.component.html',
  styleUrl: './blockly-workspace-pages.component.scss',
})
export class BlocklyWorkspacePagesComponent {
  @Input() pages: BlocklyPageSnapshot[] = [];
  @Input() closedPages: BlocklyPageSnapshot[] = [];
  @Input() activePageId = '';
  @Input() aiWriting = false;
  @Input() showSpinOverlay = false;
  @Input() isFadingOut = false;
  @Input() functionView: BlocklyFunctionViewState = emptyBlocklyFunctionView();
  @Input() functionViewDisabled = false;
  // Let CDK close the menu and restore its trigger before the editor moves
  // focus into the chosen workspace, so refresh/shortcuts are not left paused.
  @Output() functionSelected = new EventEmitter<string>(true);

  @Output() pageSelected = new EventEmitter<string>();
  @Output() pageAdded = new EventEmitter<void>();
  @Output() pageClosed = new EventEmitter<string>();
  @Output() pageReopened = new EventEmitter<string>();

  @ViewChild('blocklyDiv', { static: true }) blocklyDiv!: ElementRef<HTMLDivElement>;

  get blocklyHostElement(): HTMLDivElement {
    return this.blocklyDiv.nativeElement;
  }

  get selectedIndex(): number {
    const activeIndex = this.pages.findIndex((page) => page.id === this.activePageId);
    return activeIndex === -1 ? 0 : activeIndex;
  }

  updateHoverScroll(viewport: HTMLElement, content: HTMLElement): void {
    // Match MenuComponent: 28 px/s, at least 1.2 s, with a 0.35 s CSS delay.
    const distance = Math.max(0, content.scrollWidth - viewport.clientWidth);
    viewport.classList.toggle('is-overflowing', distance > 0);
    content.style.setProperty('--hover-scroll-distance', `${distance}px`);
    content.style.setProperty('--hover-scroll-duration', `${Math.max(1.2, distance / 28).toFixed(2)}s`);
  }

  onMenuItemFocus(viewport: HTMLElement, content: HTMLElement): void {
    // CDK focuses before the connected overlay finishes positioning. Ensure
    // the focused row is fully visible once the menu has its final geometry.
    requestAnimationFrame(() => {
      if (!viewport.isConnected) return;
      this.updateHoverScroll(viewport, content);
      const row = viewport.parentElement!, menu = row.parentElement!;
      const hovered = menu.querySelector('.function-view__item:hover');
      if (document.activeElement !== row || (hovered && hovered !== row)) return;
      const bounds = menu.getBoundingClientRect(), item = row.getBoundingClientRect();
      if (item.top < bounds.top + 5) menu.scrollTop += item.top - bounds.top - 5;
      else if (item.bottom > bounds.bottom - 5) menu.scrollTop += item.bottom - bounds.bottom + 5;
    });
  }

  get selectedFunction() {
    return this.functionView.options.find(item => item.id === this.functionView.scopeId);
  }

  trackPage(_index: number, page: BlocklyPageSnapshot): string {
    return page.id;
  }

  onTabChange(index: number) {
    const page = this.pages[index];
    if (page) {
      this.pageSelected.emit(page.id);
    }
  }

  onTabClose({ index }: { index: number }) {
    const page = this.pages[index];
    if (page) {
      this.pageClosed.emit(page.id);
    }
  }

  onReopenPage(pageId: string) {
    this.pageReopened.emit(pageId);
  }
}
