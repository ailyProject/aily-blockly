import * as Blockly from 'blockly';
import {addAilyIconToBlock} from '../components/blockly/renderer/aily-icon/acon';

describe('Aily icon render reuse', () => {
  it('retains unchanged DOM across renders and still applies actual state changes', () => {
    const host = document.createElement('div'); host.style.cssText = 'width:600px;height:400px';
    document.body.append(host);
    const workspace = Blockly.inject(host, {});
    Blockly.Blocks['icon_reuse_probe'] = {init() {this.appendDummyInput().appendField('icon');}};
    try {
      const block = workspace.newBlock('icon_reuse_probe'); block.initSvg();
      const icon = addAilyIconToBlock(block, 'fa-solid fa-play'); block.render();
      const original = block.getSvgRoot().querySelector('foreignObject');
      expect(original).not.toBeNull();
      const registrations = spyOn(Blockly.icons.registry, 'register').and.callThrough();
      for (let i = 0; i < 20; i++) {addAilyIconToBlock(block, 'fa-solid fa-play'); block.render();}
      expect(block.getSvgRoot().querySelector('foreignObject')).toBe(original);
      expect(registrations).not.toHaveBeenCalled();
      icon.setState({src: 'fa-solid fa-stop', color: '#123456', width: 24});
      expect(block.getSvgRoot().querySelector('foreignObject')).not.toBe(original);
      expect(block.getSvgRoot().querySelector('i')!.className).toContain('fa-stop');
      expect(icon.getSize().width).toBe(24);
      expect(icon.getState().color).toBe('#123456');
    } finally {workspace.dispose(); host.remove(); delete Blockly.Blocks['icon_reuse_probe'];}
  });
});

describe('Aily decorative icon interaction', () => {
  let host: HTMLDivElement;
  let workspace: Blockly.WorkspaceSvg;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'width:600px;height:400px';
    document.body.append(host);
    workspace = Blockly.inject(host, {});
    Blockly.Blocks['decorative_icon_probe'] = {
      init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('editable'), 'TEXT'); },
    };
  });

  afterEach(() => {
    workspace.dispose(); host.remove();
    delete Blockly.Blocks['decorative_icon_probe'];
  });

  it('defers offscreen contents, uses the latest state on reveal and restores contents when disabled', () => {
    workspace.setViewportRendering(true);
    spyOn(workspace.getMetricsManager(), 'getViewMetrics').and.returnValue({top: 0, left: 0, width: 600, height: 400});
    const block = workspace.newBlock('decorative_icon_probe'); block.initSvg(); block.moveBy(0, 10000);
    const icon = addAilyIconToBlock(block, 'fa-solid fa-play'); block.render();
    const renderer = workspace.getViewportRenderer()!;
    renderer.refresh();
    expect(icon.getFocusableElement().childElementCount).toBe(0);
    expect(icon.getSize().width).toBe(20);
    icon.setState({src: 'fa-solid fa-stop', color: '#123456', width: 24});
    expect(icon.getFocusableElement().childElementCount).toBe(0);
    expect(icon.getSize().width).toBe(24);
    renderer.withAllBlocksRendered(() => {
      expect(icon.getFocusableElement().querySelector('i')!.className).toContain('fa-stop');
      expect(icon.canBeFocused()).toBeFalse();
    });
    const other = workspace.newBlock('decorative_icon_probe'); other.initSvg(); other.moveBy(0, 20000);
    const second = addAilyIconToBlock(other, 'fa-solid fa-play'); other.render(); renderer.refresh();
    expect(second.getFocusableElement().childElementCount).toBe(0);
    workspace.setViewportRendering(false);
    expect(second.getFocusableElement().querySelector('i')).not.toBeNull();
  });

  for (const type of ['i', 'svg', 'image'] as const) {
    it(`${type} passes hit testing to the block and stays outside focus navigation after updates`, () => {
      const block = workspace.newBlock('decorative_icon_probe'); block.initSvg();
      const icon = addAilyIconToBlock(block, { type, src: type === 'svg' ? '<path d="M0 0 H512 V512 H0 Z" />'
        : type === 'image' ? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' : 'fa-solid fa-play' });
      block.render(); block.moveBy(40, 40);
      const element = icon.getFocusableElement();
      expect(icon.canBeFocused()).toBe(false);
      expect(icon.isClickableInFlyout(true)).toBe(false);
      expect(icon.isClickableInFlyout(false)).toBe(false);
      expect(element.getAttribute('aria-hidden')).toBe('true');
      expect(element.getAttribute('role')).not.toBe('button');
      expect(element.hasAttribute('tabindex')).toBe(false);
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      expect(hit).toBe(block.pathObject.svgPath);
      expect(getComputedStyle(hit!).cursor).toBe('grab');

      icon.setState({ width: 24, color: '#123456' }); block.render();
      expect(icon.canBeFocused()).toBe(false);
      expect(getComputedStyle(element).pointerEvents).toBe('none');
      expect(element.getAttribute('aria-hidden')).toBe('true');
      expect(element.querySelector('[tabindex]')).toBeNull();
    });
  }

  it('preserves native block, field and comment focus', () => {
    const block = workspace.newBlock('decorative_icon_probe'); block.initSvg();
    addAilyIconToBlock(block, 'fa-solid fa-play');
    block.setCommentText('interactive comment'); block.render();
    const comment = block.getIcon(Blockly.icons.CommentIcon.TYPE)!;
    for (const node of [block, block.getField('TEXT')!, comment]) {
      expect(node.canBeFocused()).toBe(true);
      Blockly.getFocusManager().focusNode(node);
      expect(document.activeElement).toBe(node.getFocusableElement());
    }
    expect(comment.getFocusableElement().getAttribute('aria-hidden')).not.toBe('true');
    expect(comment.getFocusableElement().getAttribute('role')).toBe('button');
    expect(getComputedStyle(comment.getFocusableElement()).pointerEvents).not.toBe('none');
  });
});
