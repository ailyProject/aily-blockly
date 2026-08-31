import { AfterViewInit, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ElectronService } from '@core/platform/public-api';
import { ConfigService, TranslationService, ThemeService } from '@core/preferences/public-api';
import { SubappManagerService } from '@integration/subapps/public-api';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, AfterViewInit {
  title = 'aily-blockly';

  private electronService = inject(ElectronService);
  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private themeService = inject(ThemeService);
  private subappManager = inject(SubappManagerService);

  async ngOnInit() {
    await this.electronService.init();
    await this.configService.init();
    this.themeService.init();
    await this.translationService.init();
    await this.subappManager.initialize();
  }

  ngAfterViewInit() {
    this.hideStartupLoading();
  }

  private hideStartupLoading() {
    const loadingBox = document.getElementById('app-loading-box');
    if (!loadingBox) {
      return;
    }

    loadingBox.classList.add('loading-box--hidden');
    setTimeout(() => loadingBox.remove(), 220);
  }

}
