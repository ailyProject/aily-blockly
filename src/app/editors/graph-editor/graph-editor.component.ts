import { Component, Input, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IframeComponent } from '../../windows/iframe/iframe.component';
import { ThemeService } from '../../services/theme.service';

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

  private readonly baseUrl = 'https://tool.aily.pro/connection-graph?type=json';
  // private readonly baseUrl = 'http://localhost:4201/connection-graph?type=json';

  constructor(
    private route: ActivatedRoute,
    private themeService: ThemeService
  ) {}

  ngOnInit(): void {
    this.resolvedUrl =
      this.url ??
      this.route.snapshot.queryParams['url'] ??
      `${this.baseUrl}&theme=${this.themeService.theme()}`;
  }
}
