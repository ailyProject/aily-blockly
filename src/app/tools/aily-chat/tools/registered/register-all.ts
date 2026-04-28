/**
 * 工具统一注册入口
 *
 * 导入此模块会触发所有已注册工具的副作用注册（ToolRegistry.register）。
 * 在应用初始化时导入一次即可。
 *
 * 用法:
 *   import './tools/registered/register-all';
 */

// 文件操作类
import './file-tools';

// 项目、系统、搜索、TODO 类
import './project-tools';

// Blockly 块操作类
import './blockly-tools';

// 连线图 / Schematic 类
import './schematic-tools';

// ABS / ABI / 工具类
import './abs-tools';
