import { Component, ChangeDetectorRef } from '@angular/core';
import { BlocklyEditorComponent } from '../tools/blockly-editor/blockly-editor.component';
import { FooterComponent } from './components/footer/footer.component';
import { HeaderComponent } from './components/header/header.component';
import { CommonModule } from '@angular/common';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { AilyChatComponent } from '../tools/aily-chat/aily-chat.component';
import { TerminalComponent } from '../tools/terminal/terminal.component';
import { ToolContainerComponent } from '../components/tool-container/tool-container.component';
import { UiService } from '../services/ui.service';
import { SerialMonitorComponent } from '../tools/serial-monitor/serial-monitor.component';
import { CodeViewerComponent } from '../tools/code-viewer/code-viewer.component';
import { ProjectService } from '../services/project.service';
import { GuideComponent } from './components/guide/guide.component';
import { SimplebarAngularModule } from 'simplebar-angular';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NotificationComponent } from './components/notification/notification.component';

@Component({
  selector: 'app-main-window',
  imports: [
    CommonModule,
    HeaderComponent,
    FooterComponent,
    BlocklyEditorComponent,
    NzLayoutModule,
    NzResizableModule,
    AilyChatComponent,
    TerminalComponent,
    GuideComponent,
    SerialMonitorComponent,
    CodeViewerComponent,
    SimplebarAngularModule,
    NotificationComponent
  ],
  templateUrl: './main-window.component.html',
  styleUrl: './main-window.component.scss',
})
export class MainWindowComponent {
  showRbox = false;
  showBbox = false;
  terminalTab = 'default';

  loaded = false;
  showLibManager = false;

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  get topTool() {
    return this.uiService.topTool;
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private message: NzMessageService,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.uiService.init();
    this.projectService.init();
  }

  ngAfterViewInit(): void {
    this.uiService.actionSubject.subscribe((e: any) => {
      // console.log(e);
      switch (e.type) {
        case 'tool':
          if (e.action === 'open') {
            this.showRbox = true;
          } else {
            if (this.topTool === null) {
              this.showRbox = false;
            }
          }
          break;
        case 'terminal':
          if (e.action === 'open') {
            this.showBbox = true;
            this.terminalTab = e.data;
          } else {
            this.showBbox = false;
          }
          break;
        default:
          break;
      }
      this.cd.detectChanges();
    });

    this.projectService.stateSubject.subscribe((state) => {
      switch (state) {
        case 'loading':
          this.message.loading('Project Loading...');
          this.loaded = true;
          break;
        case 'loaded':
          this.message.remove();
          this.message.success('Project Loaded');
          break;
        case 'saving':
          this.message.loading('Project Saving ...');
          break;
        case 'saved':
          this.message.remove();
          this.message.success('Project Saved');
          break;
        default:
          break;
      }
      this.cd.detectChanges();
    });
  }

  closeRightBox() {
    this.showRbox = false;
  }

  bottomHeight = 210;
  siderWidth = 400;

  onSideResize({ width }: NzResizeEvent): void {
    this.siderWidth = width!;
  }

  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }
}
