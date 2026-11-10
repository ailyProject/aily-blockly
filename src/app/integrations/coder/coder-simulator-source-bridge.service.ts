import { Injectable } from '@angular/core';

const REQUEST = 'aily-coder-editor-simulator-source-request';
const RESPONSE = 'aily-coder-editor-simulator-source-response';
const REQUEST_TIMEOUT_MS = 3_000;

type SourceCommand = { action: 'clear' } | {
  action: 'show';
  path: string;
  line: number;
  sha256: string;
  focus: boolean;
};

interface EditorFrame {
  readonly frame: Window;
  readonly origin: string;
  readonly probe: string;
  ready: boolean;
  pending?: {
    readonly requestId: string;
    readonly sequence: number;
    readonly settle: (applied: boolean) => void;
  };
}

/** The active native workbench opens project-relative locations from its own filesystem. */
@Injectable({ providedIn: 'root' })
export class CoderSimulatorSourceBridgeService {
  private readonly editors = new Map<string, EditorFrame>();
  private sequence = 0;

  attach(projectRoot: string, frame: Window, origin: string, reloaded = false): void {
    projectRoot = this.key(projectRoot);
    const previous = this.editors.get(projectRoot);
    if (!reloaded && previous?.frame === frame && previous.origin === origin && previous.ready) return;
    previous?.pending?.settle(false);
    const probe = `simulator-source-probe-${++this.sequence}`;
    this.editors.set(projectRoot, { frame, origin, probe, ready: false });
    frame.postMessage({ channel: REQUEST, v: 1, action: 'probe', requestId: probe }, origin);
  }

  detach(projectRoot: string, frame: Window | null | undefined): void {
    projectRoot = this.key(projectRoot);
    const editor = this.editors.get(projectRoot);
    if (!editor || editor.frame !== frame) return;
    this.clear(projectRoot);
    this.editors.delete(projectRoot);
  }

  show(projectRoot: string, source: Omit<Extract<SourceCommand, { action: 'show' }>, 'action'>): Promise<boolean> {
    projectRoot = this.key(projectRoot);
    const editor = this.editors.get(projectRoot);
    if (!editor?.ready) return Promise.resolve(false);
    editor.pending?.settle(false);
    return new Promise(resolve => {
      const sequence = ++this.sequence;
      const requestId = `simulator-source-${sequence}`;
      const timer = setTimeout(() => {
        if (editor.pending?.sequence === sequence) this.clear(projectRoot);
      }, REQUEST_TIMEOUT_MS);
      editor.pending = { requestId, sequence, settle: applied => {
        clearTimeout(timer);
        delete editor.pending;
        resolve(applied);
      } };
      this.post(editor, requestId, sequence, { action: 'show', ...source });
    });
  }

  clear(projectRoot: string): void {
    const editor = this.editors.get(this.key(projectRoot));
    if (!editor) return;
    editor.pending?.settle(false);
    if (!editor.ready) return;
    const sequence = ++this.sequence;
    this.post(editor, `simulator-source-${sequence}`, sequence, { action: 'clear' });
  }

  receive(projectRoot: string, event: MessageEvent): boolean {
    if (event.data?.channel !== RESPONSE) return false;
    const editor = this.editors.get(this.key(projectRoot));
    if (!editor || event.source !== editor.frame || event.origin !== editor.origin || event.data.v !== 1) return true;
    if (event.data.action === 'ready' && event.data.requestId === editor.probe) {
      editor.ready = true;
      return true;
    }
    const pending = editor?.pending;
    if (pending && event.data.requestId === pending.requestId
      && event.data.sequence === pending.sequence
      && (event.data.status === 'applied' || event.data.status === 'ignored')) {
      pending.settle(event.data.status === 'applied');
    }
    return true;
  }

  private post(editor: EditorFrame, requestId: string, sequence: number, command: SourceCommand): void {
    editor.frame.postMessage({ channel: REQUEST, v: 1, requestId, sequence, ...command }, editor.origin);
  }

  private key(projectRoot: string): string {
    const resolved = window['path'].resolve(projectRoot);
    return /^[A-Za-z]:[\\/]/u.test(resolved) ? resolved.toLowerCase() : resolved;
  }
}
