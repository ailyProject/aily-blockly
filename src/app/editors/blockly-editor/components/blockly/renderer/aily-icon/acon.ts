import * as Blockly from "blockly";

type BlockSvg = Blockly.BlockSvg;

interface AilyIconState {
  type: 'image' | 'i' | 'svg';
  width: number; // 宽度
  height: number; // 高度
  alt?: string; // 图片alt，仅image类型有效
  src: string; // 图片类型为src，svg类型为path，i类型为icon class
  class?: string; // 扩展类名
  fontSize?: string; // 仅 i类型有效
  color?: string; // 颜色，仅svg、i类型有效
}

export const AILY_ICON_TYPE = new (Blockly.icons.IconType as any)('aily-icon');

export class AilyIcon extends Blockly.icons.Icon {
  static readonly TYPE = AILY_ICON_TYPE;

  // static readonly WEIGHT = -1;

  private state: AilyIconState = {
    type: 'i',
    width: 20,
    height: 20,
    src: 'fa-solid fa-bed-pulse',
    alt: '*',
    class: 'inner-icon',
    fontSize: '16px',
    color: 'white',
  };

  constructor(protected override readonly sourceBlock: BlockSvg, state?: Partial<AilyIconState> | string) {
    super(sourceBlock);
    if (state) {
      this.loadState(state);
    }
  }

  override getType(): any {
    return AilyIcon.TYPE;
  }

  // override getWeight(): number {
  //   return AilyIcon.WEIGHT;
  // }

  override getSize(): Blockly.utils.Size {
    return new Blockly.utils.Size(this.state.width, this.state.height);
  }

  override initView(pointerdownListener: (e: PointerEvent) => void): void {
    if (this.svgRoot) return;

    super.initView(pointerdownListener);

    this.createIconContent();
  }

  /**
   * 创建 icon 的 SVG 内容
   */
  private createIconContent(): void {
    if (!this.svgRoot) return;

    switch (this.state.type) {
      case "image":
        this.createImageIcon();
        break;
      case "svg":
        this.createSvgIcon();
        break;
      case "i":
        this.createFontIcon();
        break;
    }
  }

  /**
   * 创建图片类型的 icon
   */
  private createImageIcon(): void {
    if (!this.svgRoot) return;

    Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.IMAGE,
      {
        'class': this.state.class || 'aily-icon-image',
        'width': this.state.width,
        'height': this.state.height,
        'alt': this.state.alt || '*',
      },
      this.svgRoot,
    ).setAttributeNS(
      Blockly.utils.dom.XLINK_NS,
      'xlink:href',
      this.state.src,
    );
  }

  /**
   * 创建 SVG 类型的 icon
   */
  private createSvgIcon(): void {
    if (!this.svgRoot) return;

    const svgElement = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.SVG,
      {
        'class': this.state.class || 'aily-icon-svg',
        'width': this.state.width,
        'height': this.state.height,
        'xmlns': 'http://www.w3.org/2000/svg',
        'viewBox': '0 0 512 512',
        'fill': this.state.color || 'currentColor',
      },
      this.svgRoot,
    );
    svgElement.innerHTML = this.state.src;
  }

  /**
   * 创建字体图标类型的 icon
   */
  private createFontIcon(): void {
    if (!this.svgRoot) return;

    const foreignObject = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.FOREIGNOBJECT,
      {
        'class': this.state.class || 'aily-icon-font',
        'width': this.state.width,
        'height': this.state.height,
        'font-size': this.state.fontSize || '16px',
        'color': this.state.color || 'currentColor',
        'style': 'line-height: 1;',
      },
      this.svgRoot,
    );

    foreignObject.innerHTML = `
      <body xmlns="http://www.w3.org/1999/xhtml">
        <i class="${this.state.src}"></i>
      </body>
    `;
  }

  /**
   * 更新 icon 的颜色
   */
  override applyColour(): void {
    if (!this.svgRoot) return;

    const color = this.sourceBlock.getColour();
    if (this.state.type === 'svg' || this.state.type === 'i') {
      const elements = this.svgRoot.querySelectorAll('[fill], [color], i');
      elements.forEach((el) => {
        if (el instanceof SVGElement && el.hasAttribute('fill')) {
          el.setAttribute('fill', this.state.color || color || 'currentColor');
        } else if (el instanceof HTMLElement) {
          el.style.color = this.state.color || color || 'currentColor';
        }
      });
    }
  }

  /**
   * 加载状态配置
   */
  loadState(state: Partial<AilyIconState> | string): void {
    if (typeof state === 'string') {
      this.state = { ...this.state, src: state };
    } else {
      this.state = { ...this.state, ...state };
    }
    if (!this.state.color) {
      this.state.color = 'white';
    }

    if (this.svgRoot) {
      this.svgRoot.innerHTML = '';
      this.createIconContent();
      this.applyColour();
    }
  }

  /**
   * 获取当前状态
   */
  getState(): AilyIconState {
    return { ...this.state };
  }

  /**
   * 设置状态
   */
  setState(state: Partial<AilyIconState> | string): void {
    this.loadState(state);
  }
}

/**
 * 注册 AilyIcon 到 Blockly 的 icon 注册表
 * 这样可以通过 block.addIcon() 或 XML 序列化使用
 */
export function registerAilyIcon(): void {
  Blockly.icons.registry.register(AILY_ICON_TYPE, AilyIcon);
}

/**
 * 为指定的块添加 AilyIcon
 * @param block 要添加 icon 的块
 * @param state icon 的配置状态（可选）
 * @returns 创建的 AilyIcon 实例
 */
export function addAilyIconToBlock(
  block: BlockSvg,
  state?: Partial<AilyIconState> | string
): AilyIcon {
  try {
    Blockly.icons.registry.register(AILY_ICON_TYPE, AilyIcon);
  } catch (e) {
  }
  const existingIcon = block.getIcon(AILY_ICON_TYPE);
  if (existingIcon instanceof AilyIcon) {
    if (state) {
      existingIcon.setState(state);
    }
    return existingIcon;
  }

  const icon = new AilyIcon(block, state);
  return block.addIcon(icon);
}

/**
 * 获取指定块类型的 BlockDefinition
 * @param blockType
 */
export function getBlockDefinition(blockType: string): any {
  const blockDefinitionsMap = (window as any).__ailyBlockDefinitionsMap as Map<
    string,
    any
  >;
  if (blockDefinitionsMap) {
    return blockDefinitionsMap.get(blockType);
  }
  return null;
}
