import { AfterViewInit, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ConfigService, TranslationService, ThemeService } from '@core/preferences/public-api';
import { SubappManagerService } from '@integration/subapps/public-api';
import { BuildSourceQueryService } from './integrations/build/build-source-query.service';
import { HubClientLoginService } from './services/integrations/hub/hub-client-login.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, AfterViewInit {
  title = 'aily';

  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private themeService = inject(ThemeService);
  private subappManager = inject(SubappManagerService);
  private buildSourceQuery = inject(BuildSourceQueryService);
  private hubClientLogin = inject(HubClientLoginService);

  async ngOnInit() {
    this.buildSourceQuery.initialize();
    await this.configService.init();
    this.hubClientLogin.initialize();
    this.title = this.configService.getApplicationName();
    document.title = this.title;
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
