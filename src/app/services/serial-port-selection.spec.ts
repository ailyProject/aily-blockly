import { selectSerialPort, type SerialPortSelectionCandidate } from './serial-port-selection';

describe('selectSerialPort', () => {
  const ports: SerialPortSelectionCandidate[] = [
    {
      name: '/dev/cu.usbmodem101',
      text: 'Arduino Uno',
      type: 'serial',
      vendorId: '2341',
      productId: '0043',
    },
    {
      name: '/dev/cu.usbserial-210',
      text: 'USB Serial',
      type: 'serial',
      vendorId: '10c4',
      productId: 'ea60',
    },
  ];

  it('uses an explicitly requested available port', () => {
    const result = selectSerialPort(ports, { requestedPort: '/dev/cu.usbserial-210' });

    expect(result.selected?.name).toBe('/dev/cu.usbserial-210');
    expect(result.reason).toBe('explicit_port');
  });

  it('preserves the main application current selection when it is still connected', () => {
    const result = selectSerialPort(ports, { currentPort: '/dev/cu.usbmodem101' });

    expect(result.selected?.name).toBe('/dev/cu.usbmodem101');
    expect(result.reason).toBe('current_port');
  });

  it('uses board VID and PID metadata when exactly one device matches', () => {
    const result = selectSerialPort(ports, {
      boardConfig: {
        usb: {
          vendorId: '0x10c4',
          productId: '0xea60',
        },
      },
    });

    expect(result.selected?.name).toBe('/dev/cu.usbserial-210');
    expect(result.reason).toBe('board_usb_match');
    expect(result.confidence).toBe('high');
  });

  it('can exclude a Bluetooth system port and select the only flash candidate', () => {
    const result = selectSerialPort([
      {
        name: '/dev/cu.Bluetooth-Incoming-Port',
        text: 'Bluetooth',
        type: 'serial',
      },
      {
        name: '/dev/cu.usbmodem101',
        text: 'USB Serial',
        type: 'serial',
      },
    ]);

    expect(result.selected?.name).toBe('/dev/cu.usbmodem101');
    expect(result.reason).toBe('device_score');
  });

  it('refuses to guess when multiple equally plausible ports remain', () => {
    const result = selectSerialPort(ports);

    expect(result.selected).toBeNull();
    expect(result.reason).toBe('ambiguous');
    expect(result.message).toContain('请显式指定 port');
  });
});
