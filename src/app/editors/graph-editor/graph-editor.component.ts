import { Component, Input, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IframeComponent } from '../../windows/iframe/iframe.component';
import { ConfigService, ThemeService } from '@core/preferences/public-api';
import { getToolWebUrl } from '../../configs/api.config';

@Component({
  selector: 'app-graph-editor',
  standalone: true,
  imports: [IframeComponent],
  templateUrl: './graph-editor.component.html',
  styleUrl: './graph-editor.component.scss',
})
export class GraphEditorComponent implements OnInit {
  @Input() url?: string;

  resolvedUrl = '';

  constructor(
    private route: ActivatedRoute,
    private themeService: ThemeService,
    private configService: ConfigService
  ) {}

  async ngOnInit(): Promise<void> {
    const explicitUrl = this.url ?? this.route.snapshot.queryParams['url'];

    if (explicitUrl != null) {
      this.resolvedUrl = explicitUrl;

      return;
    }

    await this.configService.init();

    this.resolvedUrl = `${getToolWebUrl()}/connection-graph?type=json&theme=${this.themeService.theme()}`;
  }
}
