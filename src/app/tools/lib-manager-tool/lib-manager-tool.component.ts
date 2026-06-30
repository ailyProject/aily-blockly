import { Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { LibManagerComponent } from '../../editors/blockly-editor/components/lib-manager/lib-manager.component';
import { UiService } from '../../services/ui.service';

/** 主窗口右侧工具栏：复用 Blockly 库管理页面 */
@Component({
  selector: 'app-lib-manager-tool',
  imports: [ToolContainerComponent, LibManagerComponent, TranslateModule],
  templateUrl: './lib-manager-tool.component.html',
  styleUrl: './lib-manager-tool.component.scss',
})
export class LibManagerToolComponent {
  constructor(private uiService: UiService) {}

  close(): void {
    this.uiService.closeTool('lib-manager');
  }
}
