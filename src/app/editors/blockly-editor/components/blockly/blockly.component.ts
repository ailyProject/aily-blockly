import { Component, ElementRef, Input, ViewChild, DoCheck, OnDestroy } from '@angular/core';
import * as Blockly from 'blockly';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';

// Blockly 多语言包
import * as zhHans from 'blockly/msg/zh-hans';
import * as zhHant from 'blockly/msg/zh-hant';
import * as en from 'blockly/msg/en';
import * as ja from 'blockly/msg/ja';
import * as ko from 'blockly/msg/ko';
import * as de from 'blockly/msg/de';
import * as fr from 'blockly/msg/fr';
import * as es from 'blockly/msg/es';
import * as pt from 'blockly/msg/pt';
import * as ru from 'blockly/msg/ru';
import * as ar from 'blockly/msg/ar';

// 语言代码到 Blockly 语言包的映射
const BLOCKLY_LOCALES: { [key: string]: any } = {
  'zh_cn': zhHans,
  'zh_hk': zhHant,
  'zh-hans': zhHans,
  'zh-hant': zhHant,
  'en': en,
  'ja': ja,
  'ko': ko,
  'de': de,
  'fr': fr,
  'es': es,
  'pt': pt,
  'ru': ru,
  'ar': ar,
};
// import {
//   ContinuousToolbox,
//   ContinuousFlyout,
//   ContinuousMetrics,
// } from './plugins/continuous-toolbox/src/index.js';
import './plugins/toolbox-search/src/index';
import './plugins/block-plus-minus/src/index.js';
import { arduinoGenerator } from './generators/arduino/arduino';
import { micropythonGenerator } from './generators/micropython/micropython';
import { BlocklyService } from '../../services/blockly.service';
import { convertAbiToAbsWithLineMap } from '../../../../tools/aily-chat/tools/abiAbsConverter';
import { BitmapUploadResponse, GlobalServiceManager } from '../../services/bitmap-upload.service';

import './renderer/aily-icon';
import './renderer/aily-thrasos/thrasos';
import './renderer/aily-zelos/zelos';
import './custom-category';
import './custom-field/field-bitmap';
import './custom-field/field-bitmap-u8g2';
import './custom-field/field-image';
import './custom-field/field-image-preview';
import './custom-field/field-led-matrix';
import './custom-field/field-led-pattern-selector';
import './custom-field/field-tone';
import './custom-field/field-multilineinput';
import './custom-field/field-slider';
import './custom-field/field-angle180';
import './custom-field/field-angle';
import '@blockly/field-colour-hsv-sliders';

import { Multiselect } from './plugins/workspace-multiselect/index.js';
import { PromptDialogComponent } from './components/prompt-dialog/prompt-dialog.component.js';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import * as BlockDynamicConnection from '@blockly/block-dynamic-connection';
import { CommonModule } from '@angular/common';
import { BitmapUploadService } from '../../services/bitmap-upload.service';
import { ImageUploadDialogComponent } from './components/image-upload-dialog/image-upload-dialog.component';
import { HttpErrorResponse } from '@angular/common/http';
import { ConfigService } from '../../../../services/config.service';
import { NoticeService } from '../../../../services/notice.service';
import { Minimap } from '@blockly/workspace-minimap';
import { DarkTheme } from './theme.config';

class OverlayFlyoutMetricsManager extends (Blockly as any).MetricsManager {
  constructor(workspace: any) {
    super(workspace);
  }

  getViewMetrics(getWorkspaceCoordinates: boolean | undefined = undefined) {
    const workspace = (this as any).workspace_;
    const scale = getWorkspaceCoordinates ? workspace.scale : 1;
    const svgMetrics = (this as any).getSvgMetrics();
    const toolboxMetrics = (this as any).getToolboxMetrics();
    const toolboxPosition = toolboxMetrics.position;

    if (workspace.getToolbox?.()) {
      if (
        toolboxPosition == (Blockly as any).TOOLBOX_AT_TOP ||
        toolboxPosition == (Blockly as any).TOOLBOX_AT_BOTTOM
      ) {
        svgMetrics.height -= toolboxMetrics.height;
      } else if (
        toolboxPosition == (Blockly as any).TOOLBOX_AT_LEFT ||
        toolboxPosition == (Blockly as any).TOOLBOX_AT_RIGHT
      ) {
        svgMetrics.width -= toolboxMetrics.width;
      }
    }

    return {
      height: svgMetrics.height / scale,
      width: svgMetrics.width / scale,
      top: -workspace.scrollY / scale,
      left: -workspace.scrollX / scale,
    };
  }

