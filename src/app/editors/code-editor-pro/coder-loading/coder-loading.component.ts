import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

export type CoderLoadingStage = 'project' | 'dependency' | 'runtime' | 'workbench' | 'ready';

const STAGE_META: Record<CoderLoadingStage, { number: string; translationKey: string }> = {
  project: { number: '01', translationKey: 'AILY_CODE_LOADING.PROJECT' },
  dependency: { number: '02', translationKey: 'AILY_CODE_LOADING.DEPENDENCY' },
  runtime: { number: '03', translationKey: 'AILY_CODE_LOADING.RUNTIME' },
  workbench: { number: '04', translationKey: 'AILY_CODE_LOADING.WORKBENCH' },
  ready: { number: '05', translationKey: 'AILY_CODE_LOADING.READY' },
};

@Component({
  selector: 'app-coder-loading',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './coder-loading.component.html',
  styleUrl: './coder-loading.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoderLoadingComponent {
  @Input() stage: CoderLoadingStage = 'project';
  @Input() visible = false;
  @Input() revealing = false;
  @Input() error: string | null = null;
  @Input() allowReinstall = false;
  @Output() retry = new EventEmitter<void>();
  @Output() reinstall = new EventEmitter<void>();

  get stageNumber(): string {
    return STAGE_META[this.stage].number;
  }

  get stageKey(): string {
    return STAGE_META[this.stage].translationKey;
  }
}
