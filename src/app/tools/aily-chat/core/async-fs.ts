/**
 * 异步优先的文件系统操作辅助模块
 *
 * 所有方法优先使用 IFileSystem 上的 async 方法（通过 IPC 在主进程执行），
 * 当 async 方法不可用时自动回退到 sync 方法。
 * 用于工具代码从同步调用迁移到异步调用，避免阻塞渲染进程 UI。
 */

import { IFileSystem, IFileStat, IDirent } from './host-api';
import { AilyHost } from './host';

function fs(): IFileSystem {
  return AilyHost.get().fs;
}

export async function readFile(path: string, encoding?: string): Promise<string> {
  const f = fs();
  return f.readFile ? f.readFile(path, encoding) : f.readFileSync(path, encoding);
}

export async function writeFile(path: string, data: string, encoding?: string): Promise<void> {
  const f = fs();
  return f.writeFile ? f.writeFile(path, data, encoding) : f.writeFileSync(path, data, encoding);
}

export async function exists(path: string): Promise<boolean> {
  const f = fs();
  return f.exists ? f.exists(path) : f.existsSync(path);
}

export async function stat(path: string): Promise<IFileStat> {
  const f = fs();
  return f.stat ? f.stat(path) : f.statSync(path);
}

export async function readdir(path: string): Promise<string[]> {
  const f = fs();
  return f.readdir ? f.readdir(path) : f.readdirSync(path);
}

export async function readDir(path: string): Promise<IDirent[]> {
  const f = fs();
  if (f.readDir) return f.readDir(path);
  if (f.readDirSync) return f.readDirSync(path);
  // 最低兼容
  const names = f.readdirSync(path);
  return names.map(name => {
    const s = f.statSync(AilyHost.get().path.join(path, name));
    return { name, isDirectory: () => s.isDirectory(), isFile: () => s.isFile() };
  });
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  const f = fs();
  return f.mkdir ? f.mkdir(path, options) : f.mkdirSync(path, options);
}

export async function unlink(path: string): Promise<void> {
  const f = fs();
  return f.unlink ? f.unlink(path) : f.unlinkSync(path);
}
