import {
  Component,
  ElementRef,
  Input,
  OnInit,
  OnDestroy,
  OnChanges,
  ViewChild,
  SimpleChanges,
  ChangeDetectorRef,
} from '@angular/core';
// import { ChatService } from '../../services/chat.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
// import { SpeechService } from '../../services/speech.service';
import { CommonModule } from '@angular/common';
import { NzAvatarModule } from 'ng-zorro-antd/avatar';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NzImageModule } from 'ng-zorro-antd/image';
import { FormsModule } from '@angular/forms';
import { AilyDynamicComponentDirective } from '../../directives/aily-dynamic-component.directive';
import { MarkdownPipe, safeBase64Decode } from '../../pipes/markdown.pipe';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../../../services/config.service';

// import { AilyCodingComponent } from '../../../../components/aily-coding/aily-coding.component';

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
export class DialogComponent implements OnInit, OnChanges, OnDestroy {
  @Input() role = 'user';
  @Input() content;
  @Input() doing = false;

  loaded = false;
  safeContent: SafeHtml = '';
  private markdownPipe: MarkdownPipe;
  private lastContentLength = 0; // 跟踪上次处理的内容长度
  private lastProcessedContent = ''; // 跟踪上次处理的完整内容
  private contentList: Array<{ content: string, html: string }> = []; // 切分后的markdown内容列表

  @ViewChild('contentDiv', { static: true }) contentDiv!: ElementRef<HTMLDivElement>;

  constructor(
    private sanitizer: DomSanitizer,
    private cd: ChangeDetectorRef,
    private configService: ConfigService
  ) {
    this.markdownPipe = new MarkdownPipe(this.sanitizer, this.configService);
  }

  ngOnInit(): void {
    // if (this.content) {
    //   this.processContent();
    // }
  }

