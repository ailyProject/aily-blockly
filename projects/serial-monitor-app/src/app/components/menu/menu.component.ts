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
import { TranslateModule } from '@ngx-translate/core';
import { IMenuItem } from '../../configs/menu.config';
import { Router } from '@angular/router';

@Component({
  selector: 'app-menu',
  imports: [CommonModule, TranslateModule],
  templateUrl: './menu.component.html',
  styleUrl: './menu.component.scss',
})
export class MenuComponent {
  @ViewChild('menuBox') menuBox: ElementRef;
  @ViewChild('submenuBox') submenuBox: ElementRef;
  @ViewChildren('menuItem') menuItems: QueryList<ElementRef>;

  @Input() menuList = [];

  @Input() position = {
    x: 2,
    y: 40,
  };

  @Input() width;

  @Output() itemClickEvent = new EventEmitter();

  @Output() subItemClickEvent = new EventEmitter();

  @Output() closeEvent = new EventEmitter();

  @Input() keywords = [];

  // 添加子菜单显示状态管理
  activeSubmenuIndex: number | null = null;
  submenuTimeout: any = null;
  submenuPosition = { left: '0px', top: '0px' };
  submenuMaxHeight = 'none';
  submenuOverflow = 'visible';

  constructor(private router: Router) { }

  ngAfterViewInit(): void {
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleDocumentClick);
  }

  ngOnDestroy(): void {
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentClick);
  }

  itemClick(item) {
    if (item.disabled) return;
    if (item.children) return;
    this.itemClickEvent.emit(item);
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
    this.closeEvent.emit('');
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
  // 显示子菜单
  showSubMenu(event: MouseEvent, index: number) {
    // 清除之前的延时
    if (this.submenuTimeout) {
      clearTimeout(this.submenuTimeout);
    }
    this.activeSubmenuIndex = index;
    // 计算子菜单位置
    setTimeout(() => {
      this.calculateSubmenuPosition(index);
    }, 0);
  }

  // 计算子菜单位置
  calculateSubmenuPosition(index: number) {
    const menuItems = this.menuItems.toArray();
    let targetItemIndex = 0;
    let visibleItemCount = 0;

    // 计算目标菜单项在可见项中的索引
    for (let i = 0; i <= index; i++) {
      const item = this.menuList[i];
      // 跳过分隔符
      if (item.sep) {
        continue;
      }
      // 检查是否应该渲染这个菜单项
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

      // 子菜单显示在主菜单右侧
      const left = menuBoxRect.right + 2;
      const top = itemRect.top;

      this.submenuPosition = {
        left: left + 'px',
        top: top - 2 + 'px'
      };

      // 计算子菜单高度
      this.calculateSubmenuHeight(top);
    }
  }

  // 计算子菜单最大高度
  calculateSubmenuHeight(submenuTop: number) {
    const windowHeight = window.innerHeight;
    const submenuTopFromWindow = submenuTop;

    // 预估子菜单项数量和高度
    const submenuItems = this.menuList[this.activeSubmenuIndex]?.children || [];
    const itemHeight = 30; // 每个菜单项高度
    const padding = 6; // 上下padding (3px * 2)
    const estimatedSubmenuHeight = submenuItems.length * itemHeight + padding;

    // 计算最大可用高度 (窗口高度 - 子菜单顶部距离 - 底部预留空间)
    const bottomPadding = 10; // 底部预留空间
    const maxAvailableHeight = windowHeight - submenuTopFromWindow - bottomPadding;

    // 如果预估高度超过最大可用高度,启用滚动
    if (estimatedSubmenuHeight > maxAvailableHeight) {
      this.submenuMaxHeight = maxAvailableHeight + 'px';
      this.submenuOverflow = 'auto';
    } else {
      this.submenuMaxHeight = 'none';
      this.submenuOverflow = 'visible';
    }
  }

  // 隐藏子菜单
  hideSubMenu(event: MouseEvent, index: number) {
    // 延时隐藏，给用户时间移动到子菜单
    this.submenuTimeout = setTimeout(() => {
      if (this.activeSubmenuIndex === index) {
        this.activeSubmenuIndex = null;
      }
    }, 100);
  }

  // 保持子菜单打开
  keepSubMenuOpen(index: number) {
    if (this.submenuTimeout) {
      clearTimeout(this.submenuTimeout);
    }
    this.activeSubmenuIndex = index;
  }

  subItemClick(event, subItem) {
    this.menuList[this.activeSubmenuIndex].children.forEach(item => {
      item['check'] = false
    });
    subItem['check'] = true
    this.subItemClickEvent.emit(subItem);
  }
}
