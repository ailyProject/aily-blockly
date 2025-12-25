import * as Blockly from "blockly";

type BlockSvg = Blockly.BlockSvg;
const InputRow = Blockly.blockRendering.InputRow;
const JaggedEdge = Blockly.blockRendering.JaggedEdge;
const Icon = Blockly.blockRendering.Icon;
const Field = Blockly.blockRendering.Field;
type Row = Blockly.blockRendering.Row;
const Types = Blockly.blockRendering.Types;

export class RenderInfo extends Blockly.thrasos.RenderInfo {

  constructor(renderer: any, block: BlockSvg) {
    super(renderer, block);
  }

  override createRows_() {
    this.populateTopRow_();
    this.rows.push(this.topRow);
    let activeRow = new InputRow(this.constants_);
    this.inputRows.push(activeRow);

    // Icons always go on the first row, before anything else.
    const icons = this.block_.getIcons();
    for (let i = 0, icon; (icon = icons[i]); i++) {
      const iconInfo = new Icon(this.constants_, icon);
      if (!this.isCollapsed || icon.isShownWhenCollapsed()) {
        activeRow.elements.push(iconInfo);
      }
    }

    let lastInput = undefined;
    // Loop across all of the inputs on the block, creating objects for anything
    // that needs to be rendered and breaking the block up into visual rows.
    for (let i = 0, input; (input = this.block_.inputList[i]); i++) {
      if (!input.isVisible()) {
        continue;
      }
      if (this.shouldStartNewRow_(input, lastInput)) {
        // Finish this row and create a new one.
        this.rows.push(activeRow);
        activeRow = new InputRow(this.constants_);
        this.inputRows.push(activeRow);
      }

      let firstField = false;

      // All of the fields in an input go on the same row.
      for (let j = 0, field; (field = input.fieldRow[j]); j++) {
        const fieldInfo = new Field(this.constants_, field, input);
        // if (!firstField && Types.isField(fieldInfo)) {
        //   firstField = true;
        //   // fieldInfo.width = fieldInfo.width + 30;
        // }
        activeRow.elements.push(fieldInfo);
      }
      this.addInput_(input, activeRow);
      lastInput = input;
    }

    if (this.isCollapsed) {
      activeRow.hasJaggedEdge = true;
      activeRow.elements.push(new JaggedEdge(this.constants_));
    }

    if (activeRow.elements.length || activeRow.hasDummyInput) {
      this.rows.push(activeRow);
    }
    this.populateBottomRow_();
    this.rows.push(this.bottomRow);
  }

  // override recordElemPositions_(row: Row) {
  //   let xCursor = row.xPos;
  //   let firstField = false;
  //   for (let j = 0, elem; (elem = row.elements[j]); j++) {
  //     // Now that row heights are finalized, make spacers use the row height.
  //     if (Types.isSpacer(elem)) {
  //       elem.height = row.height;
  //     }
  //     elem.xPos = xCursor;
  //     if (!firstField && Types.isField(elem)) {
  //       firstField = true;
  //       elem.xPos = xCursor + 0;
  //     } else {
  //       elem.xPos = xCursor;
  //     }
  //     elem.centerline = this.getElemCenterline_(row, elem);
  //     xCursor += elem.width;
  //   }
  // }
  //
  // override finalize_() {
  //   // Performance note: this could be combined with the draw pass, if the time
  //   // that this takes is excessive.  But it shouldn't be, because it only
  //   // accesses and sets properties that already exist on the objects.
  //   let widestRowWithConnectedBlocks = 0;
  //   let yCursor = 0;
  //   for (let i = 0, row; (row = this.rows[i]); i++) {
  //     row.yPos = yCursor;
  //     row.xPos = this.startX;
  //     yCursor += row.height;
  //
  //     widestRowWithConnectedBlocks = Math.max(
  //       widestRowWithConnectedBlocks,
  //       row.widthWithConnectedBlocks,
  //     );
  //     this.recordElemPositions_(row);
  //   }
  //   if (this.outputConnection && this.block_.nextConnection) {
  //     const target = this.block_.nextConnection.targetBlock();
  //     if (target) {
  //       // Include width of connected block in value to stack width measurement.
  //       widestRowWithConnectedBlocks = Math.max(
  //         widestRowWithConnectedBlocks,
  //         target.getHeightWidth().width,
  //       );
  //     }
  //   }
  //
  //   this.widthWithChildren = widestRowWithConnectedBlocks + this.startX;
  //
  //   this.height = yCursor;
  //   this.startY = this.topRow.capline;
  //   this.bottomRow.baseline = yCursor - this.bottomRow.descenderHeight;
  // }
}
