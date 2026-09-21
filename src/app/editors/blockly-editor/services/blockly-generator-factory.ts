import { createArduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { createMicroPythonGenerator } from '../components/blockly/generators/micropython/micropython';
import { createPythonGenerator } from '../components/blockly/generators/python/python';

export type BlocklyGeneratorMode = 'arduino' | 'micropython' | 'python';
export type ProjectGenerator = ReturnType<typeof createProjectGenerator>;

/** Same constructors in the active project and the independent native candidate. */
export function createProjectGenerator(mode: BlocklyGeneratorMode) {
  switch (mode) {
    case 'arduino': return createArduinoGenerator();
    case 'micropython': return createMicroPythonGenerator();
    case 'python': return createPythonGenerator();
    default: throw new Error(`Unsupported Blockly generator mode: ${mode}.`);
  }
}
