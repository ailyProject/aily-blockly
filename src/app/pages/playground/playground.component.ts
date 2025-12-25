import { Component, EventEmitter, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Location } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { PlaygroundService } from './playground.service';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-playground',
  imports: [
    FormsModule,
    NzButtonModule,
    NzTagModule,
    NzInputModule,
    NzToolTipModule,
    TranslateModule,
    RouterModule
  ],
  templateUrl: './playground.component.html',
  styleUrl: './playground.component.scss'
})
export class PlaygroundComponent {
  @Output() close = new EventEmitter();

  tagList: any[] = [];
  // exampleList = []

  constructor(
    private router: Router,
    private location: Location,
    private translate: TranslateService,
    private playgroundService: PlaygroundService,
    private electronService: ElectronService
  ) {

  }

  ngOnInit() {
    // 在组件初始化时加载示例数据
    // this.playgroundService.loadExamplesList().then(() => {
    //   console.log('示例数据加载完成');
    // }).catch(error => {
    //   console.error('加载示例数据失败:', error);
    // });

    // 使用翻译初始化标签列表
    this.tagList = [
      {
        text: 'SenseCraft AI',
        color: '#739c19ff'
      },
      {
        text: 'AI-VOX',
      },
      {
        text: 'UNO R4',
      },
      {
        text: 'ESP32S3',
      },
      {
        text: '程序设计基础',
      }
    ];

    this.electronService.setTitle('aily blockly - Playground');
  }

  keyword: string = '';
  search(keyword = this.keyword) {
    // keyword = keyword.replace(/\s/g, '').toLowerCase();
    this.router.navigate(['/main/playground/list'], {
      queryParams: { keyword }
    });
  }

  back() {
    // // 检查是否有历史记录可以返回
    // if (window.history.length > 1) {
    //   this.location.back();
    // } else {
    //   // 如果没有历史记录，跳转到项目初始默认路径
    //   this.router.navigate(['/main/guide']);
    // }

    this.router.navigate(['/main/guide']);
  }
}