  getAbsoluteMetrics() {
    const workspace = (this as any).workspace_;
    const toolboxMetrics = (this as any).getToolboxMetrics();
    const toolboxPosition = toolboxMetrics.position;

    let absoluteLeft = 0;
    if (workspace.getToolbox?.() && toolboxPosition == (Blockly as any).TOOLBOX_AT_LEFT) {
      absoluteLeft = toolboxMetrics.width;
    }

    let absoluteTop = 0;
    if (workspace.getToolbox?.() && toolboxPosition == (Blockly as any).TOOLBOX_AT_TOP) {
      absoluteTop = toolboxMetrics.height;
    }

    return {
      top: absoluteTop,
      left: absoluteLeft,
    };
  }
}

@Component({
  selector: 'blockly-main',
  imports: [
    NzModalModule,
    CommonModule,
  ],
  templateUrl: './blockly.component.html',
  styleUrl: './blockly.component.scss',
})
export class BlocklyComponent implements DoCheck, OnDestroy {
  @ViewChild('blocklyDiv', { static: true }) blocklyDiv!: ElementRef;

  @Input() devmode;
  generator;

  // RxJS debounce optimization
  private codeGenerationSubject = new Subject<void>();
  private minimapSyncSubject = new Subject<void>();
  private destroy$ = new Subject<void>();
  private minimap: Minimap | null = null;
  // Track previous #include and #define for dependency change detection
  private previousDependencies = '';
  // Control bitmap upload handler visibility
  showBitmapUploadHandler = true;

  get aiWriting() {
    return this.blocklyService.aiWriting || this.blocklyService.aiWaitWriting;
  }

  showSpinOverlay = false;
  isFadingOut = false;
  private previousAiWriting = false;

  get workspace() {
    return this.blocklyService.workspace;
  }

  set workspace(workspace) {
    this.blocklyService.workspace = workspace;
  }

  get toolbox() {
    return this.blocklyService.toolbox;
  }

  set toolbox(toolbox) {
    this.blocklyService.toolbox = toolbox;
  }

  get draggingBlock() {
    return this.blocklyService.draggingBlock;
  }

  set draggingBlock(draggingBlock: any) {
    this.blocklyService.draggingBlock = draggingBlock;
  }

  get offsetX() {
    return this.blocklyService.offsetX;
  }

  get offsetY() {
    return this.blocklyService.offsetY;
  }

  options = {
    flyout: 'overlay',
    toolbox: {
      kind: 'categoryToolbox',
      contents: [],
    },
    // plugins: {
    //   toolbox: ContinuousToolbox,
    //   flyoutsVerticalToolbox: ContinuousFlyout,
    //   metricsManager: ContinuousMetrics,
    // },
    // theme: Blockly.Theme.defineTheme('zelos', DEV_THEME),
    theme: DarkTheme,
    renderer: 'thrasos',
    trashcan: true,
    grid: {
      spacing: 20, // 网格间距为20像素
      length: 2, // 网格点的大小
      colour: '#393939',
      snap: true,
    },
    media: 'blockly/media',
    zoom: {
      controls: false,  // 不显示缩放控制按钮
      wheel: true,      // 启用鼠标滚轮缩放
      startScale: 1,  // 初始缩放比例
      maxScale: 1.5,      // 最大缩放比例
      minScale: 0.5,    // 最小缩放比例
      scaleSpeed: 1.05,  // 缩放速度
    },
    multiselectIcon: {
      hideIcon: true
    },
    multiSelectKeys: ['Shift'],
    plugins: {
      metricsManager: OverlayFlyoutMetricsManager,
      connectionPreviewer:
        BlockDynamicConnection.decoratePreviewer(
          Blockly.InsertionMarkerPreviewer,
        ),
    },
  }

  get configData() {
    return this.configService.data;
  }

  constructor(
    private blocklyService: BlocklyService,
    private modal: NzModalService,
    private configService: ConfigService,
    private bitmapUploadService: BitmapUploadService,
    private noticeService: NoticeService,
    private translateService: TranslateService
  ) {
    // Initialize GlobalServiceManager with BitmapUploadService
    const globalServiceManager = GlobalServiceManager.getInstance();
    globalServiceManager.setBitmapUploadService(this.bitmapUploadService);

    // 订阅语言变化事件
    this.translateService.onLangChange
      .pipe(takeUntil(this.destroy$))
      .subscribe((event) => {
        this.updateBlocklyLocale(event.lang);
      });
  }

