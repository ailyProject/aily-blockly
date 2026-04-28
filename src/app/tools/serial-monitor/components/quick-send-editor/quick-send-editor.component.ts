import { Component, effect } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { SerialMonitorService } from '../../serial-monitor.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { FormsModule } from '@angular/forms';
import { NzCodeEditorModule } from 'ng-zorro-antd/code-editor';
import { ThemeService } from '../../../../services/theme.service';

@Component({
  selector: 'app-quick-send-editor',
  imports: [
    NzButtonModule,
    FormsModule,
    NzCodeEditorModule
  ],
  templateUrl: './quick-send-editor.component.html',
  styleUrl: './quick-send-editor.component.scss'
})
export class QuickSendEditorComponent {

  options: any = {
    language: 'json',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true
  }

  code = '';

  constructor(
    private serialMonitorService: SerialMonitorService,
    private message: NzMessageService,
    private themeService: ThemeService
  ) {
    // 监听主题变化，动态切换 Monaco 主题
    effect(() => {
      const monacoTheme = this.themeService.getMonacoTheme();
      this.options = { ...this.options, theme: monacoTheme };
    });
  }

  ngOnInit() {
    this.code = JSON.stringify(this.serialMonitorService.quickSendList, null, 2)
  }

  save() {
    // 检查是否为json格式
    try {
      let data = JSON.parse(this.code);
      // 数据格式检查
      this.checkData(data);
      this.serialMonitorService.quickSendList = data;
      this.serialMonitorService.saveQuickSendList();
      this.serialMonitorService.loadQuickSendList();
      this.message.success('保存成功');
    } catch (e) {
      this.message.error('保存失败，请检查json格式');
    }
  }

  checkData(data) {
    if (!Array.isArray(data)) {
      throw new Error('数据必须是数组格式');
    }

    // 检查每个元素是否符合QuickSendItem接口
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      // 检查必要字段是否存在
      if (!item.hasOwnProperty('name') || !item.hasOwnProperty('type') || !item.hasOwnProperty('data')) {
        throw new Error(`第${i + 1}项缺少必要字段(name, type, data)`);
      }

      // 检查字段类型
      if (typeof item.name !== 'string') {
        throw new Error(`第${i + 1}项的name字段必须是字符串`);
      }

      if (typeof item.data !== 'string') {
        throw new Error(`第${i + 1}项的data字段必须是字符串`);
      }

      // 检查type字段是否为有效值
      if (!['signal', 'text', 'hex'].includes(item.type)) {
        throw new Error(`第${i + 1}项的type字段必须是 'signal', 'text' 或 'hex'`);
      }
    }
  }
}
