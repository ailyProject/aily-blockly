import * as Blockly from 'blockly';
import { Field } from 'blockly';
type PuzzleTab = Blockly.blockRendering.PuzzleTab;
const svgPaths = Blockly.utils.svgPaths;
const isDynamicShape = (Blockly.constants as any).isDynamicShape;

type BlockSvg = Blockly.BlockSvg;
type RenderInfo = Blockly.thrasos.RenderInfo;
const Types = Blockly.blockRendering.Types;
type InlineInput = Blockly.blockRendering.InlineInput;

export class Drawer extends Blockly.blockRendering.Drawer {
  constructor(block: BlockSvg, info: RenderInfo) {
    super(block, info);
  }

  // override drawLeft_() {
  //   // const outputConnection: any = this.info_.outputConnection;
  //   // this.positionOutputConnection_();
  //   //
  //   // if (outputConnection) {
  //   //   const tabBottom =
  //   //     outputConnection.connectionOffsetY + outputConnection.height;
  //   //   const pathUp = isDynamicShape(outputConnection.shape)
  //   //     ? outputConnection.shape.pathUp(outputConnection.height)
  //   //     : (outputConnection.shape as PuzzleTab).pathUp;
  //   //
  //   //   // Draw a line up to the bottom of the tab.
  //   //   this.outlinePath_ += svgPaths.lineOnAxis('V', tabBottom) + pathUp;
  //   // }
  //   // // Close off the path.  This draws a vertical line up to the start of the
  //   // // block's path, which may be either a rounded or a sharp corner.
  //   // this.outlinePath_ += 'z';
  //   super.drawLeft_();
  // }

  // override drawInternals_() {
  //   for (let i = 0, row; (row = this.info_.rows[i]); i++) {
  //     for (let j = 0, elem; (elem = row.elements[j]); j++) {
  //       if (Types.isInlineInput(elem)) {
  //         this.drawInlineInput_(elem as InlineInput);
  //       } else if (Types.isIcon(elem) || Types.isField(elem)) {
  //         this.layoutField_(elem as Field | any);
  //       }
  //     }
  //   }
  // }

}
