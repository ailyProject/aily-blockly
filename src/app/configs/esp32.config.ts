import { IMenuItem } from "./menu.config";

export let ESP32_CONFIG_MENU: IMenuItem[] = [
    {
        sep: true,
    },
    {
        name: 'ESP32.UPLOAD_SPEED',
        data: {},
        icon: "fa-light fa-up-from-line",
        children: []
    },
    {
        name: 'ESP32.FLASH_MODE',
        data: {},
        icon: 'fa-light fa-tablet-rugged',
        children: []
    },
    {
        name: 'ESP32.FLASH_SIZE',
        data: {},
        icon: "fa-light fa-database",
        children: []
    },
    {
        name: 'ESP32.PARTITION_SCHEME',
        data: {},
        icon: "fa-light fa-hard-drive",
        children: []
    },
]