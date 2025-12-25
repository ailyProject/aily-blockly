import * as Blockly from "blockly";
import { ISerializable } from 'blockly';

interface AilyIcon {
  type: 'image' | 'i' | 'svg';
  width: number; // 宽度
  height: number; // 高度
  alt?: string; // 图片alt，仅image类型有效
  src: string; // 图片类型为src，svg类型为path，i类型为icon class
  class?: string; // 扩展类名
  fontSize?: string; // 仅 i类型有效
  color?: string; // 颜色，仅svg、i类型有效
}

export class Icon extends Blockly.icons.Icon implements ISerializable {
  _state: AilyIcon = {
    type: 'i',
    width: -10,
    height: 0,
    src: 'fa-solid fa-bed-pulse',
    alt: '*',
    class: 'inner-icon',
    fontSize: '0px',
    color: 'white',
  }

  state: AilyIcon | string;

  constructor(sourceBlock) {
    super(sourceBlock);
  }

  override getType() {
    return new Blockly.icons.IconType('ailyIcon');
  }

  override getSize() {
    return new Blockly.utils.Size(this._state.width, this._state.height);
  }

  override isShownWhenCollapsed() {
    return false;
  }

  // override getWeight() {
  //   return 10;
  // }

  override initView(pointerdownListener) {
    if (this.svgRoot) {
      this.svgRoot.remove();
      return;
    }

    super.initView(pointerdownListener);

    // setTimeout(() => {
    //   this.updateView();
    // }, 0);
  }

  updateView() {
    // Blockly.utils.dom.createSvgElement(
    //   Blockly.utils.Svg.CIRCLE,
    //   {
    //     'class': 'my-css-class',
    //     'r': '18',
    //     'cx': '18',
    //     'cy': '18',
    //   },
    //   this.svgRoot
    // );

    switch (this._state.type) {
      case "image":
        Blockly.utils.dom.createSvgElement(
          Blockly.utils.Svg.IMAGE,
          {
            'class': this._state.class,
            'width': this._state.width + 'px',
            'height': this._state.height + 'px',
            'alt': '*',
          },
          this.svgRoot,
        ).setAttributeNS(
          Blockly.utils.dom.XLINK_NS,
          'xlink:href',
          this._state.src,
        );
        break;
      case "svg":
        Blockly.utils.dom.createSvgElement(
          Blockly.utils.Svg.SVG,
          {
            'class': this._state.class,
            'width': this._state.width,
            'height': this._state.height,
            'xmlns': 'http://www.w3.org/2000/svg',
            'viewBox': '0 0 512 512',
            'fill': this._state.color,
          },
          this.svgRoot,
        ).innerHTML = this._state.src;
        break;
      case "i":
        this.svgRoot.innerHTML = `<foreignObject class="${this._state.class}" width="${this._state.width}" height="${this._state.height}" font-size="${this._state.fontSize}" color="${this._state.color}" style="line-height: 1;">
                                    <body xmlns="http://www.w3.org/1999/xhtml">
                                      <i class="${this._state.src}"></i>
                                    </body>
                                  </foreignObject>`;
        break;
    }

  }

  override dispose() {
    super.dispose();
  }

  loadState(state: AilyIcon | string): void {
    // if (typeof state === 'string') {
    //   this._state = { ...this._state, src: state };
    // } else {
    //   this._state = { ...this._state, ...state };
    // }
    // if (!this._state.color) {
    //   this._state.color = 'white';
    // }
    // this.state = state;
  }

  saveState(doFullSerialization: boolean): any {
    // return this.state;
  }
}
