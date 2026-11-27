import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';

export interface ProjectSaveMessage {
  project: string;
  messageId: string;
}

/** The menu and the focused Coder frame present the latest save for a project. */
@Injectable({ providedIn: 'root' })
export class ProjectSaveMessageService {
  private readonly visible = new Map<string, ProjectSaveMessage>();

  constructor(private message: NzMessageService, private translate: TranslateService) {}

  saving(project: string): ProjectSaveMessage {
    this.clear(this.visible.get(project));
    const { messageId } = this.message.loading(this.translate.instant('MAIN_WINDOW.PROJECT_SAVING'), { nzDuration: 0 });
    const owner = { project, messageId };
    this.visible.set(project, owner);
    return owner;
  }

  saved(project: string, progress?: ProjectSaveMessage): ProjectSaveMessage | undefined {
    if (this.visible.get(project) !== progress || (progress && progress.project !== project)) return;
    this.clear(progress);
    const notice = this.message.success(this.translate.instant('MAIN_WINDOW.PROJECT_SAVED'), { nzDuration: 4000, nzAnimate: false });
    const owner = { project, messageId: notice.messageId };
    this.visible.set(project, owner);
    notice.onClose.subscribe(() => {
      if (this.visible.get(project) === owner) this.visible.delete(project);
    });
    return owner;
  }

  clear(owner?: ProjectSaveMessage): boolean {
    if (!owner || this.visible.get(owner.project) !== owner) return false;
    this.visible.delete(owner.project);
    this.message.remove(owner.messageId);
    return true;
  }
}
