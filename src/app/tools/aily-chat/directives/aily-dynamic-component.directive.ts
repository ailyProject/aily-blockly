import {
  Directive,
  ElementRef,
  Input,
  OnInit,
  OnDestroy,
  ViewContainerRef,
  ComponentRef,
  Injector,
  Type
} from '@angular/core';
import { AilyBlocklyViewerComponent } from '../components/aily-blockly-viewer/aily-blockly-viewer.component';
import { AilyBoardViewerComponent } from '../components/aily-board-viewer/aily-board-viewer.component';
import { AilyLibraryViewerComponent } from '../components/aily-library-viewer/aily-library-viewer.component';
import { AilyStateViewerComponent } from '../components/aily-state-viewer/aily-state-viewer.component';
import { AilyButtonViewerComponent } from '../components/aily-button-viewer/aily-button-viewer.component';
import { AilyErrorViewerComponent } from '../components/aily-error-viewer/aily-error-viewer.component';
import { AilyMermaidViewerComponent } from '../components/aily-mermaid-viewer/aily-mermaid-viewer.component';
import { safeBase64Decode } from '../pipes/markdown.pipe';

/**
 * 动态组件指令 - 用于在 DOM 中查找 Aily 组件占位符并替换为真正的 Angular 组件
 */
@Directive({
  selector: '[ailyDynamicComponent]',
  standalone: true
})
export class AilyDynamicComponentDirective implements OnInit, OnDestroy {
  private componentRefs: ComponentRef<any>[] = [];
  private observer: MutationObserver | null = null;
  private processedPlaceholders = new Set<string>(); // 记录已处理的占位符

  constructor(
    private elementRef: ElementRef,
    private viewContainerRef: ViewContainerRef,
    private injector: Injector
  ) { }

