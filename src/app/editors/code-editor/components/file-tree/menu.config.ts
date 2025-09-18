import { IMenuItem } from "../../../../configs/menu.config";

// 文件右键菜单配置
export const FILE_RIGHTCLICK_MENU: IMenuItem[] = [
    {
        name: 'MENU.FILE_COPY',
        action: 'file-copy',
        icon: 'fa-light fa-copy',
        type: 'file'
    },
    {
        name: 'MENU.FILE_CUT',
        action: 'file-cut',
        icon: 'fa-light fa-scissors',
        type: 'file'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FILE_RENAME',
        action: 'file-rename',
        icon: 'fa-light fa-pen',
        type: 'file'
    },
    {
        name: 'MENU.FILE_DELETE',
        action: 'file-delete',
        icon: 'fa-light fa-trash',
        type: 'file',
        color: '#ff4d4f'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FILE_COPY_PATH',
        action: 'file-copy-path',
        icon: 'fa-light fa-link',
        type: 'file'
    },
    {
        name: 'MENU.FILE_COPY_RELATIVE_PATH',
        action: 'file-copy-relative-path',
        icon: 'fa-light fa-link-simple',
        type: 'file'
    },
    {
        sep: true
    },
    {
        name: 'MENU.REVEAL_IN_EXPLORER',
        action: 'reveal-in-explorer',
        icon: 'fa-light fa-browsers',
        type: 'file'
    },
    // {
    //     sep: true
    // },
    // {
    //     name: 'MENU.FILE_PROPERTIES',
    //     action: 'file-properties',
    //     icon: 'fa-light fa-info-circle',
    //     type: 'file'
    // }
];

// 文件夹右键菜单配置
export const FOLDER_RIGHTCLICK_MENU: IMenuItem[] = [
    {
        name: 'MENU.FOLDER_NEW_FILE',
        action: 'folder-new-file',
        icon: 'fa-light fa-file-plus',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_NEW_FOLDER',
        action: 'folder-new-folder',
        icon: 'fa-light fa-folder-plus',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_COPY',
        action: 'folder-copy',
        icon: 'fa-light fa-copy',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_CUT',
        action: 'folder-cut',
        icon: 'fa-light fa-scissors',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_PASTE',
        action: 'folder-paste',
        icon: 'fa-light fa-paste',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_RENAME',
        action: 'folder-rename',
        icon: 'fa-light fa-pen',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_DELETE',
        action: 'folder-delete',
        icon: 'fa-light fa-trash',
        type: 'folder',
        color: '#ff4d4f'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_COPY_PATH',
        action: 'folder-copy-path',
        icon: 'fa-light fa-link',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_COPY_RELATIVE_PATH',
        action: 'folder-copy-relative-path',
        icon: 'fa-light fa-link-simple',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.OPEN_IN_TERMINAL',
        action: 'open-in-terminal',
        icon: 'fa-light fa-square-terminal',
        type: 'folder'
    },
    {
        name: 'MENU.REVEAL_IN_EXPLORER',
        action: 'reveal-in-explorer',
        icon: 'fa-light fa-browsers',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_FIND_IN_FILES',
        action: 'find-in-files',
        icon: 'fa-light fa-magnifying-glass',
        type: 'folder'
    },
    // {
    //     sep: true
    // },
    // {
    //     name: 'MENU.FOLDER_PROPERTIES',
    //     action: 'folder-properties',
    //     icon: 'fa-light fa-info-circle',
    //     type: 'folder'
    // }
];

// 根文件夹（项目根目录）特殊菜单
export const ROOT_RIGHTCLICK_MENU: IMenuItem[] = [
    {
        name: 'MENU.FOLDER_NEW_FILE',
        action: 'folder-new-file',
        icon: 'fa-light fa-file-plus',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_NEW_FOLDER',
        action: 'folder-new-folder',
        icon: 'fa-light fa-folder-plus',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_PASTE',
        action: 'folder-paste',
        icon: 'fa-light fa-paste',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_COPY_PATH',
        action: 'folder-copy-path',
        icon: 'fa-light fa-link',
        type: 'folder'
    },
    {
        name: 'MENU.FOLDER_COPY_RELATIVE_PATH',
        action: 'folder-copy-relative-path',
        icon: 'fa-light fa-link-simple',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.OPEN_IN_TERMINAL',
        action: 'open-in-terminal',
        icon: 'fa-light fa-square-terminal',
        type: 'folder'
    },
    {
        name: 'MENU.REVEAL_IN_EXPLORER',
        action: 'reveal-in-explorer',
        icon: 'fa-light fa-browsers',
        type: 'folder'
    },
    {
        sep: true
    },
    {
        name: 'MENU.FOLDER_FIND_IN_FILES',
        action: 'find-in-files',
        icon: 'fa-light fa-magnifying-glass',
        type: 'folder'
    },
    // {
    //     sep: true
    // },
    // {
    //     name: 'MENU.FOLDER_PROPERTIES',
    //     action: 'folder-properties',
    //     icon: 'fa-light fa-info-circle',
    //     type: 'folder'
    // }
];

// 多选菜单配置
export const MULTI_SELECT_MENU: IMenuItem[] = [
    {
        name: 'MENU.MULTI_COPY',
        action: 'multi-copy',
        icon: 'fa-light fa-copy',
        type: 'multi'
    },
    {
        name: 'MENU.MULTI_CUT',
        action: 'multi-cut',
        icon: 'fa-light fa-scissors',
        type: 'multi'
    },
    {
        name: 'MENU.MULTI_DELETE',
        action: 'multi-delete',
        icon: 'fa-light fa-trash',
        type: 'multi',
        color: '#ff4d4f'
    },
    {
        sep: true
    },
    {
        name: 'MENU.MULTI_COMPRESS',
        action: 'multi-compress',
        icon: 'fa-light fa-file-zipper',
        type: 'multi'
    }
];