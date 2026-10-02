import { Injectable, signal } from '@angular/core';

export const CODER_SIDEBAR_TOGGLE_CHANNEL = 'aily-coder-editor-sidebar-toggle';
export const CODER_SIDEBAR_STATE_CHANNEL = 'aily-coder-editor-sidebar-state';

/** Each open project owns its iframe and reports its actual workbench layout. */
@Injectable({ providedIn: 'root' })
export class CoderEditorLayoutService {
  private readonly editors = signal(new Map<string, { frame: Window; visible: boolean }>());

  sidebarVisible(path: string): boolean | null {
    return this.editors().get(path)?.visible ?? null;
  }

  updateSidebar(path: string, frame: Window, visible: boolean): void {
    const previous = this.editors().get(path);
    if (previous?.frame === frame && previous.visible === visible) return;
    this.editors.update(editors => new Map(editors).set(path, { frame, visible }));
  }

  reset(path: string): void {
    if (!this.editors().has(path)) return;
    this.editors.update(editors => {
      const next = new Map(editors);
      next.delete(path);
      return next;
    });
  }

  toggleSidebar(path: string): void {
    this.editors().get(path)?.frame.postMessage({ channel: CODER_SIDEBAR_TOGGLE_CHANNEL }, '*');
  }
}
