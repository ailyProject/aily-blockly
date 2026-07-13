import type { TokenizerAndRendererExtension } from 'marked';

export type MermaidOption = {
  /**
   * 传入 mermaid 实例（来自 `import mermaid from 'mermaid'`）。
   * 由用户端传入，避免库强依赖 mermaid 包。
   */
  mermaidInstance?: any;

  /**
   * mermaid.initialize() 配置
   * @see https://mermaid.js.org/config/setup/modules/mermaidAPI.html#mermaidapi-configuration-defaults
   */
  mermaidConfig?: Record<string, any>;

  /**
   * 自定义容器的 CSS 类名
   * @default 'x-markdown-mermaid'
   */
  containerClassName?: string;

  /**
   * 加载中的提示文字
   * @default '图表渲染中...'
   */
  loadingText?: string;
};

const fencedCodeRule = /^(`{3,})mermaid\s*\n([\s\S]*?)\n\1(?:\n|$)/;

type MermaidToken = {
  type: string;
  raw: string;
  text: string;
};

/**
 * Mermaid 插件 —— 将 ```mermaid 代码块转换为 Mermaid 可渲染的 HTML。
 *
 * 工作原理：
 * 1. 通过 marked 的 tokenizer 拦截 ```mermaid 代码块
 * 2. 渲染为带 loading 占位符的容器 + 隐藏的 `<pre class="mermaid">`
 * 3. `renderMermaidDiagrams()` 使用 SVG 缓存避免重复渲染（消除流式闪烁）
 * 4. 新图表异步渲染（带 debounce），完成前显示 loading
 */
export const Mermaid = (options?: MermaidOption): TokenizerAndRendererExtension[] => {
  const {
    mermaidInstance,
    mermaidConfig,
    containerClassName = 'x-markdown-mermaid',
    loadingText = '图表渲染中...',
  } = options || {};

  // 如果传入了 mermaid 实例，进行初始化
  if (mermaidInstance) {
    mermaidInstance.initialize({
      startOnLoad: false,
      ...mermaidConfig,
    });
  }

  const blockMermaid: TokenizerAndRendererExtension = {
    name: 'mermaid',
    level: 'block' as const,
    start(src: string) {
      const index = src.indexOf('```mermaid');
      return index !== -1 ? index : undefined;
    },
    tokenizer(src: string): MermaidToken | undefined {
      const match = src.match(fencedCodeRule);
      if (match) {
        return {
          type: 'mermaid',
          raw: match[0],
          text: match[2].trim(),
        };
      }
      return undefined;
    },
    renderer(token: Record<string, string>): string {
      const text = token['text'] || '';
      const escapedText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      // loading 占位符默认可见，<pre> 通过 CSS 隐藏直到 data-processed
      return (
        `<div class="${containerClassName}">` +
        `<div class="mermaid-loading">` +
        `<div class="mermaid-spinner"></div>` +
        `<span>${loadingText}</span>` +
        `</div>` +
        `<pre class="mermaid">${escapedText}</pre>` +
        `</div>\n`
      );
    },
  };

  return [blockMermaid];
};

// ===================== SVG 缓存 + 防抖渲染 =====================

/** 缓存: mermaid 源码文本 → 渲染后的 SVG innerHTML */
const svgCache = new Map<string, string>();

/** 防抖定时器 */
let renderTimer: ReturnType<typeof setTimeout> | null = null;

/** 防止并发 mermaid.run() */
let isRendering = false;

/**
 * 渲染 mermaid 图表（带 SVG 缓存 + 防抖）。
 *
 * 对于流式场景，每次 innerHTML 更新都会销毁已渲染的 SVG。
 * 此函数通过缓存机制同步恢复已渲染过的图表（无闪烁），
 * 仅对真正新出现的图表调用异步 mermaid.run()。
 *
 * @param mermaidInstance - mermaid 实例
 * @param container - 包含 mermaid 元素的 DOM 容器，不传则全局渲染
 */
export async function renderMermaidDiagrams(
  mermaidInstance: any,
  container?: HTMLElement,
): Promise<void> {
  if (!mermaidInstance) {
    console.warn('[ngx-x-markdown] mermaid instance is required for rendering.');
    return;
  }

  const root = container || document;
  const unprocessed = root.querySelectorAll('pre.mermaid:not([data-processed])');
  if (unprocessed.length === 0) return;

  // ---- Phase 1: 同步恢复缓存（消除闪烁）----
  const needsRender: Element[] = [];
  unprocessed.forEach((node) => {
    const source = (node.textContent || '').trim();
    const cached = svgCache.get(source);
    if (cached) {
      // 同步注入缓存的 SVG，无需等待 mermaid.run()
      node.innerHTML = cached;
      node.setAttribute('data-processed', 'true');
      finishLoading(node);
    } else {
      needsRender.push(node);
    }
  });

  // 全部从缓存恢复，无需异步渲染
  if (needsRender.length === 0) return;

  // ---- Phase 2: 防抖异步渲染新图表 ----
  if (isRendering) return;

  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(async () => {
    if (isRendering) return;
    isRendering = true;

    try {
      // 重新查询（防抖期间 DOM 可能已变化）
      const freshNodes = (container || document).querySelectorAll(
        'pre.mermaid:not([data-processed])'
      );
      if (freshNodes.length === 0) return;

      // 在 mermaid.run() 替换内容之前保存源码文本
      const sourceMap = new Map<Element, string>();
      freshNodes.forEach((node) => {
        sourceMap.set(node, (node.textContent || '').trim());
      });

      await mermaidInstance.run({ nodes: freshNodes });

      // 缓存渲染结果 + 清理 loading
      freshNodes.forEach((node) => {
        const source = sourceMap.get(node);
        if (source && node.getAttribute('data-processed') === 'true') {
          svgCache.set(source, node.innerHTML);
        }
        finishLoading(node);
      });
    } catch (e) {
      console.warn('[ngx-x-markdown] Mermaid rendering error:', e);
      // 渲染失败时显示错误提示
      const errorNodes = (container || document).querySelectorAll(
        '.x-markdown-mermaid:not(.mermaid-rendered) .mermaid-loading'
      );
      errorNodes.forEach((el) => {
        el.innerHTML = '<span class="mermaid-error">图表渲染失败</span>';
      });
    } finally {
      isRendering = false;
    }
  }, 150);
}

/** 隐藏 loading 占位符，标记容器为已渲染 */
function finishLoading(preNode: Element): void {
  const wrapper = preNode.closest('.x-markdown-mermaid');
  if (!wrapper) return;
  const loading = wrapper.querySelector('.mermaid-loading');
  if (loading) (loading as HTMLElement).style.display = 'none';
  wrapper.classList.add('mermaid-rendered');
}

/**
 * 清除 SVG 缓存。切换 mermaid 主题后需要调用以重新渲染所有图表。
 */
export function clearMermaidCache(): void {
  svgCache.clear();
}

export default Mermaid;
