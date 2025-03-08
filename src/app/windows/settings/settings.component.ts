import { Component } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-settings',
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    NzButtonModule,
    NzInputModule,
    NzRadioModule
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  items = [
    {
      name: '基础设置',
      icon: 'fa-light fa-gear',
      content: [
        { name: '默认项目文件夹', key: 'fa-light fa-gear' },
        { name: '语言', key: 'base.lang' },
      ],
    },
    {
      name: '编译设置',
      icon: 'fa-light fa-screwdriver-wrench',
      content: [

      ],
    },
    {
      name: '主题设置',
      icon: 'fa-light fa-gift',
      content: [
        { name: '主题', key: 'theme.theme' },
        { name: '字体', key: 'theme.font' },
      ],
    },
    {
      name: '仓库设置',
      icon: 'fa-light fa-book-bookmark',
      content: [{ name: '仓库地址', type: 'registry-manager' }],
    },
    {
      name: '开发板管理',
      icon: 'fa-light fa-layer-group',
      content: [{ name: '开发板', type: 'board-manager' }],
    },
  ];

  UiThemeValue='dark';
  blocklyThemeValue='default';

  npmRegistryListStr = `https://registry.npmjs.org/
https://registry.npm.taobao.org/`;

  // boardList=[,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,]

  get boardList() {
    return this.settingsService.boardList;
  }

  data: any = {
    project_path: '',
    npm_registry: [],
  };

  constructor(
    private uiService: UiService,
    private settingsService: SettingsService,
  ) {
    this.init();
  }

  init() {
    console.log('init settings');
    this.settingsService.getBoardList().then(() => {
      console.log('boardList: ', this.boardList);
    });
  }

  currentType = this.items[0];
  selectType(item) {
    this.currentType = item;
  }

  cancel() {
    this.uiService.closeWindow();
  }

  apply() {
    // 保存到config.json，如有需要立即加载的，再加载

    // 保存完毕后关闭窗口
    this.uiService.closeWindow();
  }
}
