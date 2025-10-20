import { IMenuItem } from "./menu.config";

export let STM32_CONFIG_MENU: IMenuItem[] = [
    {
        sep: true,
    },
    {
        name: 'STM32.BOARD',
        data: {},
        icon: "fa-light fa-microchip",
        children: []
    },
    {
        name: 'STM32.USB',
        data: {},
        icon: "fa-light fa-usb-drive",
        children: []
    },
    // {
    //     name: 'STM32.UPLOAD_METHOD',
    //     data: {},
    //     icon: "fa-light fa-cloud-arrow-up",
    //     children: []
    // }
]