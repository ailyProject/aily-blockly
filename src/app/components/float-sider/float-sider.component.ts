import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { PinmapComponent } from '../../app-store/pinmap/pinmap.component';
import { FeedbackDialogComponent } from '../feedback-dialog/feedback-dialog.component';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { CommonModule } from '@angular/common';
import { ProjectService } from '../../services/project.service';
import { Router, NavigationEnd } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
@Component({
  selector: 'app-float-sider',
  imports: [
    NzModalModule,
    NzToolTipModule,
    CommonModule
  ],
  templateUrl: './float-sider.component.html',
  styleUrl: './float-sider.component.scss'
})
export class FloatSiderComponent implements OnInit, OnDestroy {
  @Input() show = false;

  loaded = false;
  private routerSubscription: Subscription | undefined;

  constructor(
    private modal: NzModalService,
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private message: NzMessageService
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
    if (!this.electronService.exists(this.boardPackagePath + '/pinmap.webp')) {
      this.message.error('该开发板没有提供引脚图');
      return;
    }
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzContent: PinmapComponent,
      nzData: {
        img: this.boardPackagePath + '/pinmap.webp' // 假设 pinmap 图片路径
      },
      nzWidth: '500px',
    });
  }


  openDocUrl() {
    let data = JSON.parse(this.electronService.readFile(this.boardPackagePath + '/package.json'))
    if (!data.url) {
      this.message.error('该开发板没有提供文档链接');
      return;
    }
    this.electronService.openUrl(data.url)
  }

  openSettings() {

  }

  openFeedback() {
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzContent: FeedbackDialogComponent,
      nzWidth: '500px',
    });

    // 处理反馈结果
    modalRef.afterClose.subscribe(result => {
      if (result?.result === 'success') {
        console.log('反馈已提交:', result.data);
      }
    });
  }
}
