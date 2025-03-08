import { Component, ElementRef, ViewChild } from '@angular/core';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
import {
  ContinuousToolbox,
  ContinuousFlyout,
  ContinuousMetrics,
} from './plugins/continuous-toolbox/src/index.js';
import './plugins/toolbox-search/src/index.js';
import { arduinoGenerator, DEFAULT_DATA } from './generators/arduino/arduino';
import { BlocklyService } from './blockly.service';
import { DEV_THEME } from './theme.config.js';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NewVarModalComponent } from '../components/new-var-modal/new-var-modal.component';

import './custom-category';

@Component({
  selector: 'blockly-main',
  imports: [NzModalModule],
  templateUrl: './blockly.component.html',
  styleUrl: './blockly.component.scss',
})
export class BlocklyComponent {
  @ViewChild('blocklyDiv', { static: true }) blocklyDiv!: ElementRef;

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

  constructor(
    private blocklyService: BlocklyService,
    // private modal: NzModalService,
  ) { }

  ngOnInit(): void { }

  ngAfterViewInit(): void {
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

      Blockly.setLocale(<any>zhHans);
      this.workspace = Blockly.inject('blocklyDiv', {
        toolbox: this.toolbox,
        // plugins: {
        //   toolbox: ContinuousToolbox,
        //   flyoutsVerticalToolbox: ContinuousFlyout,
        //   metricsManager: ContinuousMetrics,
        // },
        renderer: 'thrasos',
        theme: Blockly.Theme.defineTheme('modest', DEV_THEME),
        trashcan: true,
        grid: {
          spacing: 20, // 网格间距为20像素
          length: 3, // 网格点的大小
          colour: '#ccc',
          snap: true,
        },
        media: 'blockly/media',
      });

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

      // this.workspace.addChangeListener((event) => {
      //   console.log(event);
      //   let code = arduinoGenerator.workspaceToCode(this.workspace);
      //   this.blocklyService.codeSubject.next(code);
      // });

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
      // this.blocklyService.init();
      // await this.loadLibraries();
      // this.loadDefaultData();
    }, 50);
  }

  // 加载库
  // async loadLibraries() {
  //   let libs = await this.blocklyService.loadLibraries();
  // }

  // loadDefaultData() {
  //   let tempJson = JSON.parse(DEFAULT_DATA);
  //   this.loadJson(tempJson);
  // }

}
