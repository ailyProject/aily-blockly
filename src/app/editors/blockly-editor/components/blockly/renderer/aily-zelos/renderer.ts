import * as Blockly from "blockly/core";
import { ConstantProvider } from "./constant";
import { addAilyIconToBlock, getBlockDefinition } from '../aily-icon/acon';

export class Renderer extends Blockly.zelos.Renderer {

  constructor(name: string) {
    super(name);
  }

  override makeConstants_(): ConstantProvider {
    return new ConstantProvider();
  }

  override makeRenderInfo_(block: any): Blockly.zelos.RenderInfo {
    let acon = getBlockDefinition(block.type);
    if (block && acon) {
      if (acon && typeof acon === "string" && !acon.includes("fa-")) {
        acon = `fa-solid ${acon}`;
      }
      addAilyIconToBlock(block, acon);
    }
    return new Blockly.zelos.RenderInfo(this, block);
  }
}

Blockly.blockRendering.register('aily-zelos', Renderer);
