import { Component } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { SimulatorEditorComponent } from './simulator-editor/simulator-editor.component';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-simulator',
  imports: [
    CommonModule,
    ToolContainerComponent,
    SubWindowComponent,
    SimulatorEditorComponent
  ],
  templateUrl: './simulator.component.html',
  styleUrl: './simulator.component.scss'
})
export class SimulatorComponent {

  currentUrl;

  constructor(
    private router: Router,
    private uiService: UiService
  ) {

  }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  close() {
    this.uiService.closeTool('simulator');
  }


}
