import { ChangeDetectorRef, Component, NgZone, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subscription } from 'rxjs';
import { ProjectService } from '@domain/project/public-api';
import { CodeEditorFrameComponent } from './code-editor-frame.component';
import { CodeEditorProProjectService } from './services/code-editor-pro-project.service';
import { CoderProjectRuntimeService } from '../../integrations/coder/coder-project-runtime.service';
import { NotificationComponent } from '../../components/notification/notification.component';

@Component({
  selector: 'app-code-editor-pro',
  imports: [TranslateModule, CodeEditorFrameComponent, NotificationComponent],
  templateUrl: './code-editor-pro.component.html',
  styleUrl: './code-editor-pro.component.scss',
})
export class CodeEditorProComponent implements OnInit, OnDestroy {
  private readonly subscriptions = new Subscription();
  private closing = new Set<string>();

  constructor(
    readonly projectService: ProjectService,
    readonly runtime: CoderProjectRuntimeService,
    private readonly persistence: CodeEditorProProjectService,
    private readonly route: ActivatedRoute,
    private readonly message: NzMessageService,
    private readonly translate: TranslateService,
    private readonly changeDetector: ChangeDetectorRef,
    private readonly zone: NgZone,
  ) {}

  get coderProjects() { return this.projectService.coderProjects; }
  isCoderTabActive(path: string) { return path === this.projectService.currentProjectPath; }
  coderTabOperation(path: string) { return this.projectService.getCoderOperation(path)?.kind || null; }
  coderTabProgress(path: string): number | null {
    if (!this.coderTabOperation(path)) return null;
    const progress = this.runtime.getState(path).notice?.progress;
    return typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, Math.round(progress)))
      : null;
  }
  coderTabTitle(path: string) {
    const operation = this.coderTabOperation(path);
    if (!operation) return path;
    const label = this.translate.instant('CODER_TABS.' + (operation === 'build' ? 'BUILDING' : 'UPLOADING'));
    const progress = this.coderTabProgress(path);
    return `${path} — ${label}${progress === null ? '' : ` ${progress}%`}`;
  }
  coderTabClosing(path: string) { return this.closing.has(path) || !!this.coderTabOperation(path); }

  ngOnInit(): void {
    this.persistence.init();
    this.subscriptions.add(this.runtime.states$.subscribe(() => {
      const refresh = () => this.changeDetector.markForCheck();
      if (NgZone.isInAngularZone()) refresh();
      else this.zone.run(refresh);
    }));
    this.subscriptions.add(this.route.queryParams.subscribe(params => {
      if (params['path'] && !this.isCoderTabActive(params['path'])) void this.selectCoderProject(params['path']);
    }));
  }
  ngOnDestroy(): void { this.subscriptions.unsubscribe(); this.persistence.destroy(); }

  async selectCoderProject(path: string): Promise<void> {
    if (this.isCoderTabActive(path)) return;
    try { await this.projectService.projectOpen(path); }
    catch (error) { this.message.error(error instanceof Error ? error.message : String(error)); }
  }

  async closeCoderProject(path: string, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.coderTabClosing(path)) return;
    this.closing.add(path);
    try {
      await this.persistence.saveAll(path);
      if (this.isCoderTabActive(path)) {
        const index = this.coderProjects.findIndex(project => project.path === path);
        const next = this.coderProjects[index + 1] || this.coderProjects[index - 1];
        if (!next || !await this.projectService.projectOpen(next.path)) return;
      }
      await this.projectService.removeCoderProject(path);
    } catch (error) { this.message.error(error instanceof Error ? error.message : String(error)); }
    finally { this.closing.delete(path); }
  }
}
