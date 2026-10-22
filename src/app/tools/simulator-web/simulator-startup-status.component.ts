import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

export type SimulatorStartupPhase = 'project' | 'view' | 'error';

/** Presentation only: phases come from the owning product's actual promises. */
@Component({
  selector: 'app-simulator-startup-status',
  standalone: true,
  templateUrl: './simulator-startup-status.component.html',
  styleUrl: './simulator-startup-status.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimulatorStartupStatusComponent {
  @Input() phase: SimulatorStartupPhase = 'project';
  @Input() message = '';

  get title(): string {
    return this.phase === 'project' ? '正在准备仿真环境'
      : this.phase === 'view' ? '正在打开仿真视图' : '仿真器暂未就绪';
  }

  get detail(): string {
    return this.phase === 'error' ? this.message
      : this.phase === 'project' ? '正在读取当前项目与资源配置' : '正在连接同一项目的仿真视图';
  }
}
