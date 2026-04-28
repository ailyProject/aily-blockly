/**
 * clone_repository 工具 — 下载远程 Git 仓库（zip 方式）
 *
 * 通过 GitHub / Gitee 等平台的 zip 下载 API 获取整个仓库代码，
 * 解压到本地目标目录。无需本地安装 git。
 *
 * 参考 Copilot GithubRepoTool 的设计理念（远程仓库访问），
 * 但提供完整的本地文件落盘能力。
 */

import { ToolUseResult } from './tools';
import { AilyHost } from '../core/host';

// ============================
// 类型定义
// ============================

export interface CloneRepositoryArgs {
  /** 仓库 URL，支持 GitHub / Gitee */
  url: string;
  /** 分支名（默认 main/master） */
  branch?: string;
  /** 解压目标目录（默认为项目根目录下以仓库名命名的子目录） */
  target_dir?: string;
  /** 仅解压指定子目录（稀疏检出效果） */
  sparse_paths?: string[];
}

// ============================
// URL 白名单（安全限制）
// ============================

const ALLOWED_HOSTS = [
  'github.com',
  'gitee.com',
  'gitlab.com',
  'bitbucket.org',
];

// 最大 zip 大小 50MB
const MAX_ZIP_SIZE = 50 * 1024 * 1024;

// ============================
// URL 解析
// ============================

interface ParsedRepoUrl {
  host: string;
  owner: string;
  repo: string;
  /** 构造的 zip 下载链接 */
  zipUrl: string;
}

/**
 * 解析仓库 URL 为结构化信息，并构造 zip 下载链接
 */
function parseRepoUrl(url: string, branch: string): ParsedRepoUrl | null {
  // 清理 URL：去除末尾 .git 和斜杠
  let cleaned = url.trim().replace(/\.git\/?$/, '').replace(/\/$/, '');

  // 匹配 https://host/owner/repo 格式
  const match = cleaned.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)$/);
  if (!match) return null;

  const [, host, owner, repo] = match;

  if (!ALLOWED_HOSTS.includes(host.toLowerCase())) {
    return null;
  }

  let zipUrl: string;
  const hostLower = host.toLowerCase();

  if (hostLower === 'github.com') {
    zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  } else if (hostLower === 'gitee.com') {
    zipUrl = `https://gitee.com/${owner}/${repo}/repository/archive/${branch}.zip`;
  } else if (hostLower === 'gitlab.com') {
    zipUrl = `https://gitlab.com/${owner}/${repo}/-/archive/${branch}/${repo}-${branch}.zip`;
  } else if (hostLower === 'bitbucket.org') {
    zipUrl = `https://bitbucket.org/${owner}/${repo}/get/${branch}.zip`;
  } else {
    return null;
  }

  return { host: hostLower, owner, repo, zipUrl };
}

// ============================
// Zip 解压（纯 JS 实现，基于 ArrayBuffer）
// ============================

/**
 * 最小化 zip 解析器 — 仅支持 DEFLATE 和 STORE 方法
 * 在浏览器/Electron 中运行，不依赖 Node.js zlib
 *
 * Zip 文件格式：
 * [local file header + file data] × N + central directory + end of central directory
 */

interface ZipEntry {
  fileName: string;
  compressedData: Uint8Array;
  compressionMethod: number; // 0=STORE, 8=DEFLATE
  uncompressedSize: number;
}

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * 解析 zip ArrayBuffer，返回文件条目列表
 */
function parseZipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset < bytes.length - 4) {
    const sig = readUint32LE(view, offset);
    if (sig !== 0x04034b50) break; // 非 local file header

    const compressionMethod = readUint16LE(view, offset + 8);
    const compressedSize = readUint32LE(view, offset + 18);
    const uncompressedSize = readUint32LE(view, offset + 22);
    const fileNameLength = readUint16LE(view, offset + 26);
    const extraFieldLength = readUint16LE(view, offset + 28);

    const fileNameBytes = bytes.slice(offset + 30, offset + 30 + fileNameLength);
    const fileName = new TextDecoder('utf-8').decode(fileNameBytes);

    const dataOffset = offset + 30 + fileNameLength + extraFieldLength;
    const compressedData = bytes.slice(dataOffset, dataOffset + compressedSize);

    entries.push({
      fileName,
      compressedData: new Uint8Array(compressedData),
      compressionMethod,
      uncompressedSize,
    });

    offset = dataOffset + compressedSize;
  }

  return entries;
}

