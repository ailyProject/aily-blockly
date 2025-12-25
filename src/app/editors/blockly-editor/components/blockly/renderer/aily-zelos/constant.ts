import * as Blockly from "blockly";

const svgPaths = Blockly.utils.svgPaths;

export class ConstantProvider extends Blockly.zelos.ConstantProvider {

  constructor() {
    super();
  }

  override makeStartHat() {
    const height = this.START_HAT_HEIGHT;
    const width = this.START_HAT_WIDTH;

    const mainPath = svgPaths.curve('c', [
      svgPaths.point(25, -height),
      svgPaths.point(71, -height),
      svgPaths.point(width, 0),
    ]);
    return { height: 0, width, path: mainPath };
  }
}
