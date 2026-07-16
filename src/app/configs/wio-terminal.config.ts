import { IMenuItem } from './menu.config';

export const WIO_TERMINAL_CONFIG_MENU: IMenuItem[] = [
  {
    sep: true,
  },
  {
    name: 'WIO_TERMINAL.ROLE',
    icon: 'fa-light fa-user-gear',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.CACHE',
    icon: 'fa-light fa-memory',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.CPU_SPEED',
    icon: 'fa-light fa-microchip',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.OPTIMIZATION',
    icon: 'fa-light fa-gauge-high',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.MAX_QSPI',
    icon: 'fa-light fa-bolt',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.USB_STACK',
    icon: 'fa-brands fa-usb',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.DEBUG',
    icon: 'fa-light fa-bug',
    children: [],
  },
  {
    name: 'WIO_TERMINAL.TX_RX_LED',
    icon: 'fa-light fa-lightbulb',
    children: [],
  },
];
