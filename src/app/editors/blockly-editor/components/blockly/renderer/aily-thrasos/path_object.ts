import * as Blockly from "blockly";
import { ConstantProvider } from './constant';

export class PathObject extends Blockly.blockRendering.PathObject {

  constructor(
    root: SVGElement,
    style: Blockly.Theme.BlockStyle,
    constants: ConstantProvider,
  ) {
    super(root, style, constants);
  }

}
