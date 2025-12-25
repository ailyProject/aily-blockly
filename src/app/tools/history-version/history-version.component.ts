import { Component } from '@angular/core';
import { LoginComponent } from '../../components/login/login.component';
import { EditorComponent } from '../cloud-space/editor/editor.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-history-version',
  imports: [
    ToolContainerComponent,
    FormsModule,
    CommonModule,
    NzButtonModule,
    EditorComponent,
    LoginComponent
  ],
  templateUrl: './history-version.component.html',
  styleUrl: './history-version.component.scss'
})
export class HistoryVersionComponent {

  constructor(
    private uiService: UiService
  ) { }

  close() {
    this.uiService.closeTool('history-version');
  }
}
