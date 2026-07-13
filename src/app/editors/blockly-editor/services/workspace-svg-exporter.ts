import * as Blockly from 'blockly';

/** 工作区内需要导出的实际内容边界，坐标单位为 Blockly 工作区坐标。 */
interface WorkspaceBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const EXPORT_PADDING = 24;

/**
 * 将当前工作区导出为独立 SVG。
 *
 * 只复制工作区内容、批注和背景，不包含工具箱、滚动条或缩放按钮。
 */
export function exportWorkspaceToSvg(workspace: Blockly.WorkspaceSvg): string | null {
  const bounds = getWorkspaceBounds(workspace);
  if (!bounds) {
    return null;
  }

  const left = bounds.left - EXPORT_PADDING;
  const top = bounds.top - EXPORT_PADDING;
  const width = Math.max(1, Math.ceil(bounds.right - bounds.left + EXPORT_PADDING * 2));
  const height = Math.max(1, Math.ceil(bounds.bottom - bounds.top + EXPORT_PADDING * 2));
  const sourceSvg = workspace.getParentSvg();
  const svg = createExportSvg(left, top, width, height);

  copySvgDefinitions(sourceSvg, svg);
  appendBlocklyStyles(svg);
  appendWorkspaceBackground(sourceSvg, svg, left, top, width, height);
  svg.appendChild(cloneLayer(workspace.getCanvas()));
  svg.appendChild(cloneLayer(workspace.getBubbleCanvas()));

  return new XMLSerializer().serializeToString(svg);
}

/** 收集块和工作区批注的联合边界；空工作区不导出。 */
function getWorkspaceBounds(workspace: Blockly.WorkspaceSvg): WorkspaceBounds | null {
  const hasBlocks = workspace.getAllBlocks(false).length > 0;
  const commentBounds = (workspace.getTopComments(false) as Array<{
    getBoundingRectangle?: () => WorkspaceBounds;
  }>)
    .map((comment) => comment.getBoundingRectangle?.())
    .filter((bounds): bounds is WorkspaceBounds => !!bounds);

  if (!hasBlocks && commentBounds.length === 0) {
    return null;
  }

  const bounds = hasBlocks ? [workspace.getBlocksBoundingBox(), ...commentBounds] : commentBounds;
  return {
    top: Math.min(...bounds.map((item) => item.top)),
    bottom: Math.max(...bounds.map((item) => item.bottom)),
    left: Math.min(...bounds.map((item) => item.left)),
    right: Math.max(...bounds.map((item) => item.right)),
  };
}

/** 创建带 viewBox 的根 SVG，确保无论当前缩放比例如何都能导出完整内容。 */
function createExportSvg(left: number, top: number, width: number, height: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('xmlns:xlink', XLINK_NS);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);
  return svg;
}

/** 复制 Blockly 的滤镜、网格等 defs，供块和背景继续引用。 */
function copySvgDefinitions(sourceSvg: SVGSVGElement, targetSvg: SVGSVGElement): void {
  const defs = sourceSvg.querySelector('defs');
  if (defs) {
    targetSvg.appendChild(defs.cloneNode(true));
  }
}

/** 内联 Blockly 样式，避免保存后的 SVG 丢失文字或块的视觉样式。 */
function appendBlocklyStyles(svg: SVGSVGElement): void {
  const styles = Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent || '')
    .filter((style) => style.includes('.blockly'));
  if (styles.length === 0) {
    return;
  }

  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = styles.join('\n');
  svg.appendChild(style);
}

/** 直接复制当前工作区背景，保留主题色或网格图案。 */
function appendWorkspaceBackground(
  sourceSvg: SVGSVGElement,
  targetSvg: SVGSVGElement,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  // Blockly 主题色设置在根 SVG 的 background-color；先复制它作为导出底色。
  const backgroundColor = getComputedStyle(sourceSvg).backgroundColor;
  if (backgroundColor && backgroundColor !== 'transparent' && backgroundColor !== 'rgba(0, 0, 0, 0)') {
    const colorLayer = document.createElementNS(SVG_NS, 'rect');
    colorLayer.setAttribute('x', String(left));
    colorLayer.setAttribute('y', String(top));
    colorLayer.setAttribute('width', String(width));
    colorLayer.setAttribute('height', String(height));
    colorLayer.setAttribute('fill', backgroundColor);
    targetSvg.appendChild(colorLayer);
  }

  // 再叠加工作区本身的背景元素，以保留网格等视觉效果。
  const sourceBackground = sourceSvg.querySelector('.blocklyMainBackground') as SVGRectElement | null;
  if (!sourceBackground) {
    return;
  }

  const background = sourceBackground.cloneNode(true) as SVGRectElement;
  background.setAttribute('x', String(left));
  background.setAttribute('y', String(top));
  background.setAttribute('width', String(width));
  background.setAttribute('height', String(height));
  copyComputedStyles(sourceBackground, background);
  targetSvg.appendChild(background);
}

/**
 * 图层原本会携带当前视口的平移和缩放；移除该变换后，块坐标恢复为工作区坐标。
 */
function cloneLayer(source: SVGGElement): SVGGElement {
  const clone = source.cloneNode(true) as SVGGElement;
  clone.removeAttribute('transform');
  clone.style.removeProperty('transform');
  copyComputedStyles(source, clone);
  return clone;
}

/** 将影响 SVG 渲染的计算样式写回克隆节点，确保导出的文件独立可打开。 */
function copyComputedStyles(source: Element, target: Element): void {
  const sourceElements = [source, ...Array.from(source.querySelectorAll('*'))];
  const targetElements = [target, ...Array.from(target.querySelectorAll('*'))];
  const styleProperties = [
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
    'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing',
    'text-anchor', 'dominant-baseline', 'direction', 'opacity', 'display',
    'visibility', 'filter', 'paint-order', 'text-rendering',
  ];

  sourceElements.forEach((sourceElement, index) => {
    const targetElement = targetElements[index] as SVGElement | undefined;
    if (!targetElement) {
      return;
    }

    const computed = window.getComputedStyle(sourceElement);
    styleProperties.forEach((property) => {
      const value = computed.getPropertyValue(property);
      if (value) {
        targetElement.style.setProperty(property, value);
      }
    });
  });
}
