import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { AILY_CODER_EDITOR_SUBAPP_ID } from '../../configs/required-subapp.config';
import { ConfigService } from '@core/preferences/public-api';
import {
  RequiredSubappService,
  RequiredSubappState,
} from '@integration/subapps/public-api';

@Component({
  selector: 'app-coder-subapp-install-notice',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './coder-subapp-install-notice.component.html',
  styleUrl: './coder-subapp-install-notice.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoderSubappInstallNoticeComponent implements OnInit, OnDestroy {
  state: RequiredSubappState = {
    id: AILY_CODER_EDITOR_SUBAPP_ID,
    status: 'loading',
    installed: false,
    installing: false,
    percent: 0,
  };

  startingInstallation = false;
  private stateSubscription: Subscription | null = null;
  private destroyed = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly requiredSubapps: RequiredSubappService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  get visible(): boolean {
    return this.configService.isCoderProduct() && !this.state.installed;
  }

  get installing(): boolean {
    return this.startingInstallation || this.state.installing;
  }

  get progress(): number {
    return Math.max(1, this.state.percent || 0);
  }

  async ngOnInit(): Promise<void> {
    await this.configService.init();
    if (this.destroyed || !this.configService.isCoderProduct()) return;

    this.stateSubscription = this.requiredSubapps
      .observe(AILY_CODER_EDITOR_SUBAPP_ID)
      .subscribe((state) => {
        this.state = state;
        this.cdr.markForCheck();
      });
    void this.install();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stateSubscription?.unsubscribe();
    this.stateSubscription = null;
  }

  retry(): void {
    void this.install();
  }

  private async install(): Promise<void> {
    if (this.installing || this.destroyed) return;
    this.startingInstallation = true;
    this.cdr.markForCheck();
    try {
      await this.requiredSubapps.ensureInstalled(AILY_CODER_EDITOR_SUBAPP_ID);
    } catch (error) {
      console.warn(
        '[Subapp] Default Aily Coder Editor installation failed:',
        error,
      );
    } finally {
      this.startingInstallation = false;
      if (!this.destroyed) this.cdr.markForCheck();
    }
  }
}
