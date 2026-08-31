import { Injectable } from '@angular/core';
import type { AiEditDiffFilePayload, AiEditDiffFileType, AiEditDiffOpenPayload } from './coder-diff/ai-coder-diff-channels';

const STORE_FILENAME = 'coder-ai-diff-preview.json';

export interface AiCoderDiffPreviewStoreV1 {
  v: 1;
  workspaceRoot: string;
  previewId: string;
  title: string;
  files: readonly AiCoderDiffPreviewStoreFileV1[];
  createdAt: number;
}

export interface AiCoderDiffPreviewStoreFileV1 {
  filePath: string;
  baselineContent: string;
  type: AiEditDiffFileType;
}

@Injectable({ providedIn: 'root' })
export class AiCoderDiffPreviewStoreService {
  private storePath(workspaceRoot: string): string {
    return window['path'].join(workspaceRoot, '.aily', STORE_FILENAME);
  }

  save(workspaceRoot: string, payload: AiEditDiffOpenPayload): void {
    if (!workspaceRoot || !payload.files.length) {
      return;
    }

    const record: AiCoderDiffPreviewStoreV1 = {
      v: 1,
      workspaceRoot,
      previewId: payload.previewId,
      title: payload.title,
      files: payload.files.map((file) => ({
        filePath: file.filePath,
        baselineContent: file.baselineContent ?? '',
        type: file.type,
      })),
      createdAt: Date.now(),
    };

    this.write(workspaceRoot, record);
  }

  load(workspaceRoot: string): AiCoderDiffPreviewStoreV1 | null {
    if (!workspaceRoot) {
      return null;
    }

    try {
      const fs = window['fs'];
      const path = this.storePath(workspaceRoot);
      if (!fs.existsSync(path)) {
        return null;
      }
      const raw = fs.readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AiCoderDiffPreviewStoreV1>;
      if (parsed.v !== 1 || !parsed.previewId || !Array.isArray(parsed.files)) {
        return null;
      }
      return parsed as AiCoderDiffPreviewStoreV1;
    } catch {
      return null;
    }
  }

  clear(workspaceRoot: string): void {
    if (!workspaceRoot) {
      return;
    }
    try {
      const fs = window['fs'];
      const path = this.storePath(workspaceRoot);
      if (fs.existsSync(path)) {
        fs.unlinkSync(path);
      }
    } catch {
      /* ignore */
    }
  }

  removeFile(workspaceRoot: string, filePath: string): AiCoderDiffPreviewStoreV1 | null {
    const record = this.load(workspaceRoot);
    if (!record) {
      return null;
    }

    const files = record.files.filter((file) => file.filePath !== filePath);
    if (files.length === 0) {
      this.clear(workspaceRoot);
      return null;
    }

    const next: AiCoderDiffPreviewStoreV1 = { ...record, files };
    this.write(workspaceRoot, next);
    return next;
  }

  toOpenPayload(record: AiCoderDiffPreviewStoreV1): AiEditDiffOpenPayload | null {
    const files: AiEditDiffFilePayload[] = [];

    for (const file of record.files) {
      const currentContent = this.readCurrentFileContent(file.filePath);
      const baselineContent = file.baselineContent ?? '';

      if (file.type === 'delete') {
        if (currentContent === '' && baselineContent === currentContent) {
          continue;
        }
      } else if (currentContent === baselineContent) {
        continue;
      }

      files.push({
        filePath: file.filePath,
        baselineContent,
        currentContent,
        type: file.type,
      });
    }

    if (files.length === 0) {
      this.clear(record.workspaceRoot);
      return null;
    }

    return {
      previewId: record.previewId,
      title: record.title,
      files,
    };
  }

  private write(workspaceRoot: string, record: AiCoderDiffPreviewStoreV1): void {
    try {
      const fs = window['fs'];
      const dir = window['path'].join(workspaceRoot, '.aily');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storePath(workspaceRoot), JSON.stringify(record, null, 2), 'utf-8');
    } catch {
      /* ignore */
    }
  }

  private readCurrentFileContent(filePath: string): string {
    try {
      const fs = window['fs'];
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch {
      /* ignore */
    }
    return '';
  }
}
