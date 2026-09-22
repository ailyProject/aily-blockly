import { Component, EventEmitter, OnDestroy, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { PlaygroundService } from './playground.service';
import { ElectronService } from '@core/platform/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import {
  normalizePlaygroundPage,
  PlaygroundHistoryState,
  PlaygroundSearchHistory,
} from './playground-search-history';

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
export class PlaygroundComponent implements OnDestroy {
  @Output() close = new EventEmitter();

  tagList: any[] = [];
  board: string = '';
  keyword: string = '';
  // exampleList = []

  private readonly searchSubject = new Subject<string | null>();
  private readonly searchHistory = new PlaygroundSearchHistory();
  private readonly destroy$ = new Subject<void>();
  private initialSearchStateCaptured = false;
  private restoringHistory = false;

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private translate: TranslateService,
    private playgroundService: PlaygroundService,
    private electronService: ElectronService,
    private configService: ConfigService,
  ) {

  }

  ngOnInit() {
    this.searchSubject.pipe(
      debounceTime(200),
      takeUntil(this.destroy$),
    ).subscribe(keyword => {
      if (keyword !== null) {
        this.navigateToState({ keyword, page: 1 });
      }
    });

    // 获取查询参数中的 board
    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        this.board = params['board'] || '';
        this.keyword = params['keyword'] || '';
        const state: PlaygroundHistoryState = {
          keyword: this.keyword,
          page: normalizePlaygroundPage(params['page']),
        };

        if (!this.initialSearchStateCaptured) {
          this.searchHistory.reset(state);
          this.initialSearchStateCaptured = true;
        } else if (this.restoringHistory) {
          this.restoringHistory = false;
        } else {
          this.searchHistory.visit(state);
        }
      });

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

    this.electronService.setTitle(`${this.configService.getApplicationName()} - Playground`);
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  search(keyword = this.keyword) {
    this.keyword = keyword;
    this.searchSubject.next(keyword);
  }

  private navigateToState(state: PlaygroundHistoryState, replaceUrl = false) {
    const queryParams: any = {
      keyword: state.keyword,
      page: state.page,
    };
    if (this.board) {
      queryParams.board = this.board;
    }
    this.router.navigate(['/main/playground/list'], {
      queryParams,
      replaceUrl,
    });
  }

  get canGoBack(): boolean {
    return this.searchHistory.canGoBack;
  }

  home() {
    this.router.navigate(['/main/guide']);
  }

  back() {
    const previousState = this.searchHistory.back();
    if (previousState === null) {
      return;
    }

    // 取消尚未触发的输入搜索，防止它覆盖刚恢复的历史状态。
    this.searchSubject.next(null);
    this.keyword = previousState.keyword;
    this.restoringHistory = true;
    this.navigateToState(previousState, true);
  }
}
