import { Component } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { EditorComponent } from './editor/editor.component';

@Component({
  selector: 'app-cloud-space',
  imports: [
    ToolContainerComponent,
    FormsModule,
    CommonModule,
    NzButtonModule,
    EditorComponent
  ],
  templateUrl: './cloud-space.component.html',
  styleUrl: './cloud-space.component.scss'
})
export class CloudSpaceComponent {

  itemList = [, , , , , , , , , , ,]
  isSyncing = false;

  constructor(
    private uiService: UiService,
  ) { }


  syncProject() {
    let project = {
      name: '项目名称',  // packagename, 唯一的
      nickname: '项目昵称',  // 显示出来的名字
      description: '项目描述', // 项目描述
      image: "hhaha.webp", // 项目图片 500x250
      createTime: '2024-01-01 12:00:00', // 实际不传，服务器生成
      updateTime: '2024-01-01 12:00:00', // 实际不传，服务器生成

    }

    // cloudService.uploadProject(project)
  }

  syncToCloud() {
    this.isSyncing = true;

    // 模拟同步过程（实际中应该是异步API调用）
    setTimeout(() => {
      this.isSyncing = false;
      // 这里可以添加成功或失败的处理逻辑
    }, 2000);
  }

  showEditor = false;

  openEditor() {
    this.showEditor = true;
  }

  showSearch = false;
  openSearch() {
    this.showSearch = true;
  }


  close() {
    this.uiService.closeTool('cloud-space');
  }
}
