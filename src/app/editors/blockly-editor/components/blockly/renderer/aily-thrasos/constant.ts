import * as Blockly from "blockly";

const svgPaths = Blockly.utils.svgPaths;

export class ConstantProvider extends Blockly.blockRendering.ConstantProvider {

  constructor() {
    super();
  }

  override makeStartHat(): Blockly.blockRendering.StartHat {
    const height = this.START_HAT_HEIGHT;
    const width = this.START_HAT_WIDTH;

    const mainPath = svgPaths.curve('c', [
      svgPaths.point(30, -height),
      svgPaths.point(70, -height),
      svgPaths.point(width, 0),
    ]);
    return { height: 0, width, path: mainPath };
  }
}
