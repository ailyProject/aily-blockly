import { Component, ElementRef, ViewChild } from '@angular/core';
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
import { BlocklyService } from './blockly.service';
import { BitmapUploadResponse } from './bitmap-upload.service';

import './custom-category';
import './custom-field/field-bitmap';
import './custom-field/field-bitmap-u8g2';
import './custom-field/field-image';
import './custom-field/field-tone';
import './custom-field/field-multilineinput';
import './custom-field/field-slider';
import './custom-field/field-angle180';
import './custom-field/field-angle';
import '@blockly/field-colour-hsv-sliders';

import { Multiselect } from './plugins/workspace-multiselect/index.js';
import { PromptDialogComponent } from './components/prompt-dialog/prompt-dialog.component.js';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { ConfigService } from '../services/config.service';
import * as BlockDynamicConnection from '@blockly/block-dynamic-connection';
import { CommonModule } from '@angular/common';
import { BitmapUploadService } from './bitmap-upload.service';
import { GlobalServiceManager } from './global-service-manager';
import { ImageUploadDialogComponent } from './components/image-upload-dialog/image-upload-dialog.component';
import { NoticeService } from '../services/notice.service';

@Component({
  selector: 'blockly-main',
  imports: [
    NzModalModule,
    CommonModule
  ],
  templateUrl: './blockly.component.html',
  styleUrl: './blockly.component.scss',
})
export class BlocklyComponent {
  @ViewChild('blocklyDiv', { static: true }) blocklyDiv!: ElementRef;

  // Control bitmap upload handler visibility
  showBitmapUploadHandler = true;

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
    this.setPrompt();
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
        } else {
          // 用户取消或出错
          // const response: BitmapUploadResponse = {
          //   fieldId: request.fieldId,  // 添加字段ID
          //   data: request.currentBitmap, // 返回原始数据
          //   success: false,
          //   // message: '图片处理已取消',
          //   // timestamp: Date.now()
          // };

          // this.bitmapUploadService.sendUploadResponse(response);
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
          let errorMessage = message + '   ' + args.join('\n');
          if (/block/i.test(errorMessage)) {
            // 常见错误1：Invalid block definition
            let title = message;
            let text = args.join('\n');
            if (errorMessage.includes('Invalid block definition')) {
              title = '无效的块定义';
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
          }
        };
      })(console.error);

      Blockly.setLocale(<any>zhHans);
      // 在工作区创建前设置 block registry 拦截
      this.setupBlockRegistryInterception();
      // 获取当前blockly渲染器
      this.options.renderer = this.configData.blockly.renderer || 'thrasos';

      this.workspace = Blockly.inject('blocklyDiv', this.options);

      const multiselectPlugin = new Multiselect(this.workspace);
      multiselectPlugin.init(this.options);

      // 动态连接块监听
      this.workspace.addChangeListener(BlockDynamicConnection.finalizeConnections);

      // 监听容器尺寸变化，刷新Blockly工作区
      const resizeObserver = new ResizeObserver(() => {
        Blockly.svgResize(this.workspace);
      });
      resizeObserver.observe(this.blocklyDiv.nativeElement);

      // this.workspace.registerButtonCallback(
      //   'CREATE_NUMBER_VARIABLE',
      //   (button) => {
      //     console.log('CREATE_NUMBER_VARIABLE');
      //     Blockly.Variables.createVariableButtonHandler(
      //       this.workspace,
      //       (name) => {
      //         console.log('变量创建成功');
      //       },
      //       'aily-variable',
      //     );
      //   },
      // );

      // this.workspace.registerButtonCallback('CREATE_OBJECT', (button) => {
      //   console.log('CREATE_OBJECT');
      // });

      // Blockly.Variables.createVariableButtonHandler = (
      //   workspace,
      //   opt_callback,
      //   opt_type,
      // ) => {
      //   let modal = this.modal.create({
      //     nzTitle: '添加变量',
      //     nzWidth: '350px',
      //     nzContent: NewVarModalComponent,
      //     // nzComponentParams: {
      //     //   varType: opt_type
      //     // },
      //     nzOnOk: (e) => {
      //       if (opt_callback) opt_callback(e.varName);
      //     },
      //   });
      //   modal.triggerOk;
      // };
      // this.blocklyDiv.nativeElement.addEventListener(
      //   'mousemove',
      //   (event: any) => {
      //     if (!this.draggingBlock) return;

      //     if (this.draggingBlock?.workspace?.id !== this.workspace.id) {
      //       const xml: any = Blockly.Xml.blockToDom(this.draggingBlock); // .clone()

      //       const newBlock: any = Blockly.Xml.domToBlock(xml, this.workspace);
      //       newBlock.moveBy(
      //         event.clientX - 180 - this.workspace.scrollX - this.offsetX,
      //         event.clientY - 70 - this.workspace.scrollY - this.offsetY,
      //       );
      //       this.draggingBlock = null;
      //     }
      //   },
      // );

      window['Arduino'] = <any>arduinoGenerator;
      (window as any)['Blockly'] = Blockly;
      this.workspace.addChangeListener((event) => {
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

  setPrompt() {
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
        const code = arduinoGenerator.workspaceToCode(this.workspace);
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