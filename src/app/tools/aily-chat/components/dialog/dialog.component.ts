import {
  Component,
  ElementRef,
  Input,
  OnDestroy,
  OnChanges,
  ViewChild,
  SimpleChanges,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzAvatarModule } from 'ng-zorro-antd/avatar';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { DomSanitizer } from '@angular/platform-browser';
import { NzImageModule } from 'ng-zorro-antd/image';
import { FormsModule } from '@angular/forms';
import { AilyDynamicComponentDirective } from '../../directives/aily-dynamic-component.directive';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../../../services/config.service';

// import { AilyCodingComponent } from '../../../../components/aily-coding/aily-coding.component';

/**
 * Historical compatibility renderer.
 *
 * Active chat rendering uses x-dialog plus Part-based viewers.
 * This component is retained only for the archived aily-dialog markdown pipeline.
 * Do not add new active-path features here.
 *
 * @deprecated Legacy compatibility only.
 */

@Component({
  selector: 'aily-dialog',
  templateUrl: './dialog.component.html',
  styleUrls: ['./dialog.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzAvatarModule,
    NzButtonModule,
    AilyDynamicComponentDirective,
    NzImageModule
  ]
})
export class DialogComponent implements OnChanges, OnDestroy {
  @Input() role = 'user';
  @Input() content;
  @Input() doing = false;

  private markdownPipe: MarkdownPipe;
  private lastProcessedContent = ''; // 跟踪上次处理的完整内容
  private processContentChain = Promise.resolve(); // 串行化 processContent，避免兼容渲染重叠执行

  @ViewChild('contentDiv', { static: true }) contentDiv!: ElementRef<HTMLDivElement>;

  constructor(
    private sanitizer: DomSanitizer,
    private cd: ChangeDetectorRef,
    private configService: ConfigService
  ) {
    this.markdownPipe = new MarkdownPipe(this.sanitizer, this.configService);
  }

