import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { injectTodoReminder } from './todoWriteTool';

// ===== URL 分类常量 =====
const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm',
  '.iso', '.img', '.bin', '.dll', '.so', '.dylib',
  '.whl', '.jar', '.war', '.ear', '.apk', '.ipa', '.tgz',
]);

const MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv',
  '.wav', '.ogg', '.webm', '.flac', '.aac', '.wma', '.m4a', '.m4v', '.3gp',
]);

const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.epub',
]);

/** 允许的文本类 Content-Type */
const ALLOWED_CONTENT_TYPES = [
  'text/', 'application/json', 'application/xml', 'application/xhtml',
  'application/javascript', 'application/typescript', 'application/yaml',
  'application/x-yaml', 'application/toml', 'application/ld+json',
  'application/rss+xml', 'application/atom+xml', 'application/svg+xml',
];

/** 最终返回给 LLM 的内容长度上限（约 10k tokens） */
const MAX_CONTENT_LENGTH_FOR_LLM = 30000;

/** 请求前 Content-Length 大小上限（5MB） */
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;

// ===== 响应缓存（15 分钟 TTL） =====
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  content: string;
  metadata: any;
  timestamp: number;
}

const fetchCache = new Map<string, CacheEntry>();

function getCachedResponse(url: string, method: string): CacheEntry | null {
  const key = `${method}:${url}`;
  const entry = fetchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    fetchCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedResponse(url: string, method: string, content: string, metadata: any): void {
  const key = `${method}:${url}`;
  fetchCache.set(key, { content, metadata, timestamp: Date.now() });
  if (fetchCache.size > 50) {
    const now = Date.now();
    for (const [k, v] of fetchCache.entries()) {
      if (now - v.timestamp > CACHE_TTL_MS) fetchCache.delete(k);
    }
  }
}

export interface FetchToolArgs {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: { [key: string]: string };
  body?: any;
  timeout?: number | string;
  maxSize?: number | string; // 最大文件大小（字节）
  responseType?: 'text' | 'json' | 'blob' | 'arraybuffer';
}

export interface FetchToolResult {
  content: string;
  is_error: boolean;
  metadata?: {
    status: number;
    statusText: string;
    headers: { [key: string]: string };
    size: number;
    contentType?: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class FetchToolService {
  constructor(private http: HttpClient) {}

  async executeFetch(args: FetchToolArgs): Promise<FetchToolResult> {
    try {
      let {
        url,
        method = 'GET',
        headers = {},
        body,
        timeout: timeoutMs = 30000,
        maxSize = DEFAULT_MAX_SIZE, // 默认5MB
        responseType = 'text'
      } = args;

      // 确保超时值是数字类型
      const timeoutNumber = typeof timeoutMs === 'string' ? parseInt(timeoutMs, 10) : timeoutMs;
      const maxSizeNumber = typeof maxSize === 'string' ? parseInt(maxSize, 10) : maxSize;

      // 1. 验证 URL
      if (!url || !this.isValidUrl(url)) {
        return { content: '无效的URL地址，仅支持 http:// 和 https:// 协议', is_error: true };
      }

      // 2. URL 智能分类检测（阻止二进制/媒体/文档/Git仓库克隆地址的直接下载）
      const urlCheck = this.classifyUrl(url);
      if (urlCheck.blocked) {
        return { content: urlCheck.message!, is_error: true };
      }

      // 3. GitHub 仓库 URL 智能降级 → 获取仓库信息 + README
      if (urlCheck.isGitHubRepo && method === 'GET') {
        return await this.fetchGitHubRepoInfo(urlCheck.owner!, urlCheck.repo!, timeoutNumber, headers);
      }

      // 4. 检查缓存（仅 GET 请求）
      if (method === 'GET') {
        const cached = getCachedResponse(url, method);
        if (cached) {
          return { content: cached.content, is_error: false, metadata: { ...cached.metadata, fromCache: true } };
        }
      }

      // 5. 解析 headers
      if (headers && typeof headers === 'string') {
        try { headers = JSON.parse(headers); } catch { headers = {}; }
      }

      // 6. HEAD 预检（仅 GET 请求，检查 Content-Type 和 Content-Length）
      if (method === 'GET') {
        const preCheckResult = await this.headPreCheck(url, headers, maxSizeNumber, timeoutNumber);
        if (preCheckResult) return preCheckResult;
      }

      // 7. 设置请求头
      const httpHeaders = new HttpHeaders(headers);
      const response = await this.executeRequest(method, url, httpHeaders, body, responseType, timeoutNumber);

      // 8. 检查响应大小
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader && parseInt(contentLengthHeader) > maxSizeNumber) {
        return {
          content: `资源大小 (${this.formatFileSize(parseInt(contentLengthHeader))}) 超过限制 (${this.formatFileSize(maxSizeNumber)})。请提供更具体的资源地址或使用 web_search 工具搜索相关信息。`,
          is_error: true
        };
      }

      // 9. 提取响应内容
      const extracted = await this.extractContent(response, responseType, maxSizeNumber);
      if (extracted.error) {
        return { content: extracted.error, is_error: true };
      }
      let content = extracted.content!;

      // 10. HTML → Markdown 转换（去除 script/style/nav 等无用标签，转为干净文本）
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html') && responseType === 'text') {
        content = this.htmlToMarkdown(content);
      }

      // 11. 内容截断（保护 LLM 上下文窗口）
      content = this.truncateContent(content, MAX_CONTENT_LENGTH_FOR_LLM);

      // 12. 构建响应头
      const responseHeaders: { [key: string]: string } = {};
      response.headers.keys().forEach(key => {
        responseHeaders[key] = response.headers.get(key) || '';
      });

      const result: FetchToolResult = {
        content: content || '',
        is_error: false,
        metadata: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          size: content?.length || 0,
          contentType: contentType || undefined
        }
      };

      // 13. 缓存 GET 请求结果
      if (method === 'GET') {
        setCachedResponse(url, method, result.content, result.metadata);
      }

      return result;

    } catch (error: any) {
      console.warn('Fetch工具执行失败:', error);
      
      let errorMessage = '网络请求失败';
      if (error.status === 0) {
        errorMessage = '网络连接失败，请检查网络连接或CORS配置';
      } else if (error.status === 404) {
        errorMessage = '请求的资源不存在 (404)';
      } else if (error.status === 403) {
        errorMessage = '访问被拒绝 (403)';
      } else if (error.status === 429) {
        errorMessage = '请求过于频繁，请稍后再试 (429)';
      } else if (error.status === 500) {
        errorMessage = '服务器内部错误 (500)';
      } else if (error.name === 'TimeoutError') {
        errorMessage = '请求超时';
      } else if (error.message) {
        errorMessage = error.message;
      }

      return {
        content: errorMessage,
        is_error: true,
        metadata: error.status ? {
          status: error.status,
          statusText: error.statusText || '',
          headers: {},
          size: 0
        } : undefined
      };
    }
  }

  // ===== URL 分析方法 =====

  /** 分类 URL，检测是否为不可处理的资源类型 */
  private classifyUrl(url: string): {
    blocked: boolean;
    message?: string;
    isGitHubRepo?: boolean;
    owner?: string;
    repo?: string;
  } {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      const hostname = urlObj.hostname.toLowerCase();

      // 检测 .git 克隆地址
      if (pathname.endsWith('.git')) {
        return {
          blocked: true,
          message: '检测到 Git 仓库克隆地址，无法直接获取仓库内容。请提供具体的文件 URL，或使用 web_search 工具搜索该项目的相关信息。'
        };
      }

      // 检测文件扩展名
      const ext = this.getFileExtension(pathname);
      if (ext && BINARY_EXTENSIONS.has(ext)) {
        return {
          blocked: true,
          message: `检测到二进制文件 (${ext})，无法作为文本内容处理。如需了解该文件相关信息，请使用 web_search 工具搜索。`
        };
      }
      if (ext && MEDIA_EXTENSIONS.has(ext)) {
        return {
          blocked: true,
          message: `检测到媒体文件 (${ext})，不适合作为文本上下文。`
        };
      }
      if (ext && DOCUMENT_EXTENSIONS.has(ext)) {
        return {
          blocked: true,
          message: `检测到文档文件 (${ext})，此类文件无法直接获取文本内容。请使用 web_search 工具搜索相关内容。`
        };
      }

      // 检测 GitHub 仓库首页 URL（非指向具体文件）
      if (hostname === 'github.com') {
        const match = pathname.match(/^\/([^\/]+)\/([^\/]+)\/?$/);
        if (match) {
          return {
            blocked: false,
            isGitHubRepo: true,
            owner: match[1],
            repo: match[2].replace(/\.git$/, '')
          };
        }
      }

      return { blocked: false };
    } catch {
      return { blocked: false };
    }
  }

  /** 获取文件扩展名（包含点号，支持 .tar.gz 等复合扩展名） */
  private getFileExtension(pathname: string): string | null {
    if (pathname.endsWith('.tar.gz')) return '.tar.gz';
    if (pathname.endsWith('.tar.bz2')) return '.tar.bz2';
    if (pathname.endsWith('.tar.xz')) return '.tar.xz';
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1 || lastDot === pathname.length - 1) return null;
    return pathname.substring(lastDot);
  }

  // ===== GitHub 仓库智能处理 =====

  /** 对 GitHub 仓库 URL，自动获取仓库信息 + README */
  private async fetchGitHubRepoInfo(
    owner: string, repo: string, timeoutMs: number, headers: any
  ): Promise<FetchToolResult> {
    try {
      let repoInfo = '';
      let readmeContent = '';
      const apiHeaders = new HttpHeaders({ 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AilyBlockly/1.0' });

      // 获取仓库基本信息
      try {
        const repoData = await firstValueFrom(
          this.http.get<any>(`https://api.github.com/repos/${owner}/${repo}`, { headers: apiHeaders }).pipe(timeout(timeoutMs))
        );
        repoInfo = [
          `# ${repoData.full_name}`,
          repoData.description ? `\n${repoData.description}` : '',
          `\n**语言:** ${repoData.language || '未知'}`,
          `**Stars:** ${repoData.stargazers_count} | **Forks:** ${repoData.forks_count}`,
          `**开源协议:** ${repoData.license?.spdx_id || '未知'}`,
          `**最后更新:** ${repoData.updated_at}`,
          `**默认分支:** ${repoData.default_branch}`,
          `**主页:** ${repoData.homepage || '无'}`,
          `**仓库地址:** ${repoData.html_url}`,
        ].join('\n');
      } catch {
        repoInfo = `# ${owner}/${repo}\n\n（GitHub API 仓库详情获取失败）`;
      }

      // 获取 README
      const readmeHeaders = new HttpHeaders({ 'User-Agent': 'AilyBlockly/1.0' });
      try {
        readmeContent = await firstValueFrom(
          this.http.get(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`, { responseType: 'text', headers: readmeHeaders }).pipe(timeout(timeoutMs))
        );
      } catch {
        try {
          readmeContent = await firstValueFrom(
            this.http.get(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/readme.md`, { responseType: 'text', headers: readmeHeaders }).pipe(timeout(timeoutMs))
          );
        } catch {
          readmeContent = '（README 文件获取失败）';
        }
      }

      const content = this.truncateContent(`${repoInfo}\n\n---\n\n## README\n\n${readmeContent}`, MAX_CONTENT_LENGTH_FOR_LLM);

      return {
        content,
        is_error: false,
        metadata: { status: 200, statusText: 'OK (GitHub API)', headers: {}, size: content.length, contentType: 'text/markdown' }
      };
    } catch (error: any) {
      return { content: `无法获取 GitHub 仓库信息 (${owner}/${repo}): ${error.message || '未知错误'}`, is_error: true };
    }
  }

  // ===== HEAD 预检 =====

  /** 发送 HEAD 请求预检 Content-Type 和 Content-Length */
  private async headPreCheck(
    url: string, headers: any, maxSize: number, timeoutMs: number
  ): Promise<FetchToolResult | null> {
    try {
      const httpHeaders = new HttpHeaders(headers || {});
      const headResponse = await firstValueFrom(
        this.http.request('HEAD', url, { headers: httpHeaders, observe: 'response', responseType: 'text' })
          .pipe(timeout(Math.min(timeoutMs, 10000)))
      );

      const contentType = headResponse.headers.get('content-type') || '';
      if (contentType && !this.isTextContentType(contentType)) {
        return {
          content: `该 URL 返回的内容类型为 "${contentType}"，不是文本类型，无法作为上下文提供给 AI。请使用 web_search 工具搜索相关信息。`,
          is_error: true
        };
      }

      const cl = headResponse.headers.get('content-length');
      if (cl && parseInt(cl) > maxSize) {
        return {
          content: `该资源大小为 ${this.formatFileSize(parseInt(cl))}，超过 ${this.formatFileSize(maxSize)} 限制。请提供更精确的 URL 或使用 web_search 工具获取摘要信息。`,
          is_error: true
        };
      }

      return null; // 预检通过
    } catch {
      return null; // HEAD 请求失败不阻止后续 GET
    }
  }

  /** 判断 Content-Type 是否为可处理的文本类型 */
  private isTextContentType(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ALLOWED_CONTENT_TYPES.some(allowed => ct.includes(allowed));
  }

  // ===== 统一请求方法 =====

  /** 统一请求入口（替代原 8 分支） */
  private async executeRequest(
    method: string, url: string, headers: HttpHeaders,
    body: any, responseType: string, timeoutMs: number
  ): Promise<HttpResponse<any>> {
    const options: any = { headers, observe: 'response', responseType };
    if (method !== 'GET' && body !== undefined) {
      options.body = body;
    }
    return firstValueFrom(
      this.http.request(method, url, options).pipe(timeout(timeoutMs))
    ) as Promise<HttpResponse<any>>;
  }

  /** 从 HttpResponse 中提取内容字符串 */
  private async extractContent(
    response: HttpResponse<any>, responseType: string, maxSize: number
  ): Promise<{ content?: string; error?: string }> {
    const body = response.body;
    if (responseType === 'json') {
      const content = JSON.stringify(body, null, 2);
      if (content && content.length > maxSize) return { error: `JSON 响应大小 (${this.formatFileSize(content.length)}) 超过限制` };
      return { content };
    }
    if (responseType === 'blob') {
      const blob = body as Blob;
      if (blob.size > maxSize) return { error: `文件大小 (${this.formatFileSize(blob.size)}) 超过限制` };
      return { content: await this.blobToText(blob) };
    }
    if (responseType === 'arraybuffer') {
      const buffer = body as ArrayBuffer;
      if (buffer.byteLength > maxSize) return { error: `文件大小 (${this.formatFileSize(buffer.byteLength)}) 超过限制` };
      return { content: this.arrayBufferToString(buffer) };
    }
    const content = body as string;
    if (content && content.length > maxSize) return { error: `响应内容大小 (${this.formatFileSize(content.length)}) 超过限制` };
    return { content: content || '' };
  }

  // ===== HTML → Markdown 转换 =====

  /** 将 HTML 转换为干净的 Markdown 文本（去除导航、脚本、样式等） */
  private htmlToMarkdown(html: string): string {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // 移除无用元素
      const removeSelectors = [
        'script', 'style', 'noscript', 'iframe', 'nav', 'footer',
        'aside', 'header', '.sidebar', '.menu', '.navigation',
        '.ad', '.advertisement', '.cookie-banner',
        '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
      ];
      for (const selector of removeSelectors) {
        try { doc.querySelectorAll(selector).forEach(el => el.remove()); } catch {}
      }

      // 优先获取主要内容区域
      const mainContent = doc.querySelector('main') || doc.querySelector('article') || doc.body;
      if (!mainContent) return this.fallbackHtmlClean(html);

      return this.domToMarkdown(mainContent)
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+$/gm, '')
        .trim();
    } catch {
      return this.fallbackHtmlClean(html);
    }
  }

  /** DOM 节点递归转 Markdown */
  private domToMarkdown(element: Element | Node, depth: number = 0): string {
    if (depth > 20) return ''; // 防止无限递归
    let result = '';

    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.replace(/\s+/g, ' ') || '';
        if (text.trim()) result += text;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        switch (tag) {
          case 'h1': result += `\n\n# ${el.textContent?.trim() || ''}\n\n`; break;
          case 'h2': result += `\n\n## ${el.textContent?.trim() || ''}\n\n`; break;
          case 'h3': result += `\n\n### ${el.textContent?.trim() || ''}\n\n`; break;
          case 'h4': result += `\n\n#### ${el.textContent?.trim() || ''}\n\n`; break;
          case 'h5': result += `\n\n##### ${el.textContent?.trim() || ''}\n\n`; break;
          case 'h6': result += `\n\n###### ${el.textContent?.trim() || ''}\n\n`; break;
          case 'p': result += `\n\n${this.domToMarkdown(el, depth + 1)}\n\n`; break;
          case 'div': result += `\n${this.domToMarkdown(el, depth + 1)}\n`; break;
          case 'span': result += this.domToMarkdown(el, depth + 1); break;
          case 'br': result += '\n'; break;
          case 'hr': result += '\n\n---\n\n'; break;
          case 'strong': case 'b': result += `**${el.textContent?.trim() || ''}**`; break;
          case 'em': case 'i': result += `_${el.textContent?.trim() || ''}_`; break;
          case 'code':
            if (el.parentElement?.tagName.toLowerCase() !== 'pre') {
              result += `\`${el.textContent?.trim() || ''}\``;
            } else {
              result += el.textContent || '';
            }
            break;
          case 'pre': result += `\n\n\`\`\`\n${el.textContent?.trim() || ''}\n\`\`\`\n\n`; break;
          case 'a': {
            const href = el.getAttribute('href');
            const aText = el.textContent?.trim();
            if (href && aText && !href.startsWith('javascript:') && !href.startsWith('#')) {
              result += `[${aText}](${href})`;
            } else if (aText) {
              result += aText;
            }
            break;
          }
          case 'img': {
            const alt = el.getAttribute('alt') || '';
            if (alt) result += `[图片: ${alt}]`;
            break;
          }
          case 'ul': {
            result += '\n';
            el.querySelectorAll(':scope > li').forEach(li => {
              result += `- ${li.textContent?.trim() || ''}\n`;
            });
            result += '\n';
            break;
          }
          case 'ol': {
            result += '\n';
            el.querySelectorAll(':scope > li').forEach((li, idx) => {
              result += `${idx + 1}. ${li.textContent?.trim() || ''}\n`;
            });
            result += '\n';
            break;
          }
          case 'table': {
            const rows = el.querySelectorAll('tr');
            rows.forEach((row, rowIdx) => {
              const cells = row.querySelectorAll('th, td');
              const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');
              result += `| ${cellTexts.join(' | ')} |\n`;
              if (rowIdx === 0 && row.querySelector('th')) {
                result += `| ${cellTexts.map(() => '---').join(' | ')} |\n`;
              }
            });
            result += '\n';
            break;
          }
          case 'blockquote': {
            const bqText = this.domToMarkdown(el, depth + 1).trim();
            if (bqText) {
              result += '\n' + bqText.split('\n').map((line: string) => `> ${line}`).join('\n') + '\n\n';
            }
            break;
          }
          default:
            result += this.domToMarkdown(el, depth + 1);
        }
      }
    }
    return result;
  }

  /** HTML 回退清理（当 DOMParser 失败时） */
  private fallbackHtmlClean(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ===== 内容截断 =====

  /** 智能截断内容，尽量在自然边界截断 */
  private truncateContent(content: string, maxLength: number): string {
    if (!content || content.length <= maxLength) return content;
    const truncated = content.substring(0, maxLength);
    const lastParagraph = truncated.lastIndexOf('\n\n');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastParagraph > maxLength * 0.8 ? lastParagraph
      : lastNewline > maxLength * 0.9 ? lastNewline
      : maxLength;
    return content.substring(0, cutPoint) +
      `\n\n[内容已截断，原始大小约 ${this.formatFileSize(content.length)}，已保留前 ${this.formatFileSize(cutPoint)}]`;
  }

  // ===== 工具方法 =====

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return url.startsWith('http://') || url.startsWith('https://');
    } catch {
      return false;
    }
  }

  private async blobToText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(blob);
    });
  }

  private arrayBufferToString(buffer: ArrayBuffer): string {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export async function fetchTool(fetchService: FetchToolService, args: FetchToolArgs): Promise<FetchToolResult> {
  const toolResult = await fetchService.executeFetch(args);
  return injectTodoReminder(toolResult, 'fetchTool');
}
