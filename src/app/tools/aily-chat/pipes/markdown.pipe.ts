import {
  Pipe,
  PipeTransform
} from '@angular/core';
import { Marked, Renderer } from 'marked';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { markedHighlight } from 'marked-highlight';
import { codeToHtml } from 'shiki';
import { Observable, from, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/**
 * 扩展的 Markdown 管道，支持动态 Angular 组件渲染
 * 
 * 此管道将在检测到特殊的 Aily 代码块时，生成带有特殊标记的 HTML，
 * 然后通过指令系统将这些标记替换为真正的 Angular 组件
 */
@Pipe({
  name: 'markdown',
  standalone: true,
})
export class MarkdownPipe implements PipeTransform {
  private marked: Marked;
  private static componentCounter = 0;
  constructor(
    private sanitizer: DomSanitizer
  ) {
    this.marked = new Marked(
      markedHighlight({
        async: true,
        langPrefix: 'hljs language-',
        highlight: async (code: string, lang: string) => {
          try {
            // 检查是否为特殊的 Aily 代码块类型
            if (this.isAilyCodeBlock(lang)) {
              return this.renderAilyCodeBlockWithComponent(code, lang as any);
            }

            // 检查是否为 Mermaid 图表 - 改为 aily-mermaid 类型
            if (lang?.toLowerCase() === 'mermaid') {
              return this.renderAilyCodeBlockWithComponent(code, 'aily-mermaid');
            }

            // 处理语言别名
            const langMap: { [key: string]: string } = {
              'cpp': 'cpp',
              'c++': 'cpp',
              'c': 'c',
              'arduino': 'cpp',
              'ino': 'cpp'
            };

            const normalizedLang = langMap[lang?.toLowerCase()] || lang || 'text';

            const html = await codeToHtml(code, {
              lang: normalizedLang,
              theme: 'github-dark'
            });
            return html;
          } catch (error) {
            console.warn('Code highlighting failed for language:', lang, error);
            // 返回基本的代码块格式
            return `<pre class="shiki"><code>${code}</code></pre>`;
          }
        }
      })
    );

    // 配置渲染器选项
    this.marked.setOptions({
      breaks: true,
      gfm: true,
    });

    // 自定义渲染器
    const renderer = new Renderer();

    // 自定义链接渲染，添加 target="_blank"
    renderer.link = ({ href, title, tokens }) => {
      // 简单提取文本内容
      const text = tokens.map(token => {
        if (token.type === 'text') {
          return (token as any).text;
        }
        return token.raw || '';
      }).join('');
      return `<a href="${href}" ${title ? `title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
    };

    this.marked.use({ renderer });
  }

  /**
   * 检查是否为特殊的 Aily 代码块类型
   */
  private isAilyCodeBlock(lang: string): boolean {
    const ailyTypes = ['aily-blockly', 'aily-board', 'aily-library', 'aily-state', 'aily-button', 'aily-error', 'aily-mermaid', 'mermaid'];
    return ailyTypes.includes(lang);
  }/**
   * 渲染 Aily 特殊代码块为组件占位符
   */
  private renderAilyCodeBlockWithComponent(code: string, type: string): string {
    try {
      // 解析代码内容
      const parsedContent = this.parseAilyContent(code, type);

      // 生成唯一的组件 ID
      const componentId = `aily-component-${++MarkdownPipe.componentCounter}`;      // 使用安全的 Base64 编码以避免 UTF-8 字符问题
      const encodedData = safeBase64Encode(JSON.stringify(parsedContent));

      // 返回包含组件占位符的 HTML
      // 这个占位符将在后续的指令处理中被替换为真正的 Angular 组件
      return `<div class="aily-code-block-placeholder" 
                   data-aily-type="${type}" 
                   data-aily-data="${encodedData}" 
                   data-component-id="${componentId}">
                  <!-- Aily ${type} Component Placeholder -->
              </div>`;
    } catch (error) {
      console.warn(`Error preparing ${type} component:`, error);
      return this.renderFallbackCodeBlock(code, type, error);
    }
  }

  /**
   * 渲染降级的代码块（当组件渲染失败时）
   */
  private renderFallbackCodeBlock(code: string, type: string, error?: any): string {
    return `<div class="aily-code-block error-block" data-type="${type}">
      <div class="aily-code-header">
        <span class="aily-code-type">Aily ${type}</span>
        <span class="error-badge">渲染失败</span>
      </div>
      <div class="error-message">
        组件渲染失败: ${error?.message || '未知错误'}
      </div>
      <div class="fallback-content">
        <pre><code>${code}</code></pre>
      </div>
    </div>`;
  }
  /**
   * 解析 Aily 代码内容
   */
  private parseAilyContent(code: string, type: string): any {
    // 清理代码内容 - 移除多余的空白字符和换行
    const cleanedCode = code.trim();

    // 对于 aily-mermaid 类型，直接返回纯文本内容，不尝试解析 JSON
    if (type === 'aily-mermaid') {
      return {
        type: 'aily-mermaid',
        code: cleanedCode,
        content: cleanedCode,
        raw: cleanedCode,
        metadata: {
          isRawText: true
        }
      };
    }

    try {
      // 对于其他类型，尝试解析为 JSON
      const jsonData = JSON.parse(cleanedCode);

      // 根据类型验证和规范化数据
      switch (type) {
        case 'aily-blockly':
          return {
            type: 'aily-blockly',
            blocks: jsonData.blocks || jsonData,
            workspace: jsonData.workspace || {},
            metadata: jsonData.metadata || {},
            config: jsonData.config || {}
          };
        case 'aily-board':
          return {
            type: 'aily-board',
            board: this.validateBoardData(jsonData.board || jsonData),
            config: jsonData.config || {},
            metadata: jsonData.metadata || {}
          };

        case 'aily-library':
          return {
            type: 'aily-library',
            library: this.validateLibraryData(jsonData.library || jsonData),
            dependencies: jsonData.dependencies || [],
            metadata: jsonData.metadata || {}
          };
        case 'aily-state':
          return {
            type: 'aily-state',
            state: jsonData.state || jsonData.status || 'info',
            id: jsonData.id || `state-${Date.now()}`,
            text: jsonData.text || jsonData.message || jsonData.content || '',
            progress: jsonData.progress,
            metadata: jsonData.metadata || {}
          };
        case 'aily-error':
          return {
            type: 'aily-error',
            error: jsonData.error || jsonData,
            message: jsonData.message || jsonData.error?.message,
            code: jsonData.code || jsonData.error?.code,
            details: jsonData.details || jsonData.error?.details,
            stack: jsonData.stack || jsonData.error?.stack,
            timestamp: jsonData.timestamp || new Date().toISOString(),
            severity: this.validateErrorSeverity(jsonData.severity || jsonData.error?.severity),
            category: jsonData.category || jsonData.error?.category,
            metadata: jsonData.metadata || {}
          };
        case 'aily-button':
          return {
            type: 'aily-button',
            buttons: Array.isArray(jsonData) ? jsonData : (jsonData.buttons || [jsonData]),
            config: jsonData.config || {},
            metadata: jsonData.metadata || {}
          };
        default:
          console.warn(`Unknown aily type: ${type}, using raw data`);
          return {
            type: type,
            raw: cleanedCode,
            content: jsonData,
            metadata: { isUnknownType: true }
          };
      }
    } catch (parseError) {
      console.warn(`Failed to parse JSON for ${type}:`, parseError);
      console.log('Using raw content for rendering:', code);
      // 如果不是 JSON，返回原始字符串格式的数据
      return {
        type: type,
        raw: code,
        content: code.trim(),
        metadata: {
          isRawText: true,
          parseError: parseError.message
        }
      };
    }
  }

  /**
   * 验证开发板数据
   */
  private validateBoardData(boardData: any): any {
    if (!boardData || typeof boardData !== 'object') {
      throw new Error('Invalid board data: must be an object');
    }

    return {
      name: boardData.name || 'Unknown Board',
      nickname: boardData.nickname || boardData.name || 'Unknown Board',
      version: boardData.version || '1.0.0',
      description: boardData.description || '',
      author: boardData.author || '',
      brand: boardData.brand || '',
      url: boardData.url || '',
      compatibility: boardData.compatibility || '',
      img: boardData.img || '',
      disabled: Boolean(boardData.disabled),
      ...boardData
    };
  }

  /**
   * 验证库数据
   */
  private validateLibraryData(libraryData: any): any {
    if (!libraryData || typeof libraryData !== 'object') {
      throw new Error('Invalid library data: must be an object');
    }

    return {
      name: libraryData.name || 'Unknown Library',
      nickname: libraryData.nickname || libraryData.name || 'Unknown Library',
      version: libraryData.version || '1.0.0',
      description: libraryData.description || '',
      author: libraryData.author || '',
      compatibility: libraryData.compatibility || {},
      keywords: Array.isArray(libraryData.keywords) ? libraryData.keywords : [],
      tested: Boolean(libraryData.tested),
      icon: libraryData.icon || 'fa-light fa-cube',
      ...libraryData
    };
  }

  /**
   * 验证错误严重程度
   */
  private validateErrorSeverity(severity: any): 'error' | 'warning' | 'info' {
    const validSeverities = ['error', 'warning', 'info'];
    return validSeverities.includes(severity) ? severity : 'error';
  }

  transform(value: any, ...args: any[]): Observable<SafeHtml> {
    if (!value) {
      return of(this.sanitizer.bypassSecurityTrustHtml(''));
    }

    const markdownText = String(value);

    return from(this.marked.parse(markdownText)).pipe(
      map((html: string) => {
        // 在这里，HTML 已经包含了组件占位符
        // 后续需要通过指令或其他机制将占位符替换为真正的组件
        return this.sanitizer.bypassSecurityTrustHtml(html);
      }),
      catchError((error) => {
        console.warn('Markdown parsing error:', error);
        // 如果解析失败，返回原始文本
        return of(this.sanitizer.bypassSecurityTrustHtml(markdownText));
      })
    );
  }
}

/**
 * 安全的 Base64 编码工具函数，支持 UTF-8 字符
 */
export function safeBase64Encode(str: string): string {
  try {
    // 使用 TextEncoder 将字符串转换为 UTF-8 字节数组
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);

    // 将字节数组转换为二进制字符串
    let binaryString = '';
    for (let i = 0; i < bytes.length; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }

    // 使用 btoa 对二进制字符串进行 Base64 编码
    return btoa(binaryString);
  } catch (error) {
    console.warn('Base64 encoding failed, using fallback:', error);
    // 降级方案：使用 encodeURIComponent
    return encodeURIComponent(str);
  }
}

/**
 * 安全的 Base64 解码工具函数，支持 UTF-8 字符
 */
export function safeBase64Decode(encodedStr: string): string {
  try {
    // 尝试 Base64 解码
    const binaryString = atob(encodedStr);

    // 将二进制字符串转换为字节数组
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 使用 TextDecoder 将字节数组转换为 UTF-8 字符串
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  } catch (error) {
    console.warn('Base64 decoding failed, using fallback:', error);
    // 降级方案：尝试 decodeURIComponent
    try {
      return decodeURIComponent(encodedStr);
    } catch {
      return encodedStr; // 如果都失败，返回原始字符串
    }
  }
}
