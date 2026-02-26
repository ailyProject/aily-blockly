import { Component, Input, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { CommonModule } from '@angular/common';
import { ProjectService } from '../../services/project.service';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ImageViewerComponent } from '../image-viewer/image-viewer.component';
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
    private uiService: UiService,
    private translate: TranslateService
  ) { }

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
    const pinmapJsonPath = this.boardPackagePath + '/pinmap.json';
    if (this.electronService.exists(pinmapJsonPath)) {
      // 使用子窗口打开，通过 URL 查询参数传递文件路径
      // this.uiService.openWindow({
      //   path: `pinjson?filePath=${encodeURIComponent(pinjsonPath)}`,
      //   width: 800,
      //   height: 600
      // });
      this.uiService.openWindow({
        path: `iframe?url=${encodeURIComponent('https://tool.aily.pro/component-viewer?type=json&theme=dark')}`,
        // path: `iframe?url=${encodeURIComponent('http://localhost:3051/component-viewer?type=json')}`,
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

  openFeedback() {
    this.uiService.openFeedback();
  }

  openHistory() {
    this.uiService.openHistory();
  }

  showCircuit() {
    this.message.info(this.translate.instant('FLOAT_SIDER.CIRCUIT') + ' ' + this.translate.instant('COMMON.FEATURE_COMING_SOON'));
    // return;
    if (this.electronService.isElectron) {
      this.uiService.openWindow({
        // path: `iframe?url=${encodeURIComponent('https://tool.aily.pro/connection-graph?type=json&theme=dark')}`,
        path: `iframe?url=${encodeURIComponent('http://localhost:4201/connection-graph?type=json&theme=dark')}`,
        data: { a: 1, b: 2 },
        width: 800,
        height: 600
      });
    }
  }
}
