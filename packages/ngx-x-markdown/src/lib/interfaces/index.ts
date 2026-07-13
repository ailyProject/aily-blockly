import type { Config as DOMPurifyConfig } from 'dompurify';
import type { MarkedExtension, Tokens } from 'marked';

// ===================== Animation Config =====================

export interface AnimationConfig {
  /**
   * 淡入动画的持续时间（毫秒）
   * @default 200
   */
  fadeDuration?: number;
  /**
   * 动画的缓动函数
   * @default 'ease-in-out'
   */
  easing?: string;
}

// ===================== Stream Cache Token Type =====================

export enum StreamCacheTokenType {
  Text = 'text',
  Link = 'link',
  Image = 'image',
  Html = 'html',
  Emphasis = 'emphasis',
  List = 'list',
  Table = 'table',
  InlineCode = 'inline-code',
}

type Token = Tokens.Generic;

// ===================== Streaming Option =====================

export interface StreamingOption {
  /**
   * 指示是否还有后续内容块，为 false 时刷新所有缓存并完成渲染
   * @default false
   */
  hasNextChunk?: boolean;
  /**
   * 为块级元素启用文字淡入动画
   * @default false
   */
  enableAnimation?: boolean;
  /**
   * 文字出现动画效果的配置
   */
  animationConfig?: AnimationConfig;
  /**
   * VS Code/Copilot-style streaming buffer mode.
   * - paragraph: render at paragraph boundaries, with an escape hatch for long tails.
   * - word: reveal words by an estimated VS Code/Copilot-style words/sec rate.
   * - off: render every rAF-coalesced update immediately.
   * @default paragraph
   */
  buffering?: 'paragraph' | 'word' | 'off';
  /**
   * Estimated output rate used by word buffering, in words/sec.
   */
  impliedWordLoadRate?: number;
  /**
   * 未完成的 Markdown 格式转换为自定义加载组件的映射配置
   */
  incompleteMarkdownComponentMap?: Partial<
    Record<
      Exclude<(typeof StreamCacheTokenType)[keyof typeof StreamCacheTokenType], 'text'>,
      string
    >
  >;
}

// ===================== Stream Status =====================

export type StreamStatus = 'loading' | 'done';

// ===================== Component Map =====================

/**
 * Angular 版本的组件映射: tagName -> Angular 组件类
 * 用户可通过 components Input 传递自定义组件映射
 */
export type ComponentMap = {
  [tagName: string]: any; // Angular component class Type<any>
};

// ===================== XMarkdown Props (Angular Inputs) =====================

export interface XMarkdownConfig {
  /** Markdown 内容 */
  content?: string;
  /** 自定义组件映射 */
  components?: ComponentMap;
  /** 流式渲染配置 */
  streaming?: StreamingOption;
  /** Marked.js 扩展配置 */
  config?: MarkedExtension;
  /** 根元素额外 CSS 类名 */
  rootClassName?: string;
  /** 段落标签名 @default 'p' */
  paragraphTag?: string;
  /** 是否在新标签页打开链接 @default false */
  openLinksInNewTab?: boolean;
  /** DOMPurify 配置 */
  dompurifyConfig?: DOMPurifyConfig;
  /** 保护自定义标签中的换行符 @default false */
  protectCustomTagNewlines?: boolean;
}

export type { Token, Tokens, DOMPurifyConfig };
