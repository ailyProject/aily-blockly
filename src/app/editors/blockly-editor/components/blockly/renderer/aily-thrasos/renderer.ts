import * as Blockly from "blockly";
import { ConstantProvider } from "./constant";
import { PathObject } from "./path_object";
import { Drawer } from "./drawer";
import { RenderInfo } from "./info";
import { ISerializable } from "blockly";
import { addAilyIconToBlock, getBlockDefinition } from "../aily-icon/acon";

type BlockSvg = Blockly.BlockSvg;
type BlockStyle = Blockly.Theme.BlockStyle;

export class Renderer extends Blockly.thrasos.Renderer {
  constructor(name: string) {
    super(name);
  }

  override makeConstants_() {
    return new ConstantProvider();
  }

  override makeRenderInfo_(block: any): Blockly.thrasos.RenderInfo {
    let acon = getBlockDefinition(block.type);
    if (block && acon) {
      if (acon && typeof acon === "string" && !acon.includes("fa-")) {
        acon = `fa-solid ${acon}`;
      }
      addAilyIconToBlock(block, acon);
    }
    return new Blockly.thrasos.RenderInfo(this, block);
    // return new RenderInfo(this, block);
  }

  // override makePathObject(root: SVGElement, style: BlockStyle): PathObject {
  //   return new PathObject(root, style, this.getConstants() as ConstantProvider);
  // }

  // protected override makeDrawer_(
  //   block: BlockSvg,
  //   info: RenderInfo,
  // ): Drawer {
  //   return new Drawer(block, info as RenderInfo);
  // }
}

Blockly.blockRendering.register("aily-thrasos", Renderer);
