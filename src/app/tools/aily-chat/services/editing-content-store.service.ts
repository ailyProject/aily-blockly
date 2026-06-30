import { AilyHost } from '../core/host';
import type { ContentRef } from './editing-timeline.types';

export interface EditingContentStoreOptions {
  joinPath: (...parts: string[]) => string;
  contentRootDirName?: string;
}

export class EditingContentStore {
  private readonly contentRootDirName: string;

  constructor(private readonly options: EditingContentStoreOptions) {
    this.contentRootDirName = options.contentRootDirName ?? '.aily/chat-editing';
  }

  putText(workspaceRoot: string, sessionId: string, content: string): ContentRef {
    const hash = hashText(content);
    const ref: ContentRef = {
      hash,
      encoding: 'utf8',
      byteLength: content.length,
    };
    this.writeRef(workspaceRoot, sessionId, ref, content, 'utf-8');
    return ref;
  }

  putBinary(workspaceRoot: string, sessionId: string, content: Uint8Array): ContentRef {
    const bytes = normalizeBytes(content);
    const ref: ContentRef = {
      hash: hashBytes(bytes),
      encoding: 'base64',
      byteLength: bytes.byteLength,
    };
    this.writeRef(workspaceRoot, sessionId, ref, bytes);
    return ref;
  }

  getText(workspaceRoot: string, sessionId: string, ref: ContentRef): string {
    return AilyHost.get().fs.readFileSync(this.getContentPath(workspaceRoot, sessionId, ref), 'utf-8');
  }

  getBinary(workspaceRoot: string, sessionId: string, ref: ContentRef): Uint8Array {
    const raw = AilyHost.get().fs.readFileSync(this.getContentPath(workspaceRoot, sessionId, ref));
    return normalizeBytes(raw);
  }

  has(workspaceRoot: string, sessionId: string, ref: ContentRef): boolean {
    return this.fileExists(this.getContentPath(workspaceRoot, sessionId, ref));
  }

  private getContentDir(workspaceRoot: string, sessionId: string): string {
    return this.options.joinPath(workspaceRoot, this.contentRootDirName, sessionId, 'contents');
  }

  private getContentPath(workspaceRoot: string, sessionId: string, ref: ContentRef): string {
    return this.options.joinPath(this.getContentDir(workspaceRoot, sessionId), ref.hash.slice(0, 2), `${ref.hash}.blob`);
  }

  private writeRef(
    workspaceRoot: string,
    sessionId: string,
    ref: ContentRef,
    content: string | Uint8Array,
    encoding?: BufferEncoding | 'utf-8',
  ): void {
    const path = this.getContentPath(workspaceRoot, sessionId, ref);
    const dir = this.options.joinPath(this.getContentDir(workspaceRoot, sessionId), ref.hash.slice(0, 2));
    this.ensureDir(dir);
    if (!this.fileExists(path)) {
      if (typeof content === 'string') {
        AilyHost.get().fs.writeFileSync(path, content, encoding ?? 'utf-8');
      } else {
        (AilyHost.get().fs.writeFileSync as any)(path, content);
      }
    }
  }

  private ensureDir(path: string): void {
    if (!this.fileExists(path)) {
      AilyHost.get().fs.mkdirSync(path, { recursive: true });
    }
  }

  private fileExists(path: string): boolean {
    try {
      return AilyHost.get().fs.existsSync(path);
    } catch {
      return false;
    }
  }
}

function hashText(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashBytes(content: Uint8Array): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) {
    hash ^= content[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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