/**
 * 解压单个 DEFLATE 压缩的条目（使用 DecompressionStream Web API）
 */
async function inflateEntry(entry: ZipEntry): Promise<Uint8Array> {
  if (entry.compressionMethod === 0) {
    // STORE — 无压缩
    return entry.compressedData;
  }

  if (entry.compressionMethod === 8) {
    // DEFLATE — 使用 DecompressionStream (Web API, Chromium 80+)
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw' as CompressionFormat);
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();

      // 写入和读取并发执行，避免流缓冲区满时死锁
      const writePromise = (async () => {
        await writer.write(entry.compressedData);
        await writer.close();
      })();

      // 读取解压数据
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      // 合并
      await writePromise;
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const result = new Uint8Array(totalLength);
      let pos = 0;
      for (const chunk of chunks) {
        result.set(chunk, pos);
        pos += chunk.length;
      }
      return result;
    }

    // 降级：尝试 pako（如果全局可用）
    if (typeof (window as any).pako !== 'undefined') {
      return (window as any).pako.inflateRaw(entry.compressedData);
    }

    throw new Error('当前环境不支持 DEFLATE 解压（需要 DecompressionStream API 或 pako 库）');
  }

  throw new Error(`不支持的压缩方法: ${entry.compressionMethod}`);
}

// ============================
// 主处理函数
// ============================

