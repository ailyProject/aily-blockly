// Readonly-library audit. Seed was drawn before executing any selected library.
const selection = {
  seed: 'da1692043c747bd2',
  pool: ['RTC', 'aily_iic', 'simple-keypad', 'seeed_mmwave', 'unihiker_k10_speech', 'ai-vox-xzai'],
  method: 'Sort SHA256(seed + ":" + directory), take first five',
};
const cases = [
  { library: 'aily_iic', types: ['wire_begin'], rounds: [
    { calls: ['wire_begin(Wire, SLAVE, math_number(8))'], fields: { MODE: 'SLAVE' }, inputs: ['ADDRESS'], code: 'Wire.begin(8)' },
    { calls: ['wire_begin(Wire, MASTER)'], fields: { MODE: 'MASTER' }, absentInputs: ['ADDRESS'], code: 'Wire.begin()' },
    { calls: ['wire_begin(Wire, SLAVE, math_number(32))'], fields: { MODE: 'SLAVE' }, inputs: ['ADDRESS'], code: 'Wire.begin(32)' },
  ] },
  { library: 'seeed_mmwave', types: ['mmwave_init'], createVariables: [{ name: 'radar', type: 'SeeedMmwave' }], rounds: [
    { calls: ['mmwave_init("radar", SOFTWARE, D0, D1)'], fields: { SERIAL_TYPE: 'SOFTWARE', RX_PIN: 'D0', TX_PIN: 'D1' }, code: 'radarSerial(D0, D1)' },
    { calls: ['mmwave_init("radar", SERIAL1)'], fields: { SERIAL_TYPE: 'SERIAL1' }, absentFields: ['RX_PIN', 'TX_PIN'], code: 'radar(Serial1)' },
    { calls: ['mmwave_init("radar", SOFTWARE, D2, D3)'], fields: { SERIAL_TYPE: 'SOFTWARE', RX_PIN: 'D2', TX_PIN: 'D3' }, code: 'radarSerial(D2, D3)' },
  ] },
  { library: 'RTC', types: ['rtc_init'], createVariables: [{ name: 'clock3', type: 'RtcDS1302' }, { name: 'clock2', type: 'RtcDS3231' }], rounds: [
    { calls: ['rtc_init("clock3", DS1302, D0, D1, D2)', 'rtc_init("clock2", DS3231, D4, D5)'],
      instances: [{ fields: { VAR: 'clock3', DAT_PIN: 'D0', CLK_PIN: 'D1', RST_PIN: 'D2' } }, { fields: { VAR: 'clock2', SDA_PIN: 'D4', SCL_PIN: 'D5' } }], code: 'RtcDS1302<ThreeWire>' },
    { calls: ['rtc_init("clock3", DS1302, D3, D4, D5)', 'rtc_init("clock2", DS3231, D0, D1)'],
      batchEdit: true,
      instances: [{ fields: { VAR: 'clock3', DAT_PIN: 'D3', CLK_PIN: 'D4', RST_PIN: 'D5' } }, { fields: { VAR: 'clock2', SDA_PIN: 'D0', SCL_PIN: 'D1' } }], code: 'RtcDS3231<TwoWire>' },
    // Batch edits retain both identities. Later rounds also test ordinary writes.
    { calls: ['rtc_init("clock3", DS1302, D3, D4, D5)', 'rtc_init("clock2", DS3231, D4, D5)'],
      instances: [{ fields: { VAR: 'clock3', DAT_PIN: 'D3', CLK_PIN: 'D4', RST_PIN: 'D5' } }, { fields: { VAR: 'clock2', SDA_PIN: 'D4', SCL_PIN: 'D5' } }], code: 'RtcDS1302<ThreeWire>' },
    { calls: ['rtc_init("clock3", DS1302, D3, D4, D5)', 'rtc_init("clock2", DS3231, D0, D1)'],
      instances: [{ fields: { VAR: 'clock3', DAT_PIN: 'D3', CLK_PIN: 'D4', RST_PIN: 'D5' } }, { fields: { VAR: 'clock2', SDA_PIN: 'D0', SCL_PIN: 'D1' } }], code: 'RtcDS3231<TwoWire>' },
  ] },
  { library: 'simple-keypad', types: ['simple_keypad_init'], createVariables: [{ name: 'keypad', type: 'SimpleKeypad' }], rounds: [
    { calls: ['simple_keypad_init("keypad", "4x4", "123A456B789C*0#D", ROW_0=D0, ROW_1=D1, ROW_2=D2, ROW_3=D3, COL_0=D4, COL_1=D5, COL_2=D6, COL_3=D7)'], fields: { LAYOUT: '4x4', ROW_3: 'D3', COL_3: 'D7' }, code: 'keypad_colPins, 4, 4)' },
    { calls: ['simple_keypad_init("keypad", "3x1", "123", ROW_0=D0, ROW_1=D1, ROW_2=D2, COL_0=D3)'], fields: { LAYOUT: '3x1', COL_0: 'D3' }, absentFields: ['ROW_3', 'COL_1', 'COL_2', 'COL_3'], code: 'keypad_colPins, 3, 1)' },
    { calls: ['simple_keypad_init("keypad", "4x4", "123A456B789C*0#D", ROW_0=D0, ROW_1=D1, ROW_2=D2, ROW_3=D3, COL_0=D4, COL_1=D5, COL_2=D6, COL_3=D7)'], fields: { LAYOUT: '4x4', ROW_3: 'D3', COL_3: 'D7' }, code: 'keypad_colPins, 4, 4)' },
  ] },
  { library: 'unihiker_k10_speech', types: ['k10_asr_speak'], rounds: [
    { calls: ['k10_asr_speak(text("hello"), 1)'], fields: { INTERVAL: 1 }, inputs: ['TEXT', 'INTERVAL'], code: 'k10AsrSpeakSafe(asr, "hello", 1,' },
    { calls: ['k10_asr_speak(text("world"), 2.5)'], fields: { INTERVAL: 2.5 }, inputs: ['TEXT', 'INTERVAL'], code: 'k10AsrSpeakSafe(asr, "world", 2.5,' },
    { calls: ['k10_asr_speak(TEXT=text("world"), INTERVAL=2.5)'], fields: { INTERVAL: 2.5 }, inputs: ['TEXT', 'INTERVAL'], code: 'k10AsrSpeakSafe(asr, "world", 2.5,' },
    { calls: ['k10_asr_speak(text("legacy"), 2.5, math_number(9))'], fields: { INTERVAL: 2.5 }, inputValues: { INTERVAL: 9 }, inputs: ['TEXT', 'INTERVAL'], code: 'k10AsrSpeakSafe(asr, "legacy", 2.5,' },
    { calls: ['k10_asr_speak(text("legacy"), 3, math_number(9))'], fields: { INTERVAL: 3 }, inputValues: { INTERVAL: 9 }, inputs: ['TEXT', 'INTERVAL'], code: 'k10AsrSpeakSafe(asr, "legacy", 3,' },
  ] },
];
module.exports = process.env.AILY_ABS_ACCEPTANCE_SET === 'final'
  ? require('./abs-final-library-cases.cjs') : { selection, cases };
