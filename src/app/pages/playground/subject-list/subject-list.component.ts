import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfigService } from '../../../services/config.service';
import { ActivatedRoute } from '@angular/router';
import { PlaygroundService } from '../playground.service';

@Component({
  selector: 'app-subject-list',
  imports: [RouterModule, CommonModule, FormsModule, NzInputModule, NzButtonModule, TranslateModule],
  templateUrl: './subject-list.component.html',
  styleUrl: './subject-list.component.scss'
})
export class SubjectListComponent {
  subjectList: any[] = [];
  resourceUrl: string = '';
  keyword: string = '';

  constructor(
    private configService: ConfigService,
    private translate: TranslateService,
    private route: ActivatedRoute,
    private playgroundService: PlaygroundService
  ) {
    // 从URL参数中获取搜索关键词（如果有）
    this.route.queryParams.subscribe(params => {
      if (params['keyword']) {
        this.keyword = params['keyword'];
      }
    });
  }

  ngAfterViewInit() {
    this.resourceUrl = this.configService.data.resource[0] + "/imgs/examples/";
    
    // 如果数据已经加载，直接使用
    if (this.playgroundService.isLoaded) {
      this.subjectList = this.playgroundService.processedExamplesList;
      console.log(this.subjectList);
      
      // 如果URL中有关键词，执行搜索
      if (this.keyword) {
        this.search(this.keyword);
      }
    } else {
      // 如果数据未加载，等待加载完成
      this.playgroundService.loadExamplesList().then(() => {
        this.subjectList = this.playgroundService.processedExamplesList;
        console.log(this.subjectList);
        
        // 如果URL中有关键词，执行搜索
        if (this.keyword) {
          this.search(this.keyword);
        }
      });
    }
  }

  search(keyword = this.keyword) {
    this.subjectList = this.playgroundService.searchExamples(keyword);
  }

  onImgError(event) {
    (event.target as HTMLImageElement).src = 'imgs/subject.webp';
  }

  clearSearch() {
    this.keyword = '';
    this.search();
  }
}
