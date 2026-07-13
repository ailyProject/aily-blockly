import * as DOMPurifyNS from 'dompurify';
import type { Config as DOMPurifyConfig } from 'dompurify';

// dompurify 使用 export =，ESM 下需兼容 default 或 namespace
type DOMPurifyInstance = { sanitize: (dirty: string, cfg?: DOMPurifyConfig) => string };
const DOMPurify: DOMPurifyInstance =
  (DOMPurifyNS as unknown as { default?: DOMPurifyInstance }).default ?? (DOMPurifyNS as unknown as DOMPurifyInstance);
import type { ComponentMap } from '../interfaces';

interface RendererOptions {
  components?: ComponentMap;
  dompurifyConfig?: DOMPurifyConfig;
}

/**
 * Angular 版本的 Renderer
 * 与 React 版本不同，Angular 无法使用 html-react-parser 将 HTML 转换为组件树，
 * 因此这里只做 HTML 净化 + 自定义标签属性注入，
 * 然后配合 Angular 的 [innerHTML] 和指令来实现自定义组件替换。
 */
export class MarkdownRenderer {
  private readonly options: RendererOptions;

  constructor(options: RendererOptions) {
    this.options = options;
  }

  /**
   * 检测未闭合的自定义标签
   */
  private detectUnclosedTags(htmlString: string): Set<string> {
    const unclosedTags = new Set<string>();
    const stack: string[] = [];
    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;

    let match = tagRegex.exec(htmlString);
    while (match !== null) {
      const [fullMatch, tagName] = match;
      const isClosing = fullMatch.startsWith('</');
      const isSelfClosing = fullMatch.endsWith('/>');

      if (this.options.components?.[tagName.toLowerCase()]) {
        if (isClosing) {
          const lastIndex = stack.lastIndexOf(tagName.toLowerCase());
          if (lastIndex !== -1) {
            stack.splice(lastIndex, 1);
          }
        } else if (!isSelfClosing) {
          stack.push(tagName.toLowerCase());
        }
      }
      match = tagRegex.exec(htmlString);
    }

    stack.forEach((tag) => {
      unclosedTags.add(tag);
    });
    return unclosedTags;
  }

  /**
   * 配置 DOMPurify，保留自定义组件和 target 属性
   */
  private configureDOMPurify(): DOMPurifyConfig {
    const customComponents = Object.keys(this.options.components || {});
    const userConfig = this.options.dompurifyConfig || {};

    const allowedTags = Array.isArray(userConfig.ADD_TAGS) ? userConfig.ADD_TAGS : [];
    const addAttr = Array.isArray(userConfig.ADD_ATTR) ? userConfig.ADD_ATTR : [];

    return {
      ...userConfig,
      ADD_TAGS: Array.from(new Set([...customComponents, ...allowedTags])),
      ADD_ATTR: Array.from(new Set(['target', 'rel', 'data-block', 'data-state', 'data-lang', ...addAttr])),
    };
  }

  /**
   * 对 HTML 进行净化 + 为自定义标签注入 stream-status 属性
   */
  public render(htmlString: string): string {
    if (!htmlString) return '';

    const unclosedTags = this.detectUnclosedTags(htmlString);
    const purifyConfig = this.configureDOMPurify();
    let cleanHtml = DOMPurify.sanitize(htmlString, purifyConfig);

    // 为自定义标签注入 data-stream-status 属性
    const components = this.options.components || {};
    for (const tagName of Object.keys(components)) {
      const tagLower = tagName.toLowerCase();
      const status = unclosedTags.has(tagLower) ? 'loading' : 'done';
      const regex = new RegExp(`<${tagLower}(\\s|>|/>)`, 'gi');
      cleanHtml = cleanHtml.replace(regex, (match: string, after: string) => {
        return `<${tagLower} data-stream-status="${status}"${after}`;
      });
    }

    return cleanHtml;
  }
}
