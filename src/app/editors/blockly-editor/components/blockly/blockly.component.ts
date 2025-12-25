import { Component, ElementRef, Input, ViewChild, DoCheck } from '@angular/core';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
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
export class BlocklyComponent implements DoCheck {
  @ViewChild('blocklyDiv', { static: true }) blocklyDiv!: ElementRef;

  @Input() devmode;
  generator;
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
    theme: darkTheme,
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
    private noticeService: NoticeService
  ) {
    // Initialize GlobalServiceManager with BitmapUploadService
    const globalServiceManager = GlobalServiceManager.getInstance();
    globalServiceManager.setBitmapUploadService(this.bitmapUploadService);
  }

  ngOnInit(): void {
    this.initDevMode();
    this.initPrompt();
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
    // 清理定时器
    if (this.codeGenerationTimer) {
      clearTimeout(this.codeGenerationTimer);
    }
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
      console.error = ((originalError) => {
        return (message, ...args) => {
          console.log(message, ...args);
          // 保留原始错误输出功能
          originalError.apply(console, arguments);
          // 处理特定错误
          if (args[0] instanceof HttpErrorResponse) {
            // console.log('HTTP错误:', args[0]);
            return
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
          // this.noticeService.update({
          //   title: '未知错误',
          //   text: errorMessage,
          //   detail: errorMessage,
          //   state: 'error',
          //   setTimeout: 99000,
          // });
        };
      })(console.error);

      Blockly.setLocale(<any>zhHans);
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
        const minimap = new Minimap(this.workspace);
        minimap.init();
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
        // if (event.type == Blockly.Events.SELECTED) {
        //   console.log('积木选择事件：', event);
        //   // const code = Blockly;
        //   // console.log('代码生成结果：', code);
        //  const block = this.workspace.getBlockById(event.newElementId);
        //  console.log('选中的积木：', block);
        // }
        try {
          this.codeGeneration();
        } catch (error) {
          // 仅在开发环境下打印错误，避免用户看到错误
          console.debug('代码生成时出现错误，可能是某些块尚未注册：', error);
          // 错误发生时不更新代码
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
    Blockly.Msg["CROSS_TAB_COPY"] = "复制到指定位置";
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

  private codeGenerationTimer: any = null;

  codeGeneration(): void {
    // 清除之前的定时器
    if (this.codeGenerationTimer) {
      clearTimeout(this.codeGenerationTimer);
    }

    // 设置新的定时器，1秒后执行代码生成
    this.codeGenerationTimer = setTimeout(() => {
      try {
        const code = this.generator.workspaceToCode(this.workspace);
        this.blocklyService.codeSubject.next(code);
      } catch (error) {
        // 仅在开发环境下打印错误，避免用户看到错误
        console.error('代码生成时出现错误，可能是某些块尚未注册：', error);
        // 错误发生时不更新代码
      }
    }, 500); // 500毫秒防抖延迟
  }
}


const darkTheme = Blockly.Theme.defineTheme('dark', {
  name: 'dark',
  base: Blockly.Themes.Classic,
  startHats: true,
  componentStyles: {
    workspaceBackgroundColour: '#262626',
    // toolboxBackgroundColour: 'blackBackground',
    // toolboxForegroundColour: '#fff',
    flyoutBackgroundColour: '#333',
    // flyoutForegroundColour: '#ccc',
    // flyoutOpacity: 1,
    // scrollbarColour: '#fff',
    scrollbarOpacity: 0.1,
    // insertionMarkerColour: '#fff',
    // insertionMarkerOpacity: 0.3,
    // markerColour: '#d0d0d0',
    // cursorColour: '#d0d0d0'
    // selectedGlowColour?: string;
    // selectedGlowOpacity?: number;
    // replacementGlowColour?: string;
    // replacementGlowOpacity?: number;
  },
});
