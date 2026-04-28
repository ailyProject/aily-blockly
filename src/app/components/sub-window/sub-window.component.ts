import { Component, Input, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { PlatformService } from '../../services/platform.service';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-sub-window',
  imports: [],
  templateUrl: './sub-window.component.html',
  styleUrl: './sub-window.component.scss',
})
export class SubWindowComponent implements OnDestroy {
  @Input() title = 'sub-window';
  @Input() winBtns = ['gomain', 'minimize', 'maximize', 'close'];

  currentUrl;
  isMacFullScreen = false;
  private unsubscribeFullScreenChanged?: () => void;
  private unsubscribeMaximizeChanged?: () => void;

  get isMac() {
    return this.platformService.isMac();
  }

  get isWindowFullScreen() {
    return this.electronService.isWindowFullScreen();
  }

  constructor(
    private router: Router,
    private platformService: PlatformService,
    private electronService: ElectronService,
    private cd: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit() {
    if (this.electronService.isElectron) {
      // 监听窗口全屏状态变化
      this.unsubscribeFullScreenChanged = this.electronService.onWindowFullScreenChanged((isFullScreen: boolean) => {
        this.isMacFullScreen = isFullScreen;
        // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
        setTimeout(() => {
          this.cd.detectChanges();
        }, 0);
      });

      // 监听窗口最大化状态变化（用于更新图标）
      this.unsubscribeMaximizeChanged = this.electronService.onWindowMaximizeChanged((isMaximized: boolean) => {
        // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
        setTimeout(() => {
          this.cd.detectChanges();
        }, 0);
      });
    }
  }

  ngOnDestroy() {
    if (this.electronService.isElectron) {
      // 取消窗口全屏状态变化监听
      if (this.unsubscribeFullScreenChanged) {
        this.unsubscribeFullScreenChanged();
      }
      // 取消窗口最大化状态变化监听
      if (this.unsubscribeMaximizeChanged) {
        this.unsubscribeMaximizeChanged();
      }
    }
  }

  goMain() {
    window['iWindow'].goMain(this.currentUrl);
  }

  minimize() {
    window['iWindow'].minimize();
  }

  maximize() {
    if (window['iWindow'].isMaximized()) {
      window['iWindow'].unmaximize();
    } else {
      window['iWindow'].maximize();
    }
    // 状态会通过事件监听器自动更新
  }

  close() {
    window['iWindow'].close();
  }
}
