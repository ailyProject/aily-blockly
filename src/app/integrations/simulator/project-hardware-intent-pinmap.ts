import { validateSceneDiagramBoardPinmap, type SceneDiagramBoardPinmap } from '@aily-project/scene-model';

export async function readProjectHardwareBoardPinmap(packagePath: string, board: unknown): Promise<SceneDiagramBoardPinmap | undefined> {
  const fs = window['fs'];
  const path = window['path'];
  const root = await fs.realpathAsync(packagePath);
  const filename = path.join(root, 'pinmap.json');
  const config = record(board);

  try {
    if (!fs.existsSync(filename)) return schematicBoardPinmap(config);
    if (await fs.realpathAsync(filename) !== filename) return undefined;

    const stat = fs.statSync(filename);

    if (!stat._isFile || stat.size > 256 * 1024) return undefined;

    const pinmap = record(JSON.parse(fs.readFileSync(filename, 'utf8')));

    const pins = Array.isArray(pinmap['pins']) ? pinmap['pins'].map(raw => {
      const pin = record(raw);

      const functions = Array.isArray(pin['functions']) ? pin['functions'].map(record)
        .filter(fn => fn['disabled'] !== true && fn['visible'] !== false)
        .map(fn => ({ name: fn['name'], type: fn['type'] })) : [];

      return { id: pin['id'], x: Number(pin['x']), y: Number(pin['y']),
        layout: pin['layout'] === 'vertical' ? 'vertical' : 'horizontal', functions };
    }) : [];

    // Retain relative connector positions even for older pinmaps that extend past their canvas.
    const left = Math.min(0, ...pins.map(pin => pin.x));
    const top = Math.min(0, ...pins.map(pin => pin.y));
    const builtInLeds = boardBuiltInLeds(config);

    return validateSceneDiagramBoardPinmap({
      name: pinmap['name'] || config['name'],
      width: Math.max(Number(pinmap['width']), ...pins.map(pin => pin.x)) - left,
      height: Math.max(Number(pinmap['height']), ...pins.map(pin => pin.y)) - top,
      pins: pins.map(pin => ({ ...pin, x: pin.x - left, y: pin.y - top })),
      ...(builtInLeds.length ? { builtInLeds } : {}),
    });
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;

    return undefined;
  }
}

function schematicBoardPinmap(config: Record<string, unknown>): SceneDiagramBoardPinmap | undefined {
  const contacts = new Map<string, Map<string, { name: string; type: string }>>();

  const add = (token: string, name: string, type: string) => {
    const functions = contacts.get(token) ?? new Map();

    functions.set(`${type}:${name}`, { name, type });
    contacts.set(token, functions);
  };

  for (const [key, type] of [['digitalPins', 'digital'], ['analogPins', 'analog'], ['pwmPins', 'pwm']] as const) {
    const entries = config[key];

    if (!Array.isArray(entries)) continue;

    for (const row of entries) {
      if (!Array.isArray(row)) continue;

      const token = pinToken(row[1]);

      if (!token || token.toUpperCase() === 'GND') continue;

      add(token, token, type);

      const label = pinToken(row[0]);

      if (label) add(token, label, type);
    }
  }

  for (const [key, type] of [['spiPins', 'spi'], ['i2cPins', 'i2c'], ['serialPins', 'uart']] as const) {
    for (const entries of Object.values(record(config[key]))) {
      if (!Array.isArray(entries)) continue;

      for (const row of entries) {
        if (!Array.isArray(row)) continue;

        const token = pinToken(row[1]);
        const role = pinToken(row[0]);

        if (!token || !role || !contacts.has(token)) continue;

        add(token, role, type);
      }
    }
  }

  if (!contacts.size) return undefined;

  // A schematic reference node gives signal returns a common point without guessing a supply rail or physical layout.
  add('GND', 'GND', 'gnd');

  const rows = Math.ceil(contacts.size / 2);
  const width = 140;
  const height = (rows + 1) * 20;
  const builtInLeds = boardBuiltInLeds(config);

  return validateSceneDiagramBoardPinmap({
    name: config['name'], width, height,
    pins: [...contacts.values()].map((functions, index) => ({
      id: `pin_${index + 1}`,
      x: index < rows ? 12 : width - 12,
      y: (index % rows + 1) * 20,
      layout: 'horizontal',
      functions: [...functions.values()],
    })),
    ...(builtInLeds.length ? { builtInLeds } : {}),
  });
}

function boardBuiltInLeds(config: Record<string, unknown>): string[] {
  const leds = config['builtinLed'];

  if (!Array.isArray(leds)) return [];

  return leds.flatMap(led => {
    const token = Array.isArray(led) ? led[1] : undefined;

    return typeof token === 'number' || (typeof token === 'string' && token.trim()) ? [String(token).trim()] : [];
  });
}

function pinToken(value: unknown): string | undefined {
  const token = typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) ? String(value) : '';

  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/u.test(token) && !/^NC$/iu.test(token) ? token : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