  ngOnDestroy(): void {
    // 清理内容列表
    this.contentList = [];
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['content'] && this.content) {
      this.processContent();
    }
  }

  private async processContent() {
    // 过滤 think 标签内容，支持实时过滤
    let currentContent = this.filterThinkContent(this.content);
    
    // 对一些常见错误的处理，确保markdown格式正确
    currentContent = this.fixContent(currentContent);

    // 如果内容没有变化，则跳过处理
    if (currentContent === this.lastProcessedContent) {
      return;
    }

    // 处理代理名称替换
    const processedContent = this.replaceAgentNamesInContent(currentContent);

    // 如果是全新的内容或内容长度减少了（可能是重置），则清空并重新渲染
    if (processedContent.length < this.lastContentLength || this.lastProcessedContent === '') {
      // console.log('全新内容渲染');
      await this.resetAndRenderAll(processedContent);
      return;
    }

    // 增量渲染
    // console.log('增量渲染');
    await this.processIncrementalRender(processedContent);

    this.cd.detectChanges();
  }

  /**
   * 重置并重新渲染所有内容
   */
  private async resetAndRenderAll(currentContent: string): Promise<void> {
    this.lastContentLength = 0;
    this.lastProcessedContent = '';
    this.contentList = [];

    if (this.contentDiv?.nativeElement) {
      this.contentDiv.nativeElement.innerHTML = '';
    }

    // 切分markdown内容并渲染
    await this.splitAndRenderContent(currentContent);
  }

  /**
   * 回退到完整重新渲染（错误处理）
   */
  private async fallbackToFullRender(content: string): Promise<void> {
    console.warn('Falling back to full render due to error');

    if (this.contentDiv?.nativeElement) {
      // 如果完全失败，至少显示原始文本
      try {
        await this.splitAndRenderContent(content);
      } catch (fallbackError) {
        console.warn('Even fallback render failed:', fallbackError);
        this.contentDiv.nativeElement.textContent = content;
        this.updateRenderState(content);
      }
    }
  }

  /**
   * 根据markdown格式切分内容
   */
  private splitMarkdownContent(content: string): Array<{ content: string, html: string }> {
    const segments: Array<{ content: string, html: string }> = [];

    if (!content.trim()) {
      return segments;
    }

    // 使用更简单但更可靠的切分方法
    const lines = content.split('\n');
    let currentSegment = '';
    let currentType = '';

    const isCodeBlockStart = (line: string) => line.trim().startsWith('```');
    const isHeading = (line: string) => /^#{1,6}\s/.test(line.trim());
    const isList = (line: string) => /^[ \t]*(?:\d+\.|\*|\+|\-)\s/.test(line);
    const isQuote = (line: string) => /^>\s*/.test(line);
    const isTableRow = (line: string) => /^\|.*\|$/.test(line.trim());
    const isSeparator = (line: string) => /^---+\s*$/.test(line.trim());
    const isEmptyLine = (line: string) => line.trim() === '';

    let inCodeBlock = false;
    let codeBlockLanguage = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // 处理代码块
      if (isCodeBlockStart(line)) {
        if (!inCodeBlock) {
          // 代码块开始
          if (currentSegment.trim()) {
            segments.push({ content: currentSegment.trim(), html: '' });
            currentSegment = '';
          }
          inCodeBlock = true;
          codeBlockLanguage = trimmedLine.substring(3);
          currentSegment = line + '\n';
          currentType = 'code';
        } else {
          // 代码块结束
          currentSegment += line;
          if (currentSegment.trim()) {
            segments.push({ content: currentSegment.trim(), html: '' });
          }
          currentSegment = '';
          inCodeBlock = false;
          currentType = '';
        }
        continue;
      }

      // 在代码块内，直接添加行
      if (inCodeBlock) {
        currentSegment += line + '\n';
        continue;
      }

      // 处理其他结构
      const lineType = this.getLineType(line);

      // 如果类型改变或遇到空行，结束当前段落
      if (lineType !== currentType || (isEmptyLine(line) && currentType !== '')) {
        if (currentSegment.trim()) {
          segments.push({ content: currentSegment.trim(), html: '' });
        }
        currentSegment = '';
        currentType = '';
      }

      // 跳过纯空行（但保留空行在段落内的情况）
      if (isEmptyLine(line) && currentSegment.trim() === '') {
        continue;
      }

      // 开始新的段落或继续当前段落
      if (currentSegment === '') {
        currentType = lineType;
      }

      currentSegment += (currentSegment ? '\n' : '') + line;
    }

    // 添加最后一个段落
    if (currentSegment.trim()) {
      segments.push({ content: currentSegment.trim(), html: '' });
    }

    // 如果没有分割出任何内容，将整个内容作为一个段落
    if (segments.length === 0) {
      segments.push({ content: content, html: '' });
    }

    return segments;
  }

  /**
   * 获取行的类型
   */
  private getLineType(line: string): string {
    const trimmed = line.trim();

    if (/^#{1,6}\s/.test(trimmed)) return 'heading';
    if (/^[ \t]*(?:\d+\.|\*|\+|\-)\s/.test(line)) return 'list';
    if (/^>\s*/.test(line)) return 'quote';
    if (/^\|.*\|$/.test(trimmed)) return 'table';
    if (/^---+\s*$/.test(trimmed)) return 'separator';
    if (trimmed.startsWith('```')) return 'code';

    return 'paragraph';
  }

  /**
   * 切分并渲染内容
   */
  private async splitAndRenderContent(content: string): Promise<void> {
    try {
      // 切分内容
      const segments = this.splitMarkdownContent(content);

      // 为每个段落生成HTML
      for (const segment of segments) {
        const htmlObservable = this.markdownPipe.transform(segment.content);
        const safeHtml = await firstValueFrom(htmlObservable);
        segment.html = this.getHtmlString(safeHtml);
      }

      // 更新内容列表
      this.contentList = segments;

      // 渲染到DOM
      await this.renderContentList();

      // 更新状态
      this.updateRenderState(content);

    } catch (error) {
      console.warn('Error in splitAndRenderContent:', error);
      // 降级处理
      if (this.contentDiv?.nativeElement) {
        this.contentDiv.nativeElement.textContent = content;
      }
      this.updateRenderState(content);
    }
  }

  /**
   * 渲染内容列表到DOM
   */
  private async renderContentList(fromIndex: number = 0): Promise<void> {
    const container = this.contentDiv?.nativeElement;
    if (!container) return;

    // 如果从头开始渲染，清空容器
    if (fromIndex === 0) {
      container.innerHTML = '';
    }

    // 渲染指定范围的段落
    for (let i = fromIndex; i < this.contentList.length; i++) {
      const item = this.contentList[i];
      if (item.html) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = item.html;

        // 将渲染的内容添加到容器
        while (tempDiv.firstChild) {
          container.appendChild(tempDiv.firstChild);
        }
      }
    }
  }

  /**
   * 增量渲染处理
   */
  private async processIncrementalRender(currentContent: string): Promise<void> {
    try {
      // 获取新增的内容
      const newContent = currentContent.slice(this.lastContentLength);

      if (!newContent.trim()) {
        this.updateRenderState(currentContent);
        return;
      }

      // 重新切分整个内容
      const newSegments = this.splitMarkdownContent(currentContent);

      // 比较新旧段落列表，找出差异
      const diff = this.compareContentLists(this.contentList, newSegments);

      if (diff.type === 'append') {
        // 只需要添加新段落
        await this.appendNewSegments(diff.newSegments);
      } else if (diff.type === 'modify_last') {
        // 修改最后一个段落并可能添加新段落
        await this.modifyLastAndAppend(diff.modifiedSegment, diff.newSegments);
      } else {
        // 需要完全重新渲染
        this.contentList = newSegments;
        await this.renderContentListWithDiff(newSegments);
      }

      this.updateRenderState(currentContent);

    } catch (error) {
      console.warn('Error in processIncrementalRender:', error);
      // 降级到完整重新渲染
      await this.splitAndRenderContent(currentContent);
    }
  }

  /**
   * 比较新旧内容列表
   */
  private compareContentLists(oldList: Array<{ content: string, html: string }>, newList: Array<{ content: string, html: string }>): any {
    if (oldList.length === 0) {
      return { type: 'append', newSegments: newList };
    }

    if (newList.length < oldList.length) {
      return { type: 'rerender', segments: newList };
    }

    // 检查现有段落是否有变化
    let lastUnchangedIndex = -1;
    for (let i = 0; i < Math.min(oldList.length, newList.length); i++) {
      if (oldList[i].content === newList[i].content) {
        lastUnchangedIndex = i;
      } else {
        break;
      }
    }

    if (lastUnchangedIndex === oldList.length - 1) {
      // 所有现有段落都没变，只是添加了新段落
      return {
        type: 'append',
        newSegments: newList.slice(oldList.length)
      };
    } else if (lastUnchangedIndex === oldList.length - 2) {
      // 最后一个段落有变化
      return {
        type: 'modify_last',
        modifiedSegment: newList[oldList.length - 1],
        newSegments: newList.slice(oldList.length)
      };
    } else {
      // 需要重新渲染
      return { type: 'rerender', segments: newList };
    }
  }

  /**
   * 添加新段落
   */
  private async appendNewSegments(newSegments: Array<{ content: string, html: string }>): Promise<void> {
    const container = this.contentDiv?.nativeElement;
    if (!container) return;

    for (const segment of newSegments) {
      // 如果HTML还没有生成，先生成HTML
      if (!segment.html) {
        const htmlObservable = this.markdownPipe.transform(segment.content);
        const safeHtml = await firstValueFrom(htmlObservable);
        segment.html = this.getHtmlString(safeHtml);
      }

      // 添加到DOM
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = segment.html;

      while (tempDiv.firstChild) {
        container.appendChild(tempDiv.firstChild);
      }

      // 添加到内容列表
      this.contentList.push(segment);
    }
  }

  /**
   * 修改最后一个段落并添加新段落
   */
  private async modifyLastAndAppend(modifiedSegment: { content: string, html: string }, newSegments: Array<{ content: string, html: string }>): Promise<void> {
    const container = this.contentDiv?.nativeElement;
    if (!container || this.contentList.length === 0) {
      await this.renderContentList();
      return;
    }

    // 生成修改段落的HTML
    const htmlObservable = this.markdownPipe.transform(modifiedSegment.content);
    const safeHtml = await firstValueFrom(htmlObservable);
    modifiedSegment.html = this.getHtmlString(safeHtml);

    // 找到需要替换的最后一个段落对应的DOM元素
    await this.replaceLastSegmentInDOM(modifiedSegment);

    // 更新最后一个段落
    this.contentList[this.contentList.length - 1] = modifiedSegment;

    // 添加新段落
    if (newSegments.length > 0) {
      await this.appendNewSegments(newSegments);
    }
  }

  /**
   * 替换最后一个段落在DOM中的内容
   */
  private async replaceLastSegmentInDOM(modifiedSegment: { content: string, html: string }): Promise<void> {
    const container = this.contentDiv?.nativeElement;
    if (!container || !modifiedSegment.html) return;

    // 记录当前最后一个段落的HTML，以便找到对应的DOM元素
    const lastSegment = this.contentList[this.contentList.length - 1];

    if (!lastSegment || !lastSegment.html) {
      // 如果没有找到最后一个段落，降级到完全重新渲染
      await this.renderContentList();
      return;
    }

    // 检查是否包含 think 组件
    const hasThinkInLast = lastSegment.content.includes('aily-think');
    const hasThinkInModified = modifiedSegment.content.includes('aily-think');

    // 如果最后一个段落和新段落都包含 think 组件，尝试更新现有组件而不是替换DOM
    if (hasThinkInLast && hasThinkInModified) {
      // 查找现有的 think 组件实例（组件创建后，占位符会被替换成组件）
      const thinkComponents = container.querySelectorAll('app-aily-think-viewer');
      if (thinkComponents.length > 0) {
        // 找到最后一个 think 组件（应该对应最后一个段落）
        const lastThinkComponent = thinkComponents[thinkComponents.length - 1];
        
        // 创建临时容器来解析新的HTML，提取 think 占位符数据
        const newTempDiv = document.createElement('div');
        newTempDiv.innerHTML = modifiedSegment.html;
        
        // 查找新HTML中的 think 占位符
        const newPlaceholder = newTempDiv.querySelector('.aily-code-block-placeholder[data-aily-type="aily-think"]') as HTMLElement;
        
        if (newPlaceholder) {
          const encodedData = newPlaceholder.getAttribute('data-aily-data');
          if (encodedData) {
            try {
              // 使用与指令相同的解码方法
              // 先解码 base64，然后解析 JSON
              const decodedData = safeBase64Decode(encodedData);
              const jsonData = JSON.parse(decodedData);
              
              // 如果 content 是编码的，需要进一步解码（与 markdown pipe 的逻辑一致）
              let thinkContent = jsonData.content || jsonData.text || '';
              if (jsonData.encoded && typeof thinkContent === 'string') {
                try {
                  thinkContent = decodeURIComponent(atob(thinkContent));
                } catch (e) {
                  console.warn('Failed to decode think content:', e);
                }
              }
              
              // 构建组件数据（与 markdown pipe 的输出格式一致）
              const componentData = {
                type: 'aily-think',
                content: String(thinkContent),
                isComplete: jsonData.isComplete !== false,
                metadata: jsonData.metadata || {}
              };
              
              // 通过自定义事件通知组件更新
              const updateEvent = new CustomEvent('think-data-update', { 
                detail: componentData,
                bubbles: true 
              });
              lastThinkComponent.dispatchEvent(updateEvent);
              
              // 同时尝试直接设置 data 属性（如果组件支持）
              // 注意：这需要组件暴露 data 属性为 @Input() 或 public
              if ((lastThinkComponent as any).__ngContext__) {
                // Angular 组件，尝试通过上下文访问实例
                const componentInstance = (lastThinkComponent as any).__ngContext__?.[8];
                if (componentInstance && typeof componentInstance.setData === 'function') {
                  componentInstance.setData(componentData);
                }
              }
              
              // 不替换DOM，直接返回
              return;
            } catch (error) {
              console.warn('Failed to update think component directly:', error);
              // 如果直接更新失败，继续执行替换操作
            }
          }
        }
      }
    }

    // 创建临时容器来解析新的HTML
    const newTempDiv = document.createElement('div');
    newTempDiv.innerHTML = modifiedSegment.html;

    // 创建临时容器来解析旧的HTML（用于定位）
    const oldTempDiv = document.createElement('div');
    oldTempDiv.innerHTML = lastSegment.html;

    // 找到容器中最后几个元素，这些可能对应最后一个段落
    const containerChildren = Array.from(container.children);
    const oldElementsCount = oldTempDiv.children.length;
    const newElementsCount = newTempDiv.children.length;

    if (oldElementsCount === 0 && newElementsCount === 0) {
      // 都是纯文本，需要找到最后的文本节点
      await this.replaceLastTextContent(container, modifiedSegment.html);
      return;
    }

    // 移除最后几个元素（对应旧段落）
    const elementsToRemove = containerChildren.slice(-oldElementsCount);
    elementsToRemove.forEach(element => {
      if (element.parentNode === container) {
        container.removeChild(element);
      }
    });

    // 添加新的元素
    while (newTempDiv.firstChild) {
      container.appendChild(newTempDiv.firstChild);
    }
  }

  /**
   * 替换最后的文本内容
   */
  private async replaceLastTextContent(container: HTMLElement, newHtml: string): Promise<void> {
    // 这是一个简化的处理方式，对于复杂情况可能需要更精确的DOM操作
    // 为了避免复杂的文本节点查找，这里使用相对安全的方式

    // 如果新内容包含HTML标签，需要解析
    if (newHtml.includes('<')) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = newHtml;

      // 清除最后的文本节点（如果存在）
      const lastChild = container.lastChild;
      if (lastChild && lastChild.nodeType === Node.TEXT_NODE) {
        container.removeChild(lastChild);
      }

      // 添加新内容
      while (tempDiv.firstChild) {
        container.appendChild(tempDiv.firstChild);
      }
    } else {
      // 纯文本内容，更新最后的文本节点
      const lastChild = container.lastChild;
      if (lastChild && lastChild.nodeType === Node.TEXT_NODE) {
        lastChild.textContent = newHtml;
      } else {
        // 添加新的文本节点
        container.appendChild(document.createTextNode(newHtml));
      }
    }
  }

  /**
   * 带差异的渲染内容列表
   */
  private async renderContentListWithDiff(newSegments: Array<{ content: string, html: string }>): Promise<void> {
    // 找出需要重新渲染的起始位置
    const oldLength = this.contentList.length;
    let startRenderIndex = 0;

    // 找到第一个不同的段落位置
    for (let i = 0; i < Math.min(oldLength, newSegments.length); i++) {
      if (this.contentList[i].content !== newSegments[i].content) {
        startRenderIndex = i;
        break;
      }
    }

    // 如果所有现有内容都相同，只需要渲染新增的部分
    if (startRenderIndex === 0 && oldLength < newSegments.length) {
      startRenderIndex = oldLength;
    }

    // 为需要渲染的新段落生成HTML
    for (let i = startRenderIndex; i < newSegments.length; i++) {
      const segment = newSegments[i];
      if (!segment.html) {
        const htmlObservable = this.markdownPipe.transform(segment.content);
        const safeHtml = await firstValueFrom(htmlObservable);
        segment.html = this.getHtmlString(safeHtml);
      }
    }

    // 如果需要替换现有内容，先移除需要重新渲染的部分
    if (startRenderIndex < oldLength) {
      const container = this.contentDiv?.nativeElement;
      if (container) {
        // 移除从startRenderIndex开始的所有DOM元素
        await this.removeElementsFromIndex(container, startRenderIndex);
      }
    }

    // 更新内容列表
    this.contentList = newSegments;

    // 只渲染需要更新的部分
    await this.renderContentList(startRenderIndex);
  }

  /**
   * 从指定索引开始移除DOM元素
   */
  private async removeElementsFromIndex(container: HTMLElement, fromIndex: number): Promise<void> {
    // 这是一个简化的实现
    // 更精确的实现需要跟踪每个段落对应的DOM元素

    // 计算需要保留的元素数量（近似）
    let elementsToKeep = 0;
    for (let i = 0; i < fromIndex && i < this.contentList.length; i++) {
      const segment = this.contentList[i];
      if (segment.html) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = segment.html;
        elementsToKeep += tempDiv.children.length || 1; // 至少保留1个元素或文本节点
      }
    }

    // 移除多余的元素
    const children = Array.from(container.children);
    for (let i = elementsToKeep; i < children.length; i++) {
      if (children[i] && children[i].parentNode === container) {
        container.removeChild(children[i]);
      }
    }

    // 如果没有子元素但有文本内容，也需要清理
    if (container.children.length === elementsToKeep && elementsToKeep === 0) {
      // 保留前面部分的文本内容
      const allText = container.textContent || '';
      let keepText = '';

      // 这里简化处理，实际情况下需要更精确的文本分割
      if (fromIndex === 0) {
        container.textContent = '';
      }
    }
  }

  /**
   * 更新渲染状态
   */
  private updateRenderState(content: string): void {
    this.lastContentLength = content.length;
    this.lastProcessedContent = content;
    this.loaded = true;
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
      // 如果 ``` 后面跟的是 aily 类型，说明这是开始符号，不需要换行
      const isAilyStart = ailyTypes.some(type => afterBackticks.startsWith(type));

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


  test() {
    console.log('原始内容:', this.content);
    console.log('内容列表:', this.contentList);
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