  ngOnInit() {
    // 初始化时扫描一次
    this.scanAndReplaceComponents();

    // 监听 DOM 变化，当新的内容被插入时自动扫描
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      const newPlaceholders = new Set<HTMLElement>();
      
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          // 检查是否有新的占位符被添加
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element;
              
              // 检查元素本身是否是占位符
              if (element.classList?.contains('aily-code-block-placeholder')) {
                const placeholderKey = this.generatePlaceholderKey(element as HTMLElement);
                if (!this.processedPlaceholders.has(placeholderKey)) {
                  newPlaceholders.add(element as HTMLElement);
                  shouldScan = true;
                }
              }
              
              // 检查元素内部是否包含占位符
              const innerPlaceholders = element.querySelectorAll?.('.aily-code-block-placeholder');
              if (innerPlaceholders && innerPlaceholders.length > 0) {
                innerPlaceholders.forEach((placeholder) => {
                  const placeholderKey = this.generatePlaceholderKey(placeholder as HTMLElement);
                  if (!this.processedPlaceholders.has(placeholderKey)) {
                    newPlaceholders.add(placeholder as HTMLElement);
                    shouldScan = true;
                  }
                });
              }
            }
          });
        }
      });

      if (shouldScan) {
        // 只处理新发现的占位符，而不是全部重新扫描
        setTimeout(() => this.processNewPlaceholders(newPlaceholders), 0);
      }
    });

    this.observer.observe(this.elementRef.nativeElement, {
      childList: true,
      subtree: true
    });
  }

  ngOnDestroy() {
    // 清理组件引用
    this.componentRefs.forEach(ref => ref.destroy());
    this.componentRefs = [];

    // 清理已处理占位符记录
    this.processedPlaceholders.clear();

    // 停止监听 DOM 变化
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  /**
   * 处理新发现的占位符（优化版本，只处理新的占位符）
   */
  private processNewPlaceholders(newPlaceholders: Set<HTMLElement>): void {
    newPlaceholders.forEach((placeholder: HTMLElement) => {
      // 生成占位符的唯一标识
      const placeholderKey = this.generatePlaceholderKey(placeholder);
      
      // 再次检查是否已经处理过这个占位符（双重保险）
      if (this.processedPlaceholders.has(placeholderKey)) {
        return; // 跳过已处理的占位符
      }

      try {
        this.replacePlaceholderWithComponent(placeholder);
        // 标记为已处理
        this.processedPlaceholders.add(placeholderKey);
      } catch (error) {
        console.warn('Error replacing placeholder with component:', error);
        this.showErrorPlaceholder(placeholder, error);
        // 即使出错也标记为已处理，避免重复尝试
        this.processedPlaceholders.add(placeholderKey);
      }
    });
  }

  /**
   * 扫描并替换组件占位符
   */
  private scanAndReplaceComponents(): void {
    const placeholders = this.elementRef.nativeElement.querySelectorAll('.aily-code-block-placeholder');

    placeholders.forEach((placeholder: HTMLElement) => {
      // 生成占位符的唯一标识
      const placeholderKey = this.generatePlaceholderKey(placeholder);
      
      // 检查是否已经处理过这个占位符
      if (this.processedPlaceholders.has(placeholderKey)) {
        return; // 跳过已处理的占位符
      }

      try {
        this.replacePlaceholderWithComponent(placeholder);
        // 标记为已处理
        this.processedPlaceholders.add(placeholderKey);
      } catch (error) {
        console.warn('Error replacing placeholder with component:', error);
        this.showErrorPlaceholder(placeholder, error);
        // 即使出错也标记为已处理，避免重复尝试
        this.processedPlaceholders.add(placeholderKey);
      }
    });
  }

  /**
   * 生成占位符的唯一标识
   */
  private generatePlaceholderKey(placeholder: HTMLElement): string {
    const ailyType = placeholder.getAttribute('data-aily-type');
    const encodedData = placeholder.getAttribute('data-aily-data');
    const componentId = placeholder.getAttribute('data-component-id');
    
    // 使用类型、数据和ID生成唯一键，如果没有ID则使用数据的哈希
    const baseKey = `${ailyType}-${componentId || encodedData || ''}`;
    
    // 如果有具体的位置信息，也加入到键中
    const position = this.getElementPosition(placeholder);
    return `${baseKey}-${position}`;
  }

  /**
   * 获取元素在DOM中的位置信息
   */
  private getElementPosition(element: HTMLElement): string {
    let position = '';
    let current = element;
    
    while (current && current !== this.elementRef.nativeElement) {
      const parent = current.parentElement;
      if (parent) {
        const index = Array.from(parent.children).indexOf(current);
        position = index + '-' + position;
      }
      current = parent;
    }
    
    return position || '0';
  }

  /**
   * 替换占位符为真正的组件
   */
  private replacePlaceholderWithComponent(placeholder: HTMLElement): void {
    const ailyType = placeholder.getAttribute('data-aily-type');
    const encodedData = placeholder.getAttribute('data-aily-data');
    const componentId = placeholder.getAttribute('data-component-id');

    if (!ailyType) {
      throw new Error('Missing aily-type attribute');
    }

    if (!encodedData) {
      throw new Error('Missing aily-data attribute');
    }

    // 解码数据
    let componentData;
    try {
      const decodedData = safeBase64Decode(encodedData);
      componentData = JSON.parse(decodedData);
    } catch (error) {
      throw new Error(`Failed to decode component data: ${error.message}`);
    }

    // 检查是否已存在相同的组件（适用于所有组件类型）
    const existingComponent = this.findExistingComponent(ailyType, componentId, componentData);
    if (existingComponent) {
      // 更新现有组件数据
      this.updateExistingComponent(existingComponent, componentData);
      // 移除占位符
      this.removePlaceholder(placeholder);
      return;
    }

    // 获取对应的组件类型
    const ComponentType = this.getComponentType(ailyType);
    if (!ComponentType) {
      throw new Error(`Unknown component type: ${ailyType}`);
    }

    // 创建组件容器
    const componentContainer = document.createElement('div');
    componentContainer.className = `aily-component-container ${ailyType}-container`;
    componentContainer.setAttribute('data-component-id', componentId || '');
    componentContainer.setAttribute('data-aily-type', ailyType);

    // 为不同类型的组件设置特定的标识属性
    if (ailyType === 'aily-state' && componentData.id) {
      componentContainer.setAttribute('data-state-id', componentData.id);
    } else if (componentId) {
      componentContainer.setAttribute('data-unique-id', componentId);
    }

    // 创建 Angular 组件
    const componentRef = this.viewContainerRef.createComponent(ComponentType, {
      injector: this.injector
    });

    // 设置组件数据
    if (componentRef.instance && typeof componentRef.instance.setData === 'function') {
      componentRef.instance.setData(componentData);
    } else if (componentRef.instance) {
      // 尝试直接设置 data 属性
      (componentRef.instance as any).data = componentData;
    }

    // 将组件插入到容器中
    componentContainer.appendChild(componentRef.location.nativeElement);

    // 替换占位符
    placeholder.parentNode?.replaceChild(componentContainer, placeholder);

    // 保存组件引用以便后续清理
    this.componentRefs.push(componentRef);

    console.log(`Successfully created ${ailyType} component:`, componentData);
  }

  /**
   * 移除占位符
   */
  private removePlaceholder(placeholder: HTMLElement): void {
    try {
      // 尝试移除占位符的父级元素，如果失败则移除占位符本身
      if (placeholder.parentElement?.parentElement && 
          placeholder.parentElement.children.length === 1) {
        placeholder.parentElement.parentElement.remove();
      } else {
        placeholder.remove();
      }
    } catch (e) {
      console.warn('Error removing placeholder:', e);
      // 最后的兜底方案
      try {
        placeholder.style.display = 'none';
      } catch (hideError) {
        console.warn('Error hiding placeholder:', hideError);
      }
    }
  }

  /**
   * 获取组件类型
   */
  private getComponentType(ailyType: string): Type<any> | null {
    switch (ailyType) {
      case 'aily-blockly':
        return AilyBlocklyViewerComponent;
      case 'aily-board':
        return AilyBoardViewerComponent;
      case 'aily-library':
        return AilyLibraryViewerComponent;
      case 'aily-state':
        return AilyStateViewerComponent;
      case 'aily-button':
        return AilyButtonViewerComponent;
      case 'aily-error':
        return AilyErrorViewerComponent;
      case 'aily-mermaid':
        return AilyMermaidViewerComponent;
      default:
        return null;
    }
  }

  /**
   * 显示错误占位符
   */
  private showErrorPlaceholder(placeholder: HTMLElement, error: any): void {
    const errorContainer = document.createElement('div');
    errorContainer.className = 'aily-component-error';
    errorContainer.innerHTML = `
      <div class="error-header">
        <span class="error-icon">⚠️</span>
        <span class="error-title">组件加载失败</span>
      </div>
      <div class="error-message">${error.message || '未知错误'}</div>
      <div class="error-details">
        <small>类型: ${placeholder.getAttribute('data-aily-type') || 'unknown'}</small>
      </div>
    `;

    // 添加错误样式
    errorContainer.style.cssText = `
      border: 1px solid #ff6b6b;
      border-radius: 4px;
      padding: 12px;
      margin: 8px 0;
      background-color: #fff5f5;
      color: #c53030;
    `;

    placeholder.parentNode?.replaceChild(errorContainer, placeholder);
  }

  /**
   * 查找已存在的组件（通用方法）
   */
  private findExistingComponent(ailyType: string, componentId: string | null, componentData: any): { container: HTMLElement, componentRef: ComponentRef<any> } | null {
    // 对于 aily-state 组件，使用原有的查找逻辑
    if (ailyType === 'aily-state' && componentData.id) {
      return this.findExistingStateComponent(componentData.id);
    }

    // 对于其他组件类型，根据 component-id 查找
    if (componentId) {
      const existingContainer = this.elementRef.nativeElement.querySelector(
        `.${ailyType}-container[data-component-id="${componentId}"]`
      ) as HTMLElement;

      if (!existingContainer) {
        return null;
      }

      // 查找对应的组件引用
      const componentRef = this.componentRefs.find(ref => {
        return existingContainer.contains(ref.location.nativeElement);
      });

      if (!componentRef) {
        return null;
      }

      return {
        container: existingContainer,
        componentRef: componentRef
      };
    }

    return null;
  }

  /**
   * 查找已存在的 aily-state 组件
   */
  private findExistingStateComponent(stateId: string): { container: HTMLElement, componentRef: ComponentRef<any> } | null {
    // 在 DOM 中查找具有相同 state-id 的容器
    const existingContainer = this.elementRef.nativeElement.querySelector(
      `.aily-state-container[data-state-id="${stateId}"]`
    ) as HTMLElement;

    if (!existingContainer) {
      return null;
    }

    // 查找对应的组件引用
    const componentRef = this.componentRefs.find(ref => {
      // 检查组件的 DOM 元素是否在找到的容器中
      return existingContainer.contains(ref.location.nativeElement);
    });

    if (!componentRef) {
      return null;
    }

    return {
      container: existingContainer,
      componentRef: componentRef
    };
  }

  /**
   * 更新现有组件的数据
   */
  private updateExistingComponent(existingComponent: { container: HTMLElement, componentRef: ComponentRef<any> }, newData: any): void {
    const { componentRef } = existingComponent;

    // 更新组件数据
    if (componentRef.instance && typeof componentRef.instance.setData === 'function') {
      componentRef.instance.setData(newData);
    } else if (componentRef.instance) {
      // 尝试直接设置 data 属性
      (componentRef.instance as any).data = newData;

      // 如果组件有 processData 方法，调用它来重新处理数据
      if (typeof (componentRef.instance as any).processData === 'function') {
        (componentRef.instance as any).processData();
      }
    }

    // 触发变更检测
    componentRef.changeDetectorRef.detectChanges();
  }
}
