import { AfterViewInit, Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ElectronService } from './services/electron.service';
import { ConfigService } from './services/config.service';
import { TranslationService } from './services/translation.service';
import { ThemeService } from './services/theme.service';

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

  async ngOnInit() {
    await this.electronService.init();
    await this.configService.init();
    this.themeService.init();
    await this.translationService.init();
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
