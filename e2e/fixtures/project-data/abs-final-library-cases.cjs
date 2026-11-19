// Fixed before running the final acceptance; failed samples must not be replaced.
const selection = {
  seed: 'cda244f93f8e6d04',
  method: 'Rank each stratum by SHA256(seed + ":" + directory); take 5 dynamic and 2 regular',
  pools: {
    dynamic: ['RFID', 'seeed_HM3301', 'spa06', 'ai-vox-xzai', 'arduino_r4_LED_Matrix', 'pid'],
    regular: ['adafruit_SHT3x', 'NTPClient', 'ArduinoFFT', 'seeed_ultrasonic', 'serial_transfer', 'ChainableLED', 'emakefun_motor_driver'],
  },
  selected: { dynamic: ['ai-vox-xzai', 'seeed_HM3301', 'arduino_r4_LED_Matrix', 'spa06', 'pid'], regular: ['serial_transfer', 'ArduinoFFT'] },
};
const pattern = index => `led_matrix_custom_pattern(${JSON.stringify(Array.from({ length: 8 }, (_, y) => Array.from({ length: 12 }, (_, x) => +(x === index && y === index))))})`;
const cases = [
  { library: 'ai-vox-xzai', types: ['esp32_i2s_mic_setup'], rounds: [
    { calls: ['esp32_i2s_mic_setup(AUDIO_INPUT_DEVICE_TYPE_I2S_STD, 13, 11, 12)'], fields: { MIC_TYPE: 'AUDIO_INPUT_DEVICE_TYPE_I2S_STD', SCK_PIN_INPUT: 13, SD_PIN_INPUT: 11, WS_PIN_INPUT: 12 }, code: 'kMicPinWs = GPIO_NUM_12' },
    { calls: ['esp32_i2s_mic_setup(AUDIO_INPUT_DEVICE_TYPE_PDM, 4, 5)'], fields: { MIC_TYPE: 'AUDIO_INPUT_DEVICE_TYPE_PDM', SCK_PIN_INPUT: 4, SD_PIN_INPUT: 5 }, absentFields: ['WS_PIN_INPUT'], absentInputs: ['WS_PIN_INPUT'], code: 'kMicPinSd = GPIO_NUM_5' },
    { calls: ['esp32_i2s_mic_setup(AUDIO_INPUT_DEVICE_TYPE_I2S_STD, 6, 7, 8)'], fields: { MIC_TYPE: 'AUDIO_INPUT_DEVICE_TYPE_I2S_STD', SCK_PIN_INPUT: 6, SD_PIN_INPUT: 7, WS_PIN_INPUT: 8 }, code: 'kMicPinWs = GPIO_NUM_8' },
  ] },
  { library: 'seeed_HM3301', types: ['hm3301_init', 'serial_println'], rounds: [
    { calls: ['hm3301_init(D0, D1)', 'serial_println(Serial, hm3301_read(PM1_0_STD))'], instances: [{ fields: { SDA_PIN: 'D0', SCL_PIN: 'D1' } }, {}], code: 'hm3301_read_value(2)' },
    { calls: ['hm3301_init(D2, D3)', 'serial_println(Serial, hm3301_read(PM2_5_ATM))'], batchEdit: true, instances: [{ fields: { SDA_PIN: 'D2', SCL_PIN: 'D3' } }, {}], code: 'hm3301_read_value(6)' },
    { calls: ['hm3301_init(D4, D5)', 'serial_println(Serial, hm3301_read(PM10_STD))'], batchEdit: true, instances: [{ fields: { SDA_PIN: 'D4', SCL_PIN: 'D5' } }, {}], code: 'hm3301_read_value(4)' },
  ] },
  { library: 'arduino_r4_LED_Matrix', types: ['led_matrix_init', 'led_matrix_display_animation'], rounds: [
    { calls: ['led_matrix_init()', `led_matrix_display_animation("100", ${pattern(0)}, ${pattern(1)})`], instances: [{}, { fields: { DELAY: '100' }, inputs: ['ADD0', 'ADD1'], absentInputs: ['ADD2'] }], code: 'matrix.play(true)' },
    // Preserve the native state actually exported in round one. The README alone
    // omits it; unknown serializer keys must not be guessed from a named slot.
    { calls: ['led_matrix_init()', `led_matrix_display_animation("200", ${pattern(0)}, ${pattern(1)}, ADD2=${pattern(2)}) @extra:{"itemCount":3}`],
      invalidCalls: ['led_matrix_init()', `led_matrix_display_animation("200", ${pattern(0)}, ${pattern(1)}, ADD2=${pattern(2)})`],
      instances: [{}, { fields: { DELAY: '200' }, inputs: ['ADD0', 'ADD1', 'ADD2'], extraState: { itemCount: 3 } }], code: 'matrix.play(true)' },
    { calls: ['led_matrix_init()', `led_matrix_display_animation("50", ${pattern(0)}, ${pattern(1)}) @extra:{"itemCount":2}`], instances: [{}, { fields: { DELAY: '50' }, inputs: ['ADD0', 'ADD1'], absentInputs: ['ADD2'], extraState: { itemCount: 2 } }], code: 'matrix.play(true)' },
  ] },
  { library: 'spa06', types: ['spa06_create_i2c', 'spa06_set_mode'], createVariables: [{ name: 'pressure', type: 'SPL07_003' }], rounds: [
    { calls: ['spa06_create_i2c("pressure", "0x76", D0, D1)', 'spa06_set_mode($pressure, SPL07_IDLE)'], instances: [{ fields: { VAR: 'pressure', ADDR: '0x76', SDA_PIN: 'D0', SCL_PIN: 'D1' } }, { fields: { MODE: 'SPL07_IDLE' } }], code: 'pressure.setMode(SPL07_IDLE)' },
    { calls: ['spa06_create_i2c("pressure", "0x77", D2, D3)', 'spa06_set_mode($pressure, SPL07_CONT_PRES_TEMP)'], batchEdit: true, instances: [{ fields: { VAR: 'pressure', ADDR: '0x77', SDA_PIN: 'D2', SCL_PIN: 'D3' } }, { fields: { MODE: 'SPL07_CONT_PRES_TEMP' } }], code: 'pressure.setMode(SPL07_CONT_PRES_TEMP)' },
    { calls: ['spa06_create_i2c("pressure", "0x76", D4, D5)', 'spa06_set_mode($pressure, SPL07_ONE_PRESSURE)'], batchEdit: true, instances: [{ fields: { VAR: 'pressure', ADDR: '0x76', SDA_PIN: 'D4', SCL_PIN: 'D5' } }, { fields: { MODE: 'SPL07_ONE_PRESSURE' } }], code: 'pressure.setMode(SPL07_ONE_PRESSURE)' },
  ] },
  { library: 'pid', types: ['pid_init', 'pid_set_setpoint'], createVariables: [{ name: 'controller', type: 'PID' }, ...['input', 'output', 'target'].map(name => ({ name, type: 'double' }))], rounds: [
    { calls: ['pid_init($controller, $input, $output, $target, temperature, 2, 0.1, 0.5, DIRECT)', 'pid_set_setpoint($target, math_number(25))'], instances: [{ fields: { PRESET: 'temperature', KP: 2, KI: 0.1, KD: 0.5 } }, { inputValues: { VALUE: 25 } }], code: 'target = 25' },
    { calls: ['pid_init($controller, $input, $output, $target, motor_speed, 1.5, 0.8, 0.2, DIRECT)', 'pid_set_setpoint($target, math_number(100))'], batchEdit: true, instances: [{ fields: { PRESET: 'motor_speed', KP: 1.5, KI: 0.8, KD: 0.2 } }, { inputValues: { VALUE: 100 } }], code: 'target = 100' },
    { calls: ['pid_init($controller, $input, $output, $target, custom, 3, 0.4, 0.6, REVERSE)', 'pid_set_setpoint($target, math_number(42))'], batchEdit: true, instances: [{ fields: { PRESET: 'custom', KP: 3, KI: 0.4, KD: 0.6, DIRECTION: 'REVERSE' } }, { inputValues: { VALUE: 42 } }], code: 'target = 42' },
  ] },
  { library: 'serial_transfer', types: ['serial_transfer_init', 'serial_transfer_send_int', 'serial_transfer_send_string'], createVariables: [{ name: 'link', type: 'SerialTransfer' }], rounds: [
    { calls: ['serial_transfer_init("link", Serial, math_number(9600))', 'serial_transfer_send_int($link, math_number(7), math_number(1))', 'serial_transfer_send_string($link, text("hello 中文"), math_number(2))'], instances: [{ fields: { VAR: 'link', SERIAL: 'Serial' }, inputValues: { BAUD: 9600 } }, { inputValues: { VALUE: 7, PACKET_ID: 1 } }, {}], code: 'String("hello 中文")' },
    { calls: ['serial_transfer_init("link", Serial, math_number(115200))', 'serial_transfer_send_int($link, math_number(42), math_number(3))', 'serial_transfer_send_string($link, text("round two"), math_number(4))'], batchEdit: true, instances: [{ fields: { VAR: 'link', SERIAL: 'Serial' }, inputValues: { BAUD: 115200 } }, { inputValues: { VALUE: 42, PACKET_ID: 3 } }, {}], code: 'String("round two")' },
    { calls: ['serial_transfer_init("link", Serial, math_number(57600))', 'serial_transfer_send_int($link, math_number(-3), math_number(5))', 'serial_transfer_send_string($link, text("final 😀"), math_number(6))'], batchEdit: true, instances: [{ fields: { VAR: 'link', SERIAL: 'Serial' }, inputValues: { BAUD: 57600 } }, { inputValues: { VALUE: -3, PACKET_ID: 5 } }, {}], code: 'String("final 😀")' },
  ] },
  { library: 'ArduinoFFT', types: ['arduino_fft_init', 'arduino_fft_generate_tone', 'arduino_fft_process'], createVariables: [{ name: 'fft', type: 'ArduinoFFT' }], rounds: [
    { calls: ['arduino_fft_init("fft", double, 64, math_number(5000))', 'arduino_fft_generate_tone($fft, math_number(1000), math_number(100), math_number(0))', 'arduino_fft_process($fft, FFT_WIN_TYP_HAMMING, TRUE, FALSE)'], instances: [{ fields: { DATA_TYPE: 'double', SAMPLES: '64' }, inputValues: { SAMPLING_FREQUENCY: 5000 } }, { inputValues: { FREQUENCY: 1000 } }, { fields: { WINDOW_TYPE: 'FFT_WIN_TYP_HAMMING' } }], code: 'ArduinoFFT<double>' },
    { calls: ['arduino_fft_init("fft", float, 128, math_number(8000))', 'arduino_fft_generate_tone($fft, math_number(2000), math_number(50), math_number(1))', 'arduino_fft_process($fft, FFT_WIN_TYP_HANN, FALSE, TRUE)'], batchEdit: true, instances: [{ fields: { DATA_TYPE: 'float', SAMPLES: '128' }, inputValues: { SAMPLING_FREQUENCY: 8000 } }, { inputValues: { FREQUENCY: 2000 } }, { fields: { WINDOW_TYPE: 'FFT_WIN_TYP_HANN' } }], code: 'ArduinoFFT<float>' },
    { calls: ['arduino_fft_init("fft", double, 256, math_number(10000))', 'arduino_fft_generate_tone($fft, math_number(500), math_number(25), math_number(0))', 'arduino_fft_process($fft, FFT_WIN_TYP_RECTANGLE, TRUE, TRUE)'], batchEdit: true, instances: [{ fields: { DATA_TYPE: 'double', SAMPLES: '256' }, inputValues: { SAMPLING_FREQUENCY: 10000 } }, { inputValues: { FREQUENCY: 500 } }, { fields: { WINDOW_TYPE: 'FFT_WIN_TYP_RECTANGLE' } }], code: 'ArduinoFFT<double>' },
  ] },
];
module.exports = { selection, cases };
