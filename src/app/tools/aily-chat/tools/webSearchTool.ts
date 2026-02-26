import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { injectTodoReminder } from './todoWriteTool';

export interface WebSearchToolArgs {
  query: string;
  maxResults?: number;
}

export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

export interface WebSearchToolResult {
  content: string;
  is_error: boolean;
  metadata?: {
    query: string;
    resultCount: number;
    durationMs: number;
  };
}

@Injectable({
  providedIn: 'root'
})
export class WebSearchToolService {
  constructor(private http: HttpClient) {}

  async executeSearch(args: WebSearchToolArgs): Promise<WebSearchToolResult> {
    const startTime = Date.now();
    const { query, maxResults = 10 } = args;

    if (!query || query.trim().length === 0) {
      return { content: '搜索关键词不能为空', is_error: true };
    }

    try {
      const results = await this.searchDuckDuckGo(query.trim(), maxResults);
      const durationMs = Date.now() - startTime;

      if (results.length === 0) {
        return {
          content: `未找到与 "${query}" 相关的搜索结果。请尝试使用不同的关键词。`,
          is_error: false,
          metadata: { query, resultCount: 0, durationMs }
        };
      }

      // 格式化搜索结果为 Markdown
      let content = `搜索 "${query}" 找到 ${results.length} 条结果：\n\n`;
      results.forEach((item, index) => {
        content += `${index + 1}. **${item.title}**\n`;
        content += `   ${item.snippet}\n`;
        content += `   链接: ${item.link}\n\n`;
      });
      content += `可以使用 fetch 工具获取上述链接的详细内容。`;

      return {
        content,
        is_error: false,
        metadata: { query, resultCount: results.length, durationMs }
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      console.warn('Web搜索工具执行失败:', error);

      return {
        content: `网络搜索失败: ${error.message || '未知错误'}。请检查网络连接后重试。`,
        is_error: true,
        metadata: { query, resultCount: 0, durationMs }
      };
    }
  }

  /** 通过 DuckDuckGo HTML 搜索获取结果 */
  private async searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const headers = new HttpHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    });

    const html = await firstValueFrom(
      this.http.get(searchUrl, {
        responseType: 'text',
        headers
      }).pipe(timeout(15000))
    );

    return this.parseDuckDuckGoResults(html, maxResults);
  }

  /** 解析 DuckDuckGo HTML 搜索结果 */
  private parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // DuckDuckGo HTML 搜索结果使用 .result 类
      const resultNodes = doc.querySelectorAll('.result.results_links');

      for (const node of Array.from(resultNodes)) {
        if (results.length >= maxResults) break;

        const titleNode = node.querySelector('.result__a');
        const snippetNode = node.querySelector('.result__snippet');

        if (titleNode && snippetNode) {
          const title = titleNode.textContent?.trim();
          let link = titleNode.getAttribute('href') || '';
          const snippet = snippetNode.textContent?.trim();

          if (title && link && snippet) {
            // 清理 DuckDuckGo 重定向链接
            link = this.cleanDuckDuckGoLink(link);
            if (link) {
              results.push({ title, snippet, link });
            }
          }
        }
      }

      // 备用选择器（DuckDuckGo 可能更新 HTML 结构）
      if (results.length === 0) {
        const altResultNodes = doc.querySelectorAll('.web-result');
        for (const node of Array.from(altResultNodes)) {
          if (results.length >= maxResults) break;

          const titleNode = node.querySelector('.result__a') || node.querySelector('a.result__url');
          const snippetNode = node.querySelector('.result__snippet');

          if (titleNode) {
            const title = titleNode.textContent?.trim() || '';
            let link = titleNode.getAttribute('href') || '';
            const snippet = snippetNode?.textContent?.trim() || '';

            link = this.cleanDuckDuckGoLink(link);
            if (title && link) {
              results.push({ title, snippet, link });
            }
          }
        }
      }

      // 如果 DOM 解析都失败，使用正则表达式作为最终回退
      if (results.length === 0) {
        return this.parseDuckDuckGoWithRegex(html, maxResults);
      }
    } catch {
      // DOM 解析失败，使用正则回退
      return this.parseDuckDuckGoWithRegex(html, maxResults);
    }

    return results;
  }

  /** 正则表达式回退解析 */
  private parseDuckDuckGoWithRegex(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    // 匹配 result__a 标签
    const titlePattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: Array<{ link: string; title: string }> = [];
    let match;

    while ((match = titlePattern.exec(html)) !== null) {
      const link = this.cleanDuckDuckGoLink(match[1]);
      const title = this.stripHtmlTags(match[2]).trim();
      if (link && title) {
        titles.push({ link, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetPattern.exec(html)) !== null) {
      snippets.push(this.stripHtmlTags(match[1]).trim());
    }

    for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
      results.push({
        title: titles[i].title,
        link: titles[i].link,
        snippet: snippets[i] || ''
      });
    }

    return results;
  }

  /** 清理 DuckDuckGo 重定向链接 */
  private cleanDuckDuckGoLink(rawLink: string): string {
    if (!rawLink) return '';

    // DuckDuckGo 使用 /l/?uddg= 重定向
    if (rawLink.includes('duckduckgo.com/l/?') || rawLink.includes('uddg=')) {
      try {
        const url = new URL(rawLink.startsWith('http') ? rawLink : `https://duckduckgo.com${rawLink}`);
        const uddg = url.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
      } catch {}
    }

    // 直接链接
    if (rawLink.startsWith('http://') || rawLink.startsWith('https://')) {
      return rawLink;
    }

    // 相对路径
    if (rawLink.startsWith('//')) {
      return `https:${rawLink}`;
    }

    return '';
  }

  /** 去除 HTML 标签 */
  private stripHtmlTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  }
}

export async function webSearchTool(searchService: WebSearchToolService, args: WebSearchToolArgs): Promise<WebSearchToolResult> {
  const toolResult = await searchService.executeSearch(args);
  return injectTodoReminder(toolResult, 'webSearchTool') as WebSearchToolResult;
}
