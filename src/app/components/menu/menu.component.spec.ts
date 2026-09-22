import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { ApplicationRef, EnvironmentInjector, NgZone, createComponent } from '@angular/core';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { MenuComponent } from './menu.component';
import { IMenuItem } from '../../configs/menu.config';

describe('MenuComponent submenu switching', () => {
  let fixture: ComponentFixture<MenuComponent>;
  let menu: MenuComponent;
  let items: IMenuItem[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MenuComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    fixture = TestBed.createComponent(MenuComponent);
    menu = fixture.componentInstance;
    fixture.nativeElement.classList.add('main-menu-parity');
    items = [
      { name: 'USB 模式', key: 'USBMode', children: [
        { name: 'Hardware CDC and JTAG', key: 'USBMode', data: 'hwcdc', check: true },
        { name: 'USB-OTG (TinyUSB)', key: 'USBMode', data: 'default' },
      ] },
      { name: '闪存模式', key: 'FlashMode', children: [
        { name: 'QIO 80MHz', key: 'FlashMode', data: 'qio', check: true },
        { name: 'DIO 80MHz', key: 'FlashMode', data: 'dio' },
        { name: 'OPI 80MHz', key: 'FlashMode', data: 'opi' },
      ] },
      { name: 'PSRAM', key: 'PSRAM', children: [
        { name: 'Disabled', key: 'PSRAM', data: 'disabled' },
        { name: 'OPI PSRAM', key: 'PSRAM', data: 'opi', check: true },
      ] },
      { name: '切换开发板', action: 'board-select' },
    ];
    fixture.componentRef.setInput('menuList', items);
    fixture.componentRef.setInput('width', 260);
    fixture.detectChanges();
  });

  function enter(index: number): void {
    const row: HTMLElement = fixture.nativeElement.querySelectorAll('.menu-box:not(.submenu-box) > .menu-item')[index];
    row.dispatchEvent(new MouseEvent('mouseenter'));
  }

  function submenu(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.submenu-box');
  }

  it('switches the rendered options and selected row together', fakeAsync(() => {
    tick();
    for (const index of [0, 1, 2, 0, 2, 1]) {
      enter(index);
      fixture.detectChanges();
      tick();
      expect(submenu()?.textContent).toContain(items[index].children![0].name!);
      expect(fixture.nativeElement.querySelectorAll('.menu-box:not(.submenu-box) > .active').length).toBe(1);
      expect(submenu()?.classList.contains('ready')).toBeTrue();
    }
  }));

  it('does not expose old options when the geometry timer runs before rendering', fakeAsync(() => {
    tick();
    enter(0);
    fixture.detectChanges();
    tick();
    enter(1);
    tick();
    // Angular coalesces rendering. A timer must not reveal the old USB choices
    // at the new Flash Mode anchor while that render is still pending.
    if (submenu()?.classList.contains('ready')) {
      expect(submenu()?.textContent).toContain('QIO 80MHz');
    }
    fixture.detectChanges();
    expect(submenu()?.textContent).toContain('QIO 80MHz');
    expect(submenu()?.classList.contains('ready')).toBeTrue();
  }));

  it('keeps the newly entered submenu open after leaving the previous row', fakeAsync(() => {
    tick();
    enter(0);
    fixture.detectChanges();
    menu.hideSubMenu(new MouseEvent('mouseleave'), 0);
    enter(1);
    fixture.detectChanges();
    tick(150);
    expect(menu.activeSubmenuItem).toBe(items[1]);
    expect(submenu()?.textContent).toContain('QIO 80MHz');
  }));

  it('renders hover changes for a menu created outside Angular by a host callback', async () => {
    const zone = TestBed.inject(NgZone);
    const app = TestBed.inject(ApplicationRef);
    const host = document.createElement('app-menu');
    document.body.appendChild(host);
    const ref = zone.runOutsideAngular(() => {
      const ref = createComponent(MenuComponent, {
        environmentInjector: TestBed.inject(EnvironmentInjector), hostElement: host,
      });
      ref.instance.menuList = items;
      ref.instance.width = 260;
      app.attachView(ref.hostView);
      ref.changeDetectorRef.detectChanges();
      return ref;
    });
    try {
      const rows = host.querySelectorAll('.menu-box:not(.submenu-box) > .menu-item');
      for (const index of [0, 1, 2]) {
        zone.runOutsideAngular(() => rows[index].dispatchEvent(new MouseEvent('mouseenter')));
        await app.whenStable();
        expect(host.querySelector('.submenu-box.ready')?.textContent)
          .toContain(items[index].children![0].name!);
        expect(host.querySelector('.menu-box:not(.submenu-box) > .active')?.textContent)
          .toContain(items[index].name!);
      }
      zone.runOutsideAngular(() => host.querySelector('.submenu-box')!
        .dispatchEvent(new MouseEvent('mouseleave')));
      await new Promise(resolve => setTimeout(resolve, 160));
      await app.whenStable();
      expect(host.querySelector('.submenu-box')).toBeNull();
      expect(host.querySelector('.active')).toBeNull();
    } finally {
      app.detachView(ref.hostView);
      ref.destroy();
      host.remove();
    }
  });

  it('emits only the newly displayed option and preserves other groups selection', fakeAsync(() => {
    tick();
    const selected = jasmine.createSpy('selected');
    menu.subItemClickEvent.subscribe(selected);
    enter(0);
    fixture.detectChanges();
    enter(1);
    fixture.detectChanges();
    submenu()!.querySelectorAll<HTMLElement>('.menu-item')[1].click();
    expect(selected).toHaveBeenCalledOnceWith(items[1].children![1]);
    expect(items[1].children!.map(item => item.check)).toEqual([false, true, false]);
    expect(items[0].children![0].check).toBeTrue();
  }));

  it('allows crossing the gap into the submenu and closes after leaving it', fakeAsync(() => {
    tick();
    enter(0);
    fixture.detectChanges();
    menu.hideSubMenu(new MouseEvent('mouseleave'), 0);
    tick(50);
    submenu()!.dispatchEvent(new MouseEvent('mouseenter'));
    tick(100);
    expect(menu.activeSubmenuItem).toBe(items[0]);
    submenu()!.dispatchEvent(new MouseEvent('mouseleave'));
    tick(100);
    fixture.detectChanges();
    expect(submenu()).toBeNull();
  }));

  it('clears a pending submenu when entering a leaf or disabled item', fakeAsync(() => {
    tick();
    enter(0);
    fixture.detectChanges();
    enter(1);
    enter(3);
    tick();
    fixture.detectChanges();
    expect(submenu()).toBeNull();
    items[2].disabled = true;
    enter(2);
    fixture.detectChanges();
    expect(submenu()).toBeNull();
  }));

  it('cancels the close timer and model overlay state on close and destroy', fakeAsync(() => {
    tick();
    fixture.nativeElement.classList.add('model-menu');
    enter(0);
    fixture.detectChanges();
    expect(document.body.classList.contains('aily-chat-model-submenu-open')).toBeTrue();
    menu.hideSubMenu(new MouseEvent('mouseleave'), 0);
    menu.closeMenu();
    expect(menu.submenuTimeout).toBeNull();
    fixture.detectChanges();
    expect(submenu()).toBeNull();
    expect(document.body.classList.contains('aily-chat-model-submenu-open')).toBeFalse();
    enter(0);
    fixture.detectChanges();
    menu.hideSubMenu(new MouseEvent('mouseleave'), 0);
    fixture.destroy();
    tick(150);
    expect(menu.submenuTimeout).toBeNull();
    expect(document.body.classList.contains('aily-chat-model-submenu-open')).toBeFalse();
  }));
});
