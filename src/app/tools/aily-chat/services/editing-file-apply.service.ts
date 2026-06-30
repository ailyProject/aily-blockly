import { AilyHost } from '../core/host';
import { EditingContentStore } from './editing-content-store.service';
import type { EditingFileApplyResult, RestorePlan } from './editing-timeline.types';

type AppliedFileSnapshot = {
  uri: string;
  existed: boolean;
  contentKind: 'text' | 'binary' | 'raw';
  content: string | Uint8Array | unknown | null;
};

export class EditingFileApplyService {
  constructor(
    private readonly contentStore: EditingContentStore,
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
  ) {}

  async apply(plan: RestorePlan): Promise<EditingFileApplyResult> {
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    let appliedFiles = 0;
    const errors: string[] = [];
    const appliedSnapshots: AppliedFileSnapshot[] = [];

    for (const file of plan.files) {
      try {
        const currentExists = fs.existsSync(file.uri);
        if (!file.exists) {
          if (currentExists) {
            appliedSnapshots.push(this.captureCurrentState(file.uri, 'raw'));
            fs.unlinkSync(file.uri);
            appliedFiles++;
          }
          continue;
        }

        const dirPath = pathUtil.dirname(file.uri);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }

        if (file.contentKind === 'binary') {
          const targetBytes = file.contentRef
            ? this.contentStore.getBinary(this.workspaceRoot, this.sessionId, file.contentRef)
            : new Uint8Array();
          const currentBytes = currentExists ? normalizeBytes(fs.readFileSync(file.uri)) : null;
          if (currentBytes && areBytesEqual(currentBytes, targetBytes)) {
            continue;
          }
          appliedSnapshots.push(this.captureCurrentState(file.uri, 'binary'));
          (fs.writeFileSync as any)(file.uri, targetBytes);
          appliedFiles++;
          continue;
        }

        const targetContent = file.contentRef
          ? this.contentStore.getText(this.workspaceRoot, this.sessionId, file.contentRef)
          : '';
        const currentContent = currentExists ? fs.readFileSync(file.uri, 'utf-8') : null;
        if (currentExists && currentContent === targetContent) {
          continue;
        }
        appliedSnapshots.push(this.captureCurrentState(file.uri, 'text'));
        fs.writeFileSync(file.uri, targetContent, 'utf-8');
        appliedFiles++;
      } catch (error: any) {
        errors.push(`恢复 ${file.uri} 失败: ${error?.message || String(error)}`);
        break;
      }
    }

    if (errors.length === 0) {
      return { appliedFiles, errors };
    }

    const rollbackErrors = this.rollbackAppliedSnapshots(appliedSnapshots);

    return {
      appliedFiles: rollbackErrors.length === 0 ? 0 : appliedFiles,
      errors,
      rolledBackOnError: rollbackErrors.length === 0,
      ...(rollbackErrors.length > 0 ? { rollbackErrors } : {}),
    };
  }

  private captureCurrentState(filePath: string, contentKind: 'text' | 'binary' | 'raw'): AppliedFileSnapshot {
    const fs = AilyHost.get().fs;
    const exists = fs.existsSync(filePath);
    if (!exists) {
      return {
        uri: filePath,
        existed: false,
        contentKind,
        content: null,
      };
    }

    return {
      uri: filePath,
      existed: true,
      contentKind,
      content: contentKind === 'binary'
        ? normalizeBytes(fs.readFileSync(filePath))
        : contentKind === 'text'
          ? fs.readFileSync(filePath, 'utf-8')
          : fs.readFileSync(filePath),
    };
  }

  private rollbackAppliedSnapshots(snapshots: readonly AppliedFileSnapshot[]): string[] {
    if (snapshots.length === 0) {
      return [];
    }

    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;
    const rollbackErrors: string[] = [];

    for (const snapshot of [...snapshots].reverse()) {
      try {
        if (!snapshot.existed) {
          if (fs.existsSync(snapshot.uri)) {
            fs.unlinkSync(snapshot.uri);
          }
          continue;
        }

        const dirPath = pathUtil.dirname(snapshot.uri);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }

        if (snapshot.contentKind === 'binary') {
          (fs.writeFileSync as any)(snapshot.uri, snapshot.content ?? new Uint8Array());
          continue;
        }

        if (snapshot.contentKind === 'raw') {
          (fs.writeFileSync as any)(snapshot.uri, snapshot.content ?? '');
          continue;
        }

        fs.writeFileSync(snapshot.uri, (snapshot.content as string) ?? '', 'utf-8');
      } catch (error: any) {
        rollbackErrors.push(`回滚 ${snapshot.uri} 失败: ${error?.message || String(error)}`);
      }
    }

    return rollbackErrors;
  }
}

function normalizeBytes(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (Array.isArray(content)) {
    return new Uint8Array(content);
  }
  if (content && typeof content === 'object' && 'buffer' in (content as any)) {
    const view = content as { buffer: ArrayBufferLike; byteOffset?: number; byteLength?: number };
    return new Uint8Array(view.buffer, view.byteOffset ?? 0, view.byteLength ?? 0);
  }
  return new Uint8Array();
}

function areBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
