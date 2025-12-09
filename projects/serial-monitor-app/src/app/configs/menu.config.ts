export interface IMenuItem {
  name?: string;
  text?: string;
  action?: string;
  type?: string;
  data?: any;
  icon?: string;
  color?: string;
  more?: string;
  sep?: boolean;
  state?: 'default' | 'doing' | 'done' | 'error' | 'warn';
  disabled?: boolean;
  dev?: boolean;
  router?: string[]; // 在指定路由中显示
  children?: IMenuItem[],
  extra?: any,
  check?: boolean,
  key?: string; // 用于标识编译和上传配置
}
