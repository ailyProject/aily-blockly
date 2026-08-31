import { ProjectDataError } from './project-data.types';

export interface ProjectDataFileStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly mtimeMs: number;
}

export interface ProjectDataFileSystem {
  join(...parts: string[]): string;
  dirname(path: string): string;
  resolve(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<ProjectDataFileStat>;
}

export function createElectronProjectDataFileSystem(): ProjectDataFileSystem {
  const fsApi = (globalThis as any).window?.['fs'];
  const pathApi = (globalThis as any).window?.['path'];
  if (!fsApi || !pathApi) {
    throw new ProjectDataError('not-configured', 'Electron file system bridge is unavailable.');
  }

  return {
    join: (...parts) => pathApi.join(...parts),
    dirname: (path) => pathApi.dirname(path),
    resolve: (path) => pathApi.resolve(path),
    relative: (from, to) => pathApi.relative(from, to),
    isAbsolute: (path) => Boolean(pathApi.isAbsolute(path)),
    async exists(path) {
      if (typeof fsApi.exists === 'function') return Boolean(await fsApi.exists(path));
      return Boolean(fsApi.existsSync(path));
    },
    async mkdir(path) {
      if (typeof fsApi.mkdir === 'function') {
        await fsApi.mkdir(path, { recursive: true });
      } else {
        fsApi.mkdirSync(path, { recursive: true });
      }
    },
    async readBinary(path) {
      const value = typeof fsApi.readFileBufferAsync === 'function'
        ? await fsApi.readFileBufferAsync(path)
        : fsApi.readFileBuffer(path);
      return toUint8Array(value);
    },
    async writeBinary(path, bytes) {
      if (typeof fsApi.writeFileBufferAsync === 'function') {
        await fsApi.writeFileBufferAsync(path, toArrayBuffer(bytes));
      } else {
        fsApi.writeFileBuffer(path, toArrayBuffer(bytes));
      }
    },
    async rename(from, to) {
      if (typeof fsApi.rename === 'function') {
        await fsApi.rename(from, to);
      } else {
        fsApi.renameSync(from, to);
      }
    },
    async unlink(path) {
      if (typeof fsApi.unlink === 'function') {
        await fsApi.unlink(path);
      } else {
        fsApi.unlinkSync(path);
      }
    },
    async readdir(path) {
      if (typeof fsApi.readdir === 'function') {
        const entries = await fsApi.readdir(path);
        return Array.isArray(entries) ? entries.map(String) : [];
      }
      return fsApi.readdirSync(path).map(String);
    },
    async stat(path) {
      const raw = typeof fsApi.lstat === 'function'
        ? await fsApi.lstat(path)
        : (typeof fsApi.lstatSync === 'function' ? fsApi.lstatSync(path) : fsApi.statSync(path));
      const isFile = typeof raw?.isFile === 'function' ? raw.isFile() : Boolean(raw?._isFile);
      const isDirectory = typeof raw?.isDirectory === 'function' ? raw.isDirectory() : Boolean(raw?._isDirectory);
      const isSymbolicLink = typeof raw?.isSymbolicLink === 'function'
        ? raw.isSymbolicLink()
        : Boolean(raw?._isSymbolicLink);
      return {
        size: Number(raw?.size || 0),
        isFile,
        isDirectory,
        isSymbolicLink,
        mtimeMs: Number(raw?.mtimeMs || (raw?.mtime ? new Date(raw.mtime).getTime() : 0)),
      };
    },
  };
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  const bufferLike = value as { type?: string; data?: unknown };
  if (bufferLike?.type === 'Buffer' && Array.isArray(bufferLike.data)) {
    return new Uint8Array(bufferLike.data);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new ProjectDataError('io-error', 'File system returned an unsupported binary value.');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
