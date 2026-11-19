'use strict';
// Loaded only by the explicitly spawned test daemon; no real serial driver opens.
const path = require('node:path');
const { createRequire } = require('node:module');
const serial = createRequire(path.join(process.env.SERIAL_SUBAPP_ROOT, 'package.json'));
const { FakeSerialPort } = serial('./test/fake-serial-port');
FakeSerialPort.reset();
FakeSerialPort.ports = ['CRASH_A', 'CRASH_B'].map(path => ({ path }));
FakeSerialPort.onWrite = (port, data) => queueMicrotask(() => port.receive(`${port.path}:${data}`));
const driver = serial.resolve('serialport');
serial(driver);
require.cache[driver].exports = { SerialPort: FakeSerialPort };
