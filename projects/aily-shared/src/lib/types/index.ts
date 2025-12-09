/**
 * 共享类型定义导出
 * 在此文件中导出所有共享类型
 */

// 示例：当你添加类型后，取消注释并修改
// export * from './common.types';

/**
 * 窗口配置选项接口
 */
export interface WindowOpts {
  path: string;
  title?: string;
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
  resizable?: boolean;
  modal?: boolean;
}

/**
 * 菜单项接口
 */
export interface IMenuItem {
  label: string;
  icon?: string;
  action?: string;
  disabled?: boolean;
  children?: IMenuItem[];
  divider?: boolean;
}
