import { Component } from '@angular/core';
import { InnerWindowComponent } from '../../components/inner-window/inner-window.component';
import { CodeEditorComponent } from '../../components/code-editor/code-editor.component';
import { BlocklyService } from '../../blockly/blockly.service';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-code-viewer',
  imports: [
    CodeEditorComponent,
    InnerWindowComponent,
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule
  ],
  templateUrl: './code-viewer.component.html',
  styleUrl: './code-viewer.component.scss',
})
export class CodeViewerComponent {
  code = '';

  currentUrl;

  windowInfo = '代码查看';

  constructor(
    private blocklyService: BlocklyService,
    private uiService: UiService,
    private router: Router,
  ) {}

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void {
    this.blocklyService.codeSubject.subscribe((code) => {
      setTimeout(() => {
        this.code = code;
      }, 100);
    });
  }

  close() {
    this.uiService.closeTool('code-viewer');
  }
}
