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
import { ConfigService } from '../../../services/config.service';

/**
 * 库/开发板验证回调事件
 * 当发现不存在的库或开发板时触发，用于通知大模型正确的名称
 */
export interface ValidationCorrectionEvent {
  type: 'library' | 'board';
  originalQuery: string;
  correctedName: string;
  correctedData: any;
  isFuzzyMatch: boolean;
}

// 全局事件存储，用于收集验证校正结果
let pendingCorrections: ValidationCorrectionEvent[] = [];

/**
 * 获取并清空待处理的校正事件
 */
export function getPendingCorrections(): ValidationCorrectionEvent[] {
  const corrections = [...pendingCorrections];
  pendingCorrections = [];
  return corrections;
}

/**
 * 添加校正事件
 */
function addCorrectionEvent(event: ValidationCorrectionEvent) {
  pendingCorrections.push(event);
}

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
    private sanitizer: DomSanitizer,
    private configService: ConfigService
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
    const ailyTypes = ['aily-blockly', 'aily-board', 'aily-library', 'aily-state', 'aily-button', 'aily-error', 'aily-mermaid', 'mermaid', 'aily-task-action'];
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

    // console.log(`Parsing Aily content of type ${type}:`, cleanedCode);

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
            metadata: jsonData.metadata || {},
            isHistory: jsonData.isHistory || false
          };
        case 'aily-task-action':
          return {
            type: 'aily-task-action',
            actionType: jsonData.actionType || jsonData.action_type || 'unknown',
            message: jsonData.message || jsonData.text || '',
            stopReason: jsonData.stopReason || jsonData.stop_reason || '',
            metadata: {
              maxMessages: jsonData.metadata?.maxMessages || jsonData.maxMessages,
              currentMessages: jsonData.metadata?.currentMessages || jsonData.currentMessages,
              errorCode: jsonData.metadata?.errorCode || jsonData.errorCode,
              ...jsonData.metadata
            },
            isHistory: jsonData.isHistory || false
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
   * 检测名称更可能是库还是开发板
   * @param name 名称
   * @returns 'library' | 'board' | 'unknown'
   */
  private detectNameType(name: string): 'library' | 'board' | 'unknown' {
    if (!name) return 'unknown';
    const lowerName = name.toLowerCase();
    
    // 检查是否包含库的特征
    if (lowerName.includes('lib-') || lowerName.includes('/lib-')) {
      return 'library';
    }
    
    // 检查是否包含开发板的特征
    if (lowerName.includes('board-') || lowerName.includes('/board-')) {
      return 'board';
    }
    
    return 'unknown';
  }

  /**
   * 验证开发板数据
   * 如果开发板不存在，尝试模糊匹配找到真实存在的开发板
   * 如果名称看起来像库，会自动尝试匹配库并返回修正后的类型
   */
  private validateBoardData(boardData: any): any {
    if (!boardData || typeof boardData !== 'object') {
      throw new Error('Invalid board data: must be an object');
    }

    // 获取查询名称（优先使用 name，其次 nickname/displayName）
    const queryName = boardData.name || boardData.nickname || boardData.displayName;
    
    if (queryName && this.configService) {
      // 先检测名称类型，判断是否被错误分类
      const detectedType = this.detectNameType(queryName);
      
      // 如果名称看起来像库，优先尝试库验证
      if (detectedType === 'library') {
        const libValidation = this.configService.validateLibrary(queryName);
        if (libValidation.exists && libValidation.library) {
          console.log(`[MarkdownPipe] 类型修正: "${queryName}" 被错误放入 aily-board，实际是库`);
          addCorrectionEvent({
            type: 'library',
            originalQuery: queryName,
            correctedName: libValidation.library.name,
            correctedData: libValidation.library,
            isFuzzyMatch: libValidation.fuzzyMatch
          });
          
          // 返回库数据，并标记类型已修正
          return {
            ...libValidation.library,
            _validated: true,
            _fuzzyMatch: libValidation.fuzzyMatch,
            _originalQuery: queryName,
            _typeCorrected: true,
            _actualType: 'library'
          };
        }
      }
      
      // 使用 ConfigService 验证开发板是否存在
      const validation = this.configService.validateBoard(queryName);
      
      if (validation.exists && validation.board) {
        // 找到了真实存在的开发板
        if (validation.fuzzyMatch) {
          // 模糊匹配，记录校正事件，通知大模型
          console.log(`[MarkdownPipe] 开发板模糊匹配: "${queryName}" -> "${validation.board.name}"`);
          addCorrectionEvent({
            type: 'board',
            originalQuery: validation.originalQuery,
            correctedName: validation.board.name,
            correctedData: validation.board,
            isFuzzyMatch: true
          });
        }
        
        // 使用真实存在的开发板数据
        return {
          ...validation.board,
          _validated: true,
          _fuzzyMatch: validation.fuzzyMatch,
          _originalQuery: validation.fuzzyMatch ? queryName : undefined
        };
      }
      
      // 开发板验证失败，再次尝试库验证（兜底）
      if (detectedType !== 'library') {
        const libFallback = this.configService.validateLibrary(queryName);
        if (libFallback.exists && libFallback.library) {
          console.log(`[MarkdownPipe] 类型修正(兜底): "${queryName}" 在开发板中未找到，但在库中找到`);
          addCorrectionEvent({
            type: 'library',
            originalQuery: queryName,
            correctedName: libFallback.library.name,
            correctedData: libFallback.library,
            isFuzzyMatch: libFallback.fuzzyMatch
          });
          
          return {
            ...libFallback.library,
            _validated: true,
            _fuzzyMatch: libFallback.fuzzyMatch,
            _originalQuery: queryName,
            _typeCorrected: true,
            _actualType: 'library'
          };
        }
      }
    }

    // 未找到或 ConfigService 不可用，使用原始数据并添加默认值
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
      _validated: false,
      ...boardData
    };
  }

  /**
   * 验证库数据
   * 如果库不存在，尝试模糊匹配找到真实存在的库
   * 如果名称看起来像开发板，会自动尝试匹配开发板并返回修正后的类型
   */
  private validateLibraryData(libraryData: any): any {
    if (!libraryData || typeof libraryData !== 'object') {
      throw new Error('Invalid library data: must be an object');
    }

    // 获取查询名称（优先使用 name，其次 nickname）
    const queryName = libraryData.name || libraryData.nickname;
    
    if (queryName && this.configService) {
      // 先检测名称类型，判断是否被错误分类
      const detectedType = this.detectNameType(queryName);
      
      // 如果名称看起来像开发板，优先尝试开发板验证
      if (detectedType === 'board') {
        const boardValidation = this.configService.validateBoard(queryName);
        if (boardValidation.exists && boardValidation.board) {
          console.log(`[MarkdownPipe] 类型修正: "${queryName}" 被错误放入 aily-library，实际是开发板`);
          addCorrectionEvent({
            type: 'board',
            originalQuery: queryName,
            correctedName: boardValidation.board.name,
            correctedData: boardValidation.board,
            isFuzzyMatch: boardValidation.fuzzyMatch
          });
          
          // 返回开发板数据，并标记类型已修正
          return {
            ...boardValidation.board,
            _validated: true,
            _fuzzyMatch: boardValidation.fuzzyMatch,
            _originalQuery: queryName,
            _typeCorrected: true,
            _actualType: 'board'
          };
        }
      }
      
      // 使用 ConfigService 验证库是否存在
      const validation = this.configService.validateLibrary(queryName);
      
      if (validation.exists && validation.library) {
        // 找到了真实存在的库
        if (validation.fuzzyMatch) {
          // 模糊匹配，记录校正事件，通知大模型
          console.log(`[MarkdownPipe] 库模糊匹配: "${queryName}" -> "${validation.library.name}"`);
          addCorrectionEvent({
            type: 'library',
            originalQuery: validation.originalQuery,
            correctedName: validation.library.name,
            correctedData: validation.library,
            isFuzzyMatch: true
          });
        }
        
        // 使用真实存在的库数据
        return {
          ...validation.library,
          _validated: true,
          _fuzzyMatch: validation.fuzzyMatch,
          _originalQuery: validation.fuzzyMatch ? queryName : undefined
        };
      }
      
      // 库验证失败，再次尝试开发板验证（兜底）
      if (detectedType !== 'board') {
        const boardFallback = this.configService.validateBoard(queryName);
        if (boardFallback.exists && boardFallback.board) {
          console.log(`[MarkdownPipe] 类型修正(兜底): "${queryName}" 在库中未找到，但在开发板中找到`);
          addCorrectionEvent({
            type: 'board',
            originalQuery: queryName,
            correctedName: boardFallback.board.name,
            correctedData: boardFallback.board,
            isFuzzyMatch: boardFallback.fuzzyMatch
          });
          
          return {
            ...boardFallback.board,
            _validated: true,
            _fuzzyMatch: boardFallback.fuzzyMatch,
            _originalQuery: queryName,
            _typeCorrected: true,
            _actualType: 'board'
          };
        }
      }
    }

    // 未找到或 ConfigService 不可用，使用原始数据并添加默认值
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
      _validated: false,
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
        const filteredHtml = this.filterHiddenTokens(html);
        return this.sanitizer.bypassSecurityTrustHtml(filteredHtml);
      }),
      catchError((error) => {
        console.warn('Markdown parsing error:', error);
        // 如果解析失败，返回原始文本
        const filteredMarkdown = this.filterHiddenTokens(markdownText);
        return of(this.sanitizer.bypassSecurityTrustHtml(filteredMarkdown));
      })
    );
  }

  /**
   * 过滤需要隐藏的特殊标记，防止在界面上渲染
   */
  private filterHiddenTokens(content: string): string {
    return content.replace(/TERMINATE/g, '');
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