  ngOnDestroy(): void {
    this.lastProcessedContent = '';
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['content']) {
      this.processContent();
    }
  }

  private processContent() {
    this.processContentChain = this.processContentChain.then(() => this.processContentImpl()).catch(() => {});
  }

  private async processContentImpl() {
    const rawContent = typeof this.content === 'string' ? this.content : '';
    if (!rawContent) {
      this.lastProcessedContent = '';
      if (this.contentDiv?.nativeElement) {
        this.contentDiv.nativeElement.innerHTML = '';
      }
      return;
    }

    // 过滤 think 标签内容，支持实时过滤
    let currentContent = this.filterThinkContent(rawContent);

    // 过滤 attachments 标签：折叠上下文附件
    currentContent = this.filterContextTags(currentContent);
    
    // 对一些常见错误的处理，确保markdown格式正确
    currentContent = this.fixContent(currentContent);

    // 如果内容没有变化，则跳过处理
    if (currentContent === this.lastProcessedContent) {
      return;
    }

    // 处理代理名称替换
    const processedContent = this.replaceAgentNamesInContent(currentContent);

    await this.renderCompatibilityContent(processedContent);

    this.cd.detectChanges();
  }

  /**
   * Historical compatibility path: always re-render the whole content.
   * Active x-dialog rendering owns the optimized incremental path now.
   */
  private async renderCompatibilityContent(content: string): Promise<void> {
    try {
      const htmlObservable = this.markdownPipe.transform(content);
      const safeHtml = await firstValueFrom(htmlObservable);
      const container = this.contentDiv?.nativeElement;
      if (!container) {
        return;
      }
      container.innerHTML = this.getHtmlString(safeHtml);
      this.updateRenderState(content);
    } catch (error) {
      console.warn('Error in historical compatibility render:', error);
      // 降级处理
      if (this.contentDiv?.nativeElement) {
        this.contentDiv.nativeElement.textContent = content;
      }
      this.updateRenderState(content);
    }
  }

  /**
   * 更新渲染状态
   */
  private updateRenderState(content: string): void {
    this.lastProcessedContent = content;
  }

  /**
   * 从 SafeHtml 中提取 HTML 字符串
   */
  private getHtmlString(safeHtml: SafeHtml): string {
    // Angular 的 SafeHtml 对象内部包含了原始的 HTML 字符串
    return (safeHtml as any).changingThisBreaksApplicationSecurity || '';
  }

  /**
   * 替换内容中的代理名称为对应的emoji符号
   */
  private replaceAgentNamesInContent(content: string): string {
    let processedContent = content;

    // 使用正则表达式匹配 [to_xxx] 形式的内容
    const agentNameRegex = /\[to_[^\]]+\]/g;
    const matches = content.match(agentNameRegex);

    if (matches) {
      matches.forEach(match => {
        // 在 agentNameList 中查找对应的emoji
        const agentEntry = agentNameList.find(entry => entry[0] === match);
        if (agentEntry) {
          processedContent = processedContent.replace(match, agentEntry[1]);
        }
      });
    }

    return processedContent;
  }

  /**
   * 将 think 标签内容转换为 aily-think 代码块
   * 使用自定义组件实现可折叠的思考过程显示
   */
  private filterThinkContent(content: string): string {
    if (!content) return content;

    let result = '';
    let i = 0;
    let inThinkBlock = false;
    let thinkContent = '';

    while (i < content.length) {
      // 检查是否遇到 <think> 标签
      if (!inThinkBlock && content.substring(i, i + 7) === '<think>') {
        inThinkBlock = true;
        thinkContent = '';
        i += 7; // 跳过 <think>
        continue;
      }

      // 检查是否遇到 </think> 标签
      if (inThinkBlock && content.substring(i, i + 8) === '</think>') {
        inThinkBlock = false;
        // 将 think 内容转换为 aily-think 代码块
        if (thinkContent.trim()) {
          // 使用 base64 编码 content 避免换行符转义问题
          const encodedContent = btoa(encodeURIComponent(thinkContent.trim()));
          const thinkData = {
            content: encodedContent,
            isComplete: true,
            encoded: true
          };
          // 确保代码块前后有正确的换行
          result += '```aily-think\n' + JSON.stringify(thinkData) + '\n```';
        }
        thinkContent = '';
        i += 8; // 跳过 </think>
        continue;
      }

      // 收集 think 块内的内容或添加到结果中
      if (inThinkBlock) {
        thinkContent += content[i];
      } else {
        result += content[i];
      }

      i++;
    }

    // 如果内容结束时仍在 think 块内（流式传输中），显示正在思考的状态
    if (inThinkBlock && thinkContent.trim()) {
      // 使用 base64 编码 content 避免换行符转义问题
      const encodedContent = btoa(encodeURIComponent(thinkContent.trim()));
      const thinkData = {
        content: encodedContent,
        isComplete: false,
        encoded: true
      };
      // 确保代码块前后有正确的换行
      result += '```aily-think\n' + JSON.stringify(thinkData) + '\n```';
    }

    return result;
  }

  /**
   * 过滤 <attachments> 标签
   * - <attachments>...</attachments> → 转为可折叠的 aily-context 代码块
   */
  private filterContextTags(content: string): string {
    if (!content) return content;

    // 处理 <attachments>...</attachments> → 折叠式 HTML 块（兼容旧 <context> 标签）
    content = content.replace(/<(?:attachments|context)>\n?([\s\S]*?)\n?<\/(?:attachments|context)>/g, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return '';

      const label = this.extractContextLabel(trimmed);
      // 转义 HTML 特殊字符，防止内容干扰 DOM
      // 将换行符替换为 &#10; 实体，确保折叠内容在兼容渲染中保持稳定
      const escaped = trimmed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '&#10;');

      return `<details class="aily-context-block"><summary class="aily-context-summary"><i class="fa-light fa-cube"></i> ${label}</summary><pre class="aily-context-content">${escaped}</pre></details>`;
    });

    return content;
  }

  /**
   * 从上下文内容中提取简短标签用于折叠显示
   * 优先提取 blockly 行号，其次统计文件/文件夹/URL 数量
   */
  private extractContextLabel(contextText: string): string {
    const parts: string[] = [];

    // 检查是否包含积木块上下文行号信息（C++ 和 ABS）
    const cppLineMatch = contextText.match(/对应C\+\+代码行数:\s*(\S+)/);
    const absLineMatch = contextText.match(/对应ABS代码行数:\s*(\S+)/);

    if (cppLineMatch || absLineMatch) {
      const lineParts: string[] = [];
      if (absLineMatch) lineParts.push(`A${absLineMatch[1]}`);
      if (cppLineMatch) lineParts.push(`C${cppLineMatch[1]}`);
      parts.push(`blockly:${lineParts.join('/')}`);
    }

    // 统计参考文件数量
    const fileMatches = contextText.match(/^- .+/gm);
    if (fileMatches && contextText.includes('参考文件:')) {
      const fileCount = contextText.split('参考文件:')[1]?.split('\n\n')[0]?.match(/^- /gm)?.length || 0;
      if (fileCount > 0) parts.push(`${fileCount}个文件`);
    }
    if (contextText.includes('参考文件夹:')) {
      const folderCount = contextText.split('参考文件夹:')[1]?.split('\n\n')[0]?.match(/^- /gm)?.length || 0;
      if (folderCount > 0) parts.push(`${folderCount}个文件夹`);
    }

    return parts.length > 0 ? parts.join(' + ') : '附加上下文';
  }

  fixContent(content: string): string {
    // 处理大模型发来的数据中的转义字符
    content = content.replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');

    // 修复代码块结束符号后缺少换行符的问题
    content = this.fixCodeBlockEndings(content);

    // 修复mermaid代码块没有语言类型的问题
    return content.replace(/```\n\s*flowchart/g, '```aily-mermaid\nflowchart')
      .replace(/\s*```aily-board/g, '\n```aily-board\n')
      .replace(/\s*```aily-library/g, '\n```aily-library\n')
      .replace(/\s*```aily-state/g, '\n```aily-state\n')
      .replace(/\s*```aily-button/g, '\n```aily-button\n')
      .replace(/\s*```aily-task-action/g, '\n```aily-task-action\n')
      .replace(/\s*```aily-think/g, '\n```aily-think\n')
      .replace(/\[thinking...\]/g, '');
  }

  /**
   * 修复代码块结束符号后缺少换行符的问题
   */
  private fixCodeBlockEndings(content: string): string {
    // 定义 aily 代码块类型
    const ailyTypes = ['aily-blockly', 'aily-board', 'aily-library', 'aily-state', 'aily-button', 'aily-error', 'aily-mermaid', 'aily-task-action', 'aily-think'];

    // 只处理代码块结束符号 ``` (不是开始符号)
    // 查找所有的 ``` 并判断是否为结束符号
    content = content.replace(/```([^\n`]*)/g, (match, afterBackticks) => {
      // 如果 ``` 后面跟的是 aily 类型或某类型的流式前缀（如 aily-），说明这是开始符号，不需要换行
      const isAilyStart = ailyTypes.some(type => afterBackticks.startsWith(type) || type.startsWith(afterBackticks));

      if (isAilyStart) {
        // 这是 aily 代码块的开始，保持原样
        return match;
      } else {
        // 这是代码块的结束或者其他情况，确保后面有换行符
        if (afterBackticks === '') {
          // 纯粹的 ``` 结束符号
          return '```\n';
        } else {
          // ``` 后面跟着其他内容，添加换行符分隔
          return '```\n' + afterBackticks;
        }
      }
    });

    // 确保文本末尾的 ``` 后面有换行符（如果它是结束符号）
    if (content.endsWith('```')) {
      content += '\n';
    }

    return content;
  }
}

const agentNameList = [
  ["[to_plannerAgent]", "🤔"],
  ["[to_projectAnalysisAgent]", "🤔"],
  ["[to_projectGenerationAgent]", "🤔"],
  ["[to_boardRecommendationAgent]", "🤨"],
  ["[to_libraryRecommendationAgent]", "🤨"],
  ["[to_arduinoLibraryAnalysisAgent]", "🤔"],
  ["[to_projectCreationAgent]", "😀"],
  ["[to_blocklyGenerationAgent]", "🤔"],
  ["[to_blocklyRepairAgent]", "🤔"],
  ["[to_compilationErrorRepairAgent]", "🤔"],
  ["[to_contextAgent]", "😀"],
  ["[to_libraryInstallationAgent]", "😀"],
  ["[to_fileOperationAgent]", "😁"],
  ["[to_user]", "😉"],
  ["[to_xxx]", "🤖"]
]
