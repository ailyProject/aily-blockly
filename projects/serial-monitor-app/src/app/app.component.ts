import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SerialMonitorComponent } from './serial-monitor/serial-monitor.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    SerialMonitorComponent
  ],
  template: `
    <div class="app-container">
      <app-serial-monitor></app-serial-monitor>
    </div>
  `,
  styles: [`
    .app-container {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
  `]
})
export class AppComponent {
  title = 'serial-monitor-app';
}
