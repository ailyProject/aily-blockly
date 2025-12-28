import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  QueryList,
  ViewChildren,
} from '@angular/core';

@Component({
  selector: 'app-menu',
  imports: [CommonModule],
  templateUrl: './menu.component.html',
  styleUrl: './menu.component.scss',
})
export class MenuComponent {
  @ViewChild('menuBox') menuBox!: ElementRef;
  @ViewChild('submenuBox') submenuBox!: ElementRef;
  @ViewChildren('menuItem') menuItems!: QueryList<ElementRef>;

  @Input() menuList: any[] = [];

  @Input() position = {
    x: 2,
    y: 40,
  };

  @Input() width: number | undefined;

  @Output() itemClickEvent = new EventEmitter();
  @Output() subItemClickEvent = new EventEmitter();
  @Output() closeEvent = new EventEmitter();

  @Input() keywords: string[] = [];

  // 子菜单显示状态管理
  activeSubmenuIndex: number | null = null;
  submenuTimeout: any = null;
  submenuPosition = { left: '0px', top: '0px' };
  submenuMaxHeight = 'none';
  submenuOverflow = 'visible';

  ngAfterViewInit(): void {
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleDocumentClick);
  }

  ngOnDestroy(): void {
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentClick);
  }

  itemClick(item: any) {
    if (item.disabled) return;
    if (item.children) return;
    this.itemClickEvent.emit(item);
  }

  handleDocumentClick = (event: MouseEvent) => {
    event.preventDefault();
    const target = event.target as Node;

    const isClickInMainMenu = this.menuBox && this.menuBox.nativeElement.contains(target);
    const isClickInSubmenu = this.submenuBox && this.submenuBox.nativeElement && this.submenuBox.nativeElement.contains(target);

    if (!isClickInMainMenu && !isClickInSubmenu) {
      this.closeMenu();
    }
  };

  closeMenu() {
    this.closeEvent.emit('');
  }

  isHighlight(text: string) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return this.keywords.some((keyword) =>
      keyword && lowerText.includes(keyword.toLowerCase())
    );
  }

  showInRouter(menuItem: any) {
    return true;
  }

  showSubMenu(event: MouseEvent, index: number) {
    if (this.submenuTimeout) {
      clearTimeout(this.submenuTimeout);
    }
    this.activeSubmenuIndex = index;
    setTimeout(() => {
      this.calculateSubmenuPosition(index);
    }, 0);
  }

  calculateSubmenuPosition(index: number) {
    const menuItems = this.menuItems.toArray();
    let targetItemIndex = 0;
    let visibleItemCount = 0;

    for (let i = 0; i <= index; i++) {
      const item = this.menuList[i];
      if (item.sep) {
        continue;
      }
      const shouldRender = (item.children && item.children.length > 0) || (!item.children && this.showInRouter(item));
      if (shouldRender) {
        if (i === index) {
          targetItemIndex = visibleItemCount;
        }
        visibleItemCount++;
      }
    }

    if (menuItems[targetItemIndex]) {
      const menuItemElement = menuItems[targetItemIndex].nativeElement;
      const menuBoxElement = this.menuBox.nativeElement;
      const menuBoxRect = menuBoxElement.getBoundingClientRect();
      const itemRect = menuItemElement.getBoundingClientRect();

      const left = menuBoxRect.right + 2;
      const top = itemRect.top;

      this.submenuPosition = {
        left: left + 'px',
        top: top - 2 + 'px'
      };

      this.calculateSubmenuHeight(top);
    }
  }

  calculateSubmenuHeight(submenuTop: number) {
    const windowHeight = window.innerHeight;
    const submenuTopFromWindow = submenuTop;

    const submenuItems = this.menuList[this.activeSubmenuIndex!]?.children || [];
    const itemHeight = 30;
    const padding = 6;
    const estimatedSubmenuHeight = submenuItems.length * itemHeight + padding;

    const bottomPadding = 10;
    const maxAvailableHeight = windowHeight - submenuTopFromWindow - bottomPadding;

    if (estimatedSubmenuHeight > maxAvailableHeight) {
      this.submenuMaxHeight = maxAvailableHeight + 'px';
      this.submenuOverflow = 'auto';
    } else {
      this.submenuMaxHeight = 'none';
      this.submenuOverflow = 'visible';
    }
  }

  hideSubMenu(event: MouseEvent, index: number) {
    this.submenuTimeout = setTimeout(() => {
      if (this.activeSubmenuIndex === index) {
        this.activeSubmenuIndex = null;
      }
    }, 100);
  }

  keepSubMenuOpen(index: number) {
    if (this.submenuTimeout) {
      clearTimeout(this.submenuTimeout);
    }
    this.activeSubmenuIndex = index;
  }

  subItemClick(event: MouseEvent, subItem: any) {
    this.menuList[this.activeSubmenuIndex!].children.forEach((item: any) => {
      item['check'] = false;
    });
    subItem['check'] = true;
    this.subItemClickEvent.emit(subItem);
  }
}
