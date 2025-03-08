import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from './services/electron.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  title = 'aily-blockly';

  constructor(
    private translate: TranslateService,
    private electronService: ElectronService
  ) {
    this.translate.addLangs(['zh', 'en']);
    this.translate.setDefaultLang('zh');
    this.translate.use('zh');
    this.electronService.init();

  }
}