export async function cloneRepositoryTool(args: CloneRepositoryArgs): Promise<ToolUseResult> {
  const { url, branch = 'main', target_dir, sparse_paths } = args;

  if (!url) {
    return { is_error: true, content: '参数错误：url 不能为空' };
  }

  // 1. 解析 URL
  const parsed = parseRepoUrl(url, branch);
  if (!parsed) {
    return {
      is_error: true,
      content: `无效或不支持的仓库 URL: "${url}"\n支持的平台: ${ALLOWED_HOSTS.join(', ')}\n格式: https://github.com/owner/repo`,
    };
  }

  const fs = AilyHost.get().fs;
  const pathUtil = AilyHost.get().path;
  const projectRoot = AilyHost.get().project.currentProjectPath;

  if (!projectRoot) {
    return { is_error: true, content: '无法确定项目目录，请先打开项目' };
  }

  // 2. 确定目标目录
  const targetBase = target_dir
    ? (pathUtil.isAbsolute(target_dir) ? target_dir : pathUtil.join(projectRoot, target_dir))
    : pathUtil.join(projectRoot, parsed.repo);

  // 3. 下载 zip
  let zipBuffer: ArrayBuffer;
  try {
    // 先尝试主分支，失败后尝试 master
    zipBuffer = await downloadZip(parsed.zipUrl);
  } catch (err: any) {
    if (branch === 'main') {
      // 回退到 master 分支
      const fallbackParsed = parseRepoUrl(url, 'master');
      if (fallbackParsed) {
        try {
          zipBuffer = await downloadZip(fallbackParsed.zipUrl);
        } catch {
          return {
            is_error: true,
            content: `下载仓库失败（已尝试 main 和 master 分支）: ${err.message}\nURL: ${parsed.zipUrl}`,
          };
        }
      } else {
        return { is_error: true, content: `下载仓库失败: ${err.message}` };
      }
    } else {
      return {
        is_error: true,
        content: `下载仓库失败（分支: ${branch}）: ${err.message}\nURL: ${parsed.zipUrl}`,
      };
    }
  }

  // 4. 校验大小
  if (zipBuffer.byteLength > MAX_ZIP_SIZE) {
    return {
      is_error: true,
      content: `仓库 zip 大小 (${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)}MB) 超过限制 (${MAX_ZIP_SIZE / 1024 / 1024}MB)`,
    };
  }

  // 5. 解析 zip
  let entries: ZipEntry[];
  try {
    entries = parseZipEntries(zipBuffer);
  } catch (err: any) {
    return { is_error: true, content: `解析 zip 文件失败: ${err.message}` };
  }

  if (entries.length === 0) {
    return { is_error: true, content: '下载的 zip 文件为空' };
  }

  // 6. GitHub zip 通常在根目录有一个以 "repo-branch/" 为前缀的目录
  //    需要剥离这个前缀
  const firstEntry = entries[0].fileName;
  const rootPrefix = firstEntry.includes('/') ? firstEntry.split('/')[0] + '/' : '';

  // 7. 解压写入文件系统
  let fileCount = 0;
  let dirCount = 0;
  const errors: string[] = [];

  // 创建目标根目录
  try {
    if (!fs.existsSync(targetBase)) {
      fs.mkdirSync(targetBase, { recursive: true });
    }
  } catch (err: any) {
    return { is_error: true, content: `创建目标目录失败: ${err.message}` };
  }

  for (const entry of entries) {
    let relativePath = entry.fileName;

    // 剥离 zip 根前缀
    if (rootPrefix && relativePath.startsWith(rootPrefix)) {
      relativePath = relativePath.substring(rootPrefix.length);
    }

    if (!relativePath) continue;

    // 稀疏过滤
    if (sparse_paths && sparse_paths.length > 0) {
      const matchesSparse = sparse_paths.some(sp => {
        const normalizedSp = sp.replace(/\\/g, '/').replace(/\/$/, '');
        return relativePath.startsWith(normalizedSp + '/') || relativePath === normalizedSp;
      });
      if (!matchesSparse) continue;
    }

    const targetPath = pathUtil.join(targetBase, relativePath);

    // ====== 路径安全检查：防止路径遍历攻击 ======
    const normalizedTarget = pathUtil.resolve(targetPath);
    const normalizedBase = pathUtil.resolve(targetBase);
    if (!normalizedTarget.startsWith(normalizedBase)) {
      errors.push(`跳过不安全路径: ${relativePath}`);
      continue;
    }

    if (relativePath.endsWith('/')) {
      // 目录
      try {
        if (!fs.existsSync(targetPath)) {
          fs.mkdirSync(targetPath, { recursive: true });
          dirCount++;
        }
      } catch (err: any) {
        errors.push(`创建目录失败 ${relativePath}: ${err.message}`);
      }
    } else {
      // 文件
      try {
        const dirPath = pathUtil.dirname(targetPath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          dirCount++;
        }

        const data = await inflateEntry(entry);

        // 尝试检测是否为文本文件
        const isBinary = isLikelyBinary(data, relativePath);
        if (isBinary) {
          fs.writeFileSync(targetPath, Buffer.from(data) as any);
        } else {
          const text = new TextDecoder('utf-8').decode(data);
          fs.writeFileSync(targetPath, text, 'utf-8');
        }
        fileCount++;
      } catch (err: any) {
        errors.push(`解压文件失败 ${relativePath}: ${err.message}`);
      }
    }
  }

  // 8. 构建结果
  const summary = [
    `## ✅ 仓库克隆完成`,
    ``,
    `- **仓库**: ${parsed.owner}/${parsed.repo}`,
    `- **分支**: ${branch}`,
    `- **目标目录**: ${targetBase}`,
    `- **文件数**: ${fileCount}`,
    `- **目录数**: ${dirCount}`,
  ];

  if (sparse_paths && sparse_paths.length > 0) {
    summary.push(`- **稀疏路径**: ${sparse_paths.join(', ')}`);
  }

  if (errors.length > 0) {
    summary.push(``);
    summary.push(`### ⚠️ 部分错误 (${errors.length})`);
    summary.push(...errors.slice(0, 10).map(e => `- ${e}`));
    if (errors.length > 10) {
      summary.push(`- ...及其他 ${errors.length - 10} 个错误`);
    }
  }

  return {
    is_error: false,
    content: summary.join('\n'),
    metadata: {
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      targetDir: targetBase,
      fileCount,
      dirCount,
      errorCount: errors.length,
    },
  };
}

// ============================
// HTTP 下载（基于 XMLHttpRequest，浏览器/Electron 兼容）
// ============================

function downloadZip(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 120_000; // 2 分钟超时

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as ArrayBuffer);
      } else if (xhr.status === 404) {
        reject(new Error(`仓库或分支不存在 (HTTP 404)`));
      } else {
        reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error('网络请求失败'));
    xhr.ontimeout = () => reject(new Error('下载超时（120秒）'));
    xhr.send();
  });
}

// ============================
// 辅助函数
// ============================

/**
 * 简单的二进制文件检测
 */
function isLikelyBinary(data: Uint8Array, fileName: string): boolean {
  const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.mp3', '.mp4', '.avi', '.mkv', '.wav', '.ogg',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
  ]);

  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : '';
  if (BINARY_EXTENSIONS.has(ext)) return true;

  // 检查前 512 字节是否有 null 字符
  const checkLen = Math.min(data.length, 512);
  for (let i = 0; i < checkLen; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}
