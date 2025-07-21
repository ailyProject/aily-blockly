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
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          // 检查是否有新的占位符被添加
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element;
              if (element.querySelector?.('.aily-code-block-placeholder') ||
                element.classList?.contains('aily-code-block-placeholder')) {
                shouldScan = true;
              }
            }
          });
        }
      });

      if (shouldScan) {
        setTimeout(() => this.scanAndReplaceComponents(), 0);
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

    // 停止监听 DOM 变化
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  /**
   * 扫描并替换组件占位符
   */
  private scanAndReplaceComponents(): void {
    const placeholders = this.elementRef.nativeElement.querySelectorAll('.aily-code-block-placeholder');

    placeholders.forEach((placeholder: HTMLElement) => {
      try {
        this.replacePlaceholderWithComponent(placeholder);
      } catch (error) {
        console.error('Error replacing placeholder with component:', error);
        this.showErrorPlaceholder(placeholder, error);
      }
    });
  }  /**
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

    // 对于 aily-state 组件，检查是否已存在相同 ID 的组件
    if (ailyType === 'aily-state' && componentData.id) {
      console.log('查找现有的 aily-state 组件:', componentData.id);
      const existingComponent = this.findExistingStateComponent(componentData.id);
      if (existingComponent) {
        console.log('组件已存在, 更新数据:', componentData.id);        // 更新现有组件数据
        this.updateExistingComponent(existingComponent, componentData);
        // 移除占位符的父级元素
        try {
          placeholder.parentElement?.parentElement?.remove();
        } catch (e) {
          console.error('Error removing placeholder parent element:', e);
        }
        return;
      }
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

    // 对于 aily-state 组件，设置 ID 属性以便后续查找
    if (ailyType === 'aily-state' && componentData.id) {
      componentContainer.setAttribute('data-state-id', componentData.id);
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
  }/**
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
