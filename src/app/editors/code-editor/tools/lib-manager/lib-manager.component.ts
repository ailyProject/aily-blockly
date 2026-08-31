import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ToolContainerComponent } from '../../../../components/tool-container/tool-container.component';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { UiService } from '@core/app-shell/public-api';

@Component({
  selector: 'app-lib-manager-src',
  imports: [
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule
  ],
  templateUrl: './lib-manager.component.html',
  styleUrl: './lib-manager.component.scss'
})
export class LibManagerComponent {
  currentUrl;

  windowInfo = '库管理';

  constructor(
    private uiService: UiService,
    private router: Router,
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  close() {
    this.uiService.closeTool('app-store');
  }
}
