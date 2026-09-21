import type { AbsArgumentDefinition } from './abs-syntax';

// Read-only capture of the 2026-09-17 thermometer session's exported source and
// argument contracts. No user paths, model IDs, map, credentials or project writes.
export const original = "# ABS Schema: 2\n# Project Data Schema: 1 (external-only)\n\narduino_global()\n    variable_define(\"temperature\", float, math_number(0))\n    variable_define(\"humidity\", float, math_number(0))\narduino_setup()\n    serial_begin(Serial, \"115200\")\n    dht_init(\"dht\", DHT11, D3)\n    u8g2_begin(SSD1306, FULL_BUFFER, \"128X64_NONAME\", _HW_I2C, \"D5\", \"D4\", \"U8X8_PIN_NONE\")\narduino_loop()\n    variables_set($temperature, dht_read_temperature($dht))\n    variables_set($humidity, dht_read_humidity($dht))\n    serial_println(Serial, text_join(text(\"Temp: \"), number_to_string(variables_get($temperature)), text(\" C  Humi: \"), number_to_string(variables_get($humidity)), text(\" %\")) @extra:{\"itemCount\":5})\n    u8g2_clear_buffer()\n    u8g2_set_font(\"19\", CHINESE, u8g2_font_wqy16_t_chinese1)\n    u8g2_draw_str(math_number(0), math_number(22), text_join(text(\"Temp: \"), number_to_string(variables_get($temperature)), text(\" C\")) @extra:{\"itemCount\":3})\n    u8g2_draw_str(math_number(0), math_number(54), text_join(text(\"Humi: \"), number_to_string(variables_get($humidity)), text(\" %\")) @extra:{\"itemCount\":3})\n    u8g2_send_buffer()\n    time_delay(math_number(2000))";
const orders: Record<string, AbsArgumentDefinition[]> = {
  arduino_global: [{"kind":"statementInput","name":"ARDUINO_GLOBAL"}],
  variable_define: [{"kind":"field","name":"VAR"},{"kind":"field","name":"TYPE"},{"kind":"valueInput","name":"VALUE"}],
  math_number: [{"kind":"field","name":"NUM"}],
  arduino_setup: [{"kind":"statementInput","name":"ARDUINO_SETUP"}],
  serial_begin: [{"kind":"field","name":"SERIAL"},{"kind":"field","name":"SPEED"}],
  dht_init: [{"kind":"field","name":"VAR"},{"kind":"field","name":"TYPE"},{"kind":"field","name":"PIN"}],
  u8g2_begin: [{"kind":"field","name":"TYPE"},{"kind":"field","name":"MODE"},{"kind":"field","name":"RESOLUTION"},{"kind":"field","name":"PROTOCOL"},{"kind":"field","name":"SCL_PIN"},{"kind":"field","name":"SDA_PIN"},{"kind":"field","name":"RESET_PIN"}],
  arduino_loop: [{"kind":"statementInput","name":"ARDUINO_LOOP"}],
  variables_set: [{"kind":"field","name":"VAR"},{"kind":"valueInput","name":"VALUE"}],
  dht_read_temperature: [{"kind":"field","name":"VAR"}],
  dht_read_humidity: [{"kind":"field","name":"VAR"}],
  serial_println: [{"kind":"field","name":"SERIAL"},{"kind":"valueInput","name":"VAR"}],
  text: [{"kind":"field","name":"TEXT"}],
  number_to_string: [{"kind":"valueInput","name":"NUM"}],
  variables_get: [{"kind":"field","name":"VAR"}],
  u8g2_clear_buffer: [],
  u8g2_set_font: [{"kind":"field","name":"SIZE"},{"kind":"field","name":"FONT_TYPE"},{"kind":"field","name":"FONT"}],
  u8g2_draw_str: [{"kind":"valueInput","name":"X"},{"kind":"valueInput","name":"Y"},{"kind":"valueInput","name":"TEXT"}],
  u8g2_send_buffer: [],
  time_delay: [{"kind":"valueInput","name":"DELAY_TIME"}],
  controls_if: [{"kind":"valueInput","name":"IF0"},{"kind":"statementInput","name":"DO0"}],
  logic_compare: [{"kind":"valueInput","name":"A"},{"kind":"field","name":"OP"},{"kind":"valueInput","name":"B"}],
  logic_operation: [{"kind":"valueInput","name":"A"},{"kind":"field","name":"OP"},{"kind":"valueInput","name":"B"}],
  logic_ternary: [{"kind":"valueInput","name":"IF"},{"kind":"valueInput","name":"THEN"},{"kind":"valueInput","name":"ELSE"}],
  math_arithmetic: [{"kind":"valueInput","name":"A"},{"kind":"field","name":"OP"},{"kind":"valueInput","name":"B"}],
  time_millis: [],
};
export const syntax = { fieldDefinition: (type: string, name: string) => type === 'math_number' && name === 'NUM' ? { type: 'field_number' } : undefined,
  argumentOrder: (type: string, state?: any) => type === 'text_join'
  ? Array.from({ length: state?.itemCount ?? 2 }, (_, i) => ({ kind: 'valueInput' as const, name: 'ADD' + i }))
  : orders[type] };