  ngOnInit(): void {
    this.initDevMode();
    this.initPrompt();
    this.initCodeGenerationDebounce();
    this.initMinimapSyncDebounce();
    this.bitmapUploadService.uploadRequestSubject.subscribe((request) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzContent: ImageUploadDialogComponent,
        nzData: {
          request: request
        },
        nzWidth: '650px',
      });      // 处理弹窗关闭事件
      modalRef.afterClose.subscribe((result) => {
        if (result && result.bitmapArray) {
          console.log('接收到处理后的bitmap数据:', result);
          // 发送处理结果回field
          const response: BitmapUploadResponse = {
            fieldId: request.fieldId,  // 添加字段ID
            data: result,
            success: true,
            // message: '图片处理成功',
            // timestamp: Date.now()
          };

          this.bitmapUploadService.sendUploadResponse(response);
        }
      });
    });
  }

  ngOnDestroy(): void {
    // 清理 RxJS 订阅
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngDoCheck(): void {
    const currentAiWriting = this.aiWriting;

    if (!this.previousAiWriting && currentAiWriting) {
      this.isFadingOut = false;
      this.showSpinOverlay = true;
    }

    if (this.previousAiWriting && !currentAiWriting) {
      this.isFadingOut = true;
      setTimeout(() => {
        this.showSpinOverlay = false;
        this.isFadingOut = false;
      }, 300);
    }

    this.previousAiWriting = currentAiWriting;
  }

  ngAfterViewInit(): void {
    // this.blocklyService.init();
    setTimeout(async () => {
      // 禁用blockly的警告
      console.warn = (function (originalWarn) {
        return function (msg) {
          // 过滤掉块重定义的警告
          if (msg.includes('overwrites previous definition')) {
            return;
          }
          if (msg.includes('CodeGenerator init was not called before blockToCode was called.')) {
            return;
          }
          // 保留其他警告
          originalWarn.apply(console, arguments);
        };
      })(console.warn);
      // 添加递归保护标志，防止无限递归调用
      let isHandlingError = false;
      console.error = ((originalError) => {
        return (message, ...args) => {
          // 防止递归调用
          if (isHandlingError) {
            originalError.apply(console, [message, ...args]);
            return;
          }

          isHandlingError = true;
          try {
            console.log(message, ...args);
            // 保留原始错误输出功能
            originalError.apply(console, arguments);
            // 处理特定错误
            if (args[0] instanceof HttpErrorResponse) {
              // console.log('HTTP错误:', args[0]);
              return;
            }
            let errorMessage = message + '   ' + args.join('\n');

            // 常见错误1：Invalid block definition
            let title = message;
            let text = args.join('\n');
            if (errorMessage.includes('Invalid block definition')) {
              title = '无效的块定义';
            }
            if (errorMessage.includes('Invalid default type')) {
              title = '无效的默认类型';
            }
            if (text.startsWith("TypeError: ")) {
              text = text.substring("TypeError: ".length);
            }
            this.noticeService.update({
              title,
              text,
              detail: errorMessage,
              state: 'error',
              setTimeout: 99000,
            });
          } finally {
            isHandlingError = false;
          }
        };
      })(console.error);

      // 根据当前语言设置 Blockly locale
      const currentLang = this.translateService.currentLang || 'zh_cn';
      const locale = BLOCKLY_LOCALES[currentLang] || BLOCKLY_LOCALES['en'] || zhHans;
      Blockly.setLocale(locale);
      
      // 在工作区创建前设置 block registry 拦截
      this.setupBlockRegistryInterception();
      // 获取当前blockly渲染器
      this.options.renderer = this.configData.blockly.renderer ? ('aily-' + this.configData.blockly.renderer) : 'thrasos';

      this.workspace = Blockly.inject('blocklyDiv', this.options);

      // 根据配置决定 flyout 拖出 block 后是否自动关闭。
      // 这里直接改 workspace 的 flyout 实例，避免替换 Flyout 类导致布局变化（挤占工作区）。
      if (this.configData.blockly.flyoutAutoClose === false) {
        const flyout = this.workspace.getFlyout?.();
        if (flyout) {
          (flyout as any).autoClose = false;

          // Flyout 显隐会影响 metrics，但不会触发容器尺寸变化；这里在 show/hide 时补一次 svgResize。
          // 避免手动关闭 flyout 后工作区仍保持“被挤占”的旧 metrics。
          if (!(flyout as any).__resizePatched) {
            (flyout as any).__resizePatched = true;

            const tryResize = () => {
              // 延迟到下一帧，确保 flyout 的 DOM 已更新。
              setTimeout(() => Blockly.svgResize(this.workspace), 0);
            };

            const originalShow = (flyout as any).show?.bind(flyout);
            if (originalShow) {
              (flyout as any).show = (...args: any[]) => {
                const result = originalShow(...args);
                tryResize();
                return result;
              };
            }

            const originalHide = (flyout as any).hide?.bind(flyout);
            if (originalHide) {
              (flyout as any).hide = (...args: any[]) => {
                const result = originalHide(...args);
                tryResize();
                return result;
              };
            }
          }
        }
      }

      const multiselectPlugin = new Multiselect(this.workspace);
      multiselectPlugin.init(this.options);

      if (this.configData.blockly.minimap) {
        this.minimap = new Minimap(this.workspace);
        this.minimap.init();
      }

      // 动态连接块监听
      this.workspace.addChangeListener(BlockDynamicConnection.finalizeConnections);

      // 监听容器尺寸变化，刷新Blockly工作区
      const resizeObserver = new ResizeObserver(() => {
        Blockly.svgResize(this.workspace);
      });
      resizeObserver.observe(this.blocklyDiv.nativeElement);

      (window as any)['Blockly'] = Blockly;
      // 设置全局工作区引用，供 editBlockTool 使用
      (window as any)['blocklyWorkspace'] = this.workspace;
      this.workspace.addChangeListener((event: any) => {
        this.codeGenerationSubject.next();
        // 工作区变更时同步 Minimap（含 AI 批量修改 blocks 的场景）
        this.minimapSyncSubject.next();

        // 监听 block 选中事件，更新 selectedBlockSubject
        if (event.type === Blockly.Events.SELECTED) {
          this.blocklyService.selectedBlockSubject.next(event.newElementId || null);
        }
      });
      this.initLanguage();
    }, 100);
  }

  initDevMode() {
    console.log('DEV MODE: ', this.devmode);

    switch (this.devmode) {
      case 'arduino':
        window['Arduino'] = <any>arduinoGenerator;
        this.generator = arduinoGenerator;
        break;
      case 'micropython':
        window['MicropPython'] = <any>micropythonGenerator;
        window['MPY'] = <any>micropythonGenerator;
        this.generator = micropythonGenerator;
        break;
      default:
        break;
    }
  }

  initPrompt() {
    Blockly.dialog.setPrompt((message, defaultValue, callback) => {
      // console.log('对话框初始化，消息:', message, '默认值:', defaultValue);
      this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '300px',
        nzContent: PromptDialogComponent,
        nzOnOk: (e) => {
          callback(e.value);
        },
        nzOnCancel: () => {
          console.log('cancel');
        },
        nzData: {
          title: message
        }
      });
    });
  }

  initLanguage() {
    // 根据当前语言设置 Blockly locale
    const currentLang = this.translateService.currentLang || 'zh_cn';
    this.updateBlocklyLocale(currentLang);
  }

  /**
   * 更新 Blockly 的语言设置
   * @param lang 语言代码，如 'zh_cn', 'en' 等
   */
  updateBlocklyLocale(lang: string) {
    // 获取对应的 Blockly 语言包
    const locale = BLOCKLY_LOCALES[lang] || BLOCKLY_LOCALES['en'] || zhHans;
    
    // 设置 Blockly locale
    Blockly.setLocale(locale);
    
    // 设置自定义消息（覆盖或补充）
    Blockly.Msg["CROSS_TAB_COPY"] = this.translateService.instant('BLOCKLY.CROSS_TAB_COPY') || "复制到指定位置";
    
    // 自定义扩展的多语言消息（switch-case 等）
    Blockly.Msg["CONTROLS_SWITCH_CASE"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_CASE') || (lang.startsWith('zh') ? "情况" : "case");
    Blockly.Msg["CONTROLS_SWITCH_DO"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_DO') || (lang.startsWith('zh') ? "执行" : "do");
    Blockly.Msg["CONTROLS_SWITCH_DEFAULT"] = this.translateService.instant('BLOCKLY.CONTROLS_SWITCH_DEFAULT') || (lang.startsWith('zh') ? "默认执行" : "default");
    
    // 如果工作区已存在，刷新工具箱以应用新语言
    if (this.workspace) {
      try {
        // 刷新工具箱
        this.workspace.refreshToolboxSelection();
        
        // 重新渲染所有块以更新显示文本
        const blocks = this.workspace.getAllBlocks(false);
        blocks.forEach((block: any) => {
          if (block.rendered) {
            block.initSvg();
            block.render();
          }
        });
      } catch (e) {
        console.warn('刷新 Blockly 工作区语言时出错:', e);
      }
    }
  }

  setupBlockRegistryInterception(): void {
    const originalGetClass = Blockly.registry.getClass;

    Blockly.registry.getClass = function (type: string, name: string, opt_throwIfMissing?: boolean) {

      // 对于未注册的 block，也可以在这里处理
      try {
        return originalGetClass.call(Blockly.registry, type, name, opt_throwIfMissing);
      } catch (error) {
        if (type === Blockly.registry.Type.name) {
          console.log(`Block 类型 "${name}" 未注册`);
          this.showBlockRestrictionMessage(name);
          return null;
        }
        throw error;
      }
    }.bind(this);
  }


  /**
   * 初始化 Minimap 同步防抖
   * 工作区变更时（含 AI 批量修改）同步更新 Minimap，避免小地图不刷新
   */
  private initMinimapSyncDebounce(): void {
    this.minimapSyncSubject.pipe(
      debounceTime(300),
      takeUntil(this.destroy$)
    ).subscribe(() => this.syncMinimap());
  }

  /**
   * 将主工作区状态全量同步到 Minimap
   * 使用 Xml 路径加载，避免 serialization.load 触发的 BLOCK_MOVE 事件导致 "block could not be found" 错误
   */
  private syncMinimap(): void {
    const m = this.minimap as any;
    if (!m?.minimapWorkspace || !this.workspace) return;
    try {
      const xml = Blockly.Xml.workspaceToDom(this.workspace, true);
      m.minimapWorkspace.clear();
      Blockly.Xml.domToWorkspace(xml, m.minimapWorkspace);
      Blockly.renderManagement.finishQueuedRenders().then(() => {
        if (m.minimapWorkspace) m.minimapWorkspace.zoomToFit();
      });
    } catch (e) {
      console.warn('[Blockly] Minimap sync failed:', e);
    }
  }

  /**
   * 初始化代码生成的防抖订阅
   * 使用 RxJS debounceTime 实现防抖，更优雅且自动管理订阅生命周期
   */
  private initCodeGenerationDebounce(): void {
    this.codeGenerationSubject.pipe(
      debounceTime(500),
      takeUntil(this.destroy$)
    ).subscribe(() => {
      try {
        const code = this.generator.workspaceToCode(this.workspace);
        this.blocklyService.codeSubject.next(code);

        // 发布 block-to-code 映射
        if (this.generator.blockCodeMap) {
          this.blocklyService.blockCodeMapSubject.next(
            new Map(this.generator.blockCodeMap)
          );
          // 工作区变更后更新 ABS 行号映射（与用户下次导出 ABS 时的行号一致）
          this.updateAbsBlockLineMap();
        }

        // Extract #include and #define, check for changes
        const currentDependencies = this.extractDependencies(code);
        if (currentDependencies !== this.previousDependencies) {
          console.log('currentDependencies: ', currentDependencies);
          this.blocklyService.dependencySubject.next(currentDependencies);
          this.previousDependencies = currentDependencies;
        }
      } catch (error) {
        console.error('Code generation error:', error);
      }
    });
  }

  /**
   * Extract #include and #define from code
   */
  private extractDependencies(code: string): string {
    const lines = code.split('\n');
    const dependencies = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('#include') || trimmed.startsWith('#define');
    });
    return dependencies.join('\n');
  }

  /**
   * 更新 ABS block 行号映射
   * 工作区变更后调用，确保选中块时显示的 ABS 行号与实际导出一致
   */
  private updateAbsBlockLineMap(): void {
    try {
      const workspaceJson = Blockly.serialization.workspaces.save(this.workspace);
      const { blockLineMap } = convertAbiToAbsWithLineMap(workspaceJson, { includeHeader: true });
      this.blocklyService.absBlockLineMap.next(blockLineMap);
    } catch (e) {
      console.warn('[Blockly] Failed to update ABS block line map:', e);
    }
  }
}
