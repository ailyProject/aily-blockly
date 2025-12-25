import { Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core';
import * as Blockly from 'blockly';
import * as zhHans from 'blockly/msg/zh-hans';
import { browserEvents } from 'blockly';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';

@Component({
  selector: 'app-aily-blockly',
  imports: [],
  templateUrl: './aily-blockly.component.html',
  styleUrl: './aily-blockly.component.scss',
})
export class AilyBlocklyComponent implements OnInit {
  @ViewChild('blocklyArea', { static: true }) blocklyArea!: ElementRef;
  @ViewChild('blocklyDiv', { static: true }) blocklyDiv!: ElementRef;

  @Input() data: any = {};

  get draggingBlock() {
    return this.blocklyService.draggingBlock;
  }

  set draggingBlock(draggingBlock: any) {
    this.blocklyService.draggingBlock = draggingBlock;
  }

  get offsetX() {
    return this.blocklyService.offsetX;
  }

  set offsetX(offsetX: number) {
    this.blocklyService.offsetX = offsetX;
  }

  get offsetY() {
    return this.blocklyService.offsetY;
  }

  set offsetY(offsetY: number) {
    this.blocklyService.offsetY = offsetY;
  }

  constructor(
    private blocklyService: BlocklyService
  ) { }

  workspace: any;

  // TODO 懒加载机制优化

  // TODO 实时block连接检查

  // TODO 拖拽范围icon处理

  ngOnInit() {
    Blockly.setLocale(<any>zhHans);
    const blocklyArea = this.blocklyArea.nativeElement;
    const blocklyDiv = this.blocklyDiv.nativeElement;
    this.workspace = Blockly.inject(blocklyDiv, {
      toolbox: this.data,
      grid: {
        spacing: 20,
        length: 2,
        colour: '#ccc',
        snap: true,
      },
      move: {
        scrollbars: {
          horizontal: false,
          vertical: false,
        },
        drag: false,
        wheel: false,
      },
      zoom: {
        controls: false,
        wheel: false,
        startScale: 1.0,
        maxScale: 1,
        minScale: 1,
        scaleSpeed: 1.2,
        pinch: false,
      },
      // readOnly: true,
      media: 'blockly/media/',
      renderer: 'thrasos',
      trashcan: true,
      // theme: Blockly.Theme.defineTheme('modest', DEV_THEME),
    });

    // Blockly.serialization.workspaces.load(
    //   {
    //     blocks: {
    //       languageVersion: 0,
    //       blocks: [
    //         {
    //           type: 'controls_if',
    //           id: 'j.:oqr+^)OI8SG+$@%XV',
    //           x: 63,
    //           y: 238,
    //         },
    //         {
    //           type: 'lists_create_with',
    //           id: 'jnB5|zH|2VEn~Gz@I2o!',
    //           x: 38,
    //           y: 138,
    //           extraState: {
    //             itemCount: 3,
    //           },
    //         },
    //         {
    //           type: 'text_append',
    //           id: 'dF@=$k`$x:=|x/X9$Yf0',
    //           x: 38,
    //           y: 88,
    //           fields: {
    //             VAR: {
    //               id: 'NkZFMkM#e!G)24F,My^S',
    //             },
    //           },
    //           inputs: {
    //             TEXT: {
    //               shadow: {
    //                 type: 'text',
    //                 id: 'G,PV-2E*OTO=)EVPJ6xO',
    //                 fields: {
    //                   TEXT: '',
    //                 },
    //               },
    //             },
    //           },
    //         },
    //       ],
    //     },
    //     variables: [
    //       {
    //         name: 'item',
    //         id: 'NkZFMkM#e!G)24F,My^S',
    //       },
    //     ],
    //   },
    //   this.workspace,
    // );

    const onresize: any = (e: any) => {
      let element: any = blocklyArea;
      let x = 0;
      let y = 0;
      do {
        x += element.offsetLeft;
        y += element.offsetTop;
        element = element.offsetParent;
      } while (element);
      blocklyDiv.style.left = x + 'px';
      blocklyDiv.style.top = y + 'px';
      blocklyDiv.style.width = blocklyArea.offsetWidth + 'px';

      const flyout = this.workspace.getFlyout().svgGroup_;

      flyout.style.width = blocklyArea.style.width;

      const { height } = flyout
        .getElementsByClassName('blocklyWorkspace')?.[0]
        .getBoundingClientRect();

      blocklyDiv.style.height = height + 20 + 'px';

      Blockly.svgResize(this.workspace);
    };

    this.workspace.addChangeListener(this.workspaceChange.bind(this));

    this.workspace
      .getFlyout()
      .getWorkspace()
      .addChangeListener((event: any) => { });

    this.workspace.getFlyout().contents.forEach(({ block }) => {
      browserEvents.bind(
        block.svgGroup_ || block.svgGroup,
        'pointerdown',
        this,
        (event: any) => {
          this.offsetX = event.offsetX - block.relativeCoords.x;
          this.offsetY = event.offsetY - block.relativeCoords.y + 20;
        },
      );
    });

    // browserEvents.bind(
    //   this.workspace
    //     .getFlyout()
    //     .svgGroup_.getElementsByClassName('blocklyWorkspace')?.[0],
    //   'mousemove',
    //   this,
    //   (event: any) => {
    //     this.offsetX = event.offsetX;
    //     this.offsetY = event.offsetY;
    //   },
    // );

    window.addEventListener('resize', onresize, false);
    onresize();
  }

  surfaceGlobal: any;

  setDragSurfaceGlobal(sourceDom: any) {
    if (!this.surfaceGlobal) {
      const surfaceDom = sourceDom.getElementsByClassName(
        'blocklyBlockDragSurface',
      );
      this.surfaceGlobal = surfaceDom?.[0];
      const globalDom = document.createElement('div');
      globalDom.setAttribute(
        'class',
        'surfaceGlobal ' +
        (this.workspace.options.renderer || 'geras') +
        '-renderer ' +
        (this.workspace.getTheme
          ? this.workspace.getTheme().name + '-theme'
          : ''),
      );
      globalDom.append(...surfaceDom);
      document.body.append(globalDom);
      this.surfaceGlobal.style.display = 'none';
      return;
    }
    const { top, left } = sourceDom.getBoundingClientRect();

    this.surfaceGlobal.style.top = top + 'px';
    this.surfaceGlobal.style.left = left + 'px';
    this.surfaceGlobal.style.display = 'block';
  }

  workspaceChange(event: any) {
    this.setDragSurfaceGlobal(this.blocklyArea.nativeElement);
    if (event.type === Blockly.Events.BLOCK_DRAG && event.isStart) {
      this.draggingBlock = this.workspace.getBlockById(event.blockId);
    } else if (event.type === Blockly.Events.BLOCK_DRAG && !event.isStart) {
    }
  }

  ngOnDestroy() {
    this.surfaceGlobal?.remove();
    this.surfaceGlobal = null;

    // this.workspace.getFlyout().contents.forEach(({ block }) => {
    //   browserEvents.unbind(block.svgGroup_ || block.svgGroup);
    // });

    this.workspace.removeChangeListener();
  }
}
