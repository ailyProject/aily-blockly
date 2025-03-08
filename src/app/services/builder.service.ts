import { Injectable } from '@angular/core';
import { arduinoGenerator, DEFAULT_DATA } from '../blockly/generators/arduino/arduino';
import { BlocklyService } from '../blockly/blockly.service';
import { ProjectService } from './project.service';
import { ActionState, UiService } from './ui.service';
import { TerminalService } from '../tools/terminal/terminal.service';
import { NzMessageService } from 'ng-zorro-antd/message';

@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  constructor(
    private uiService: UiService,
    private blocklyService: BlocklyService,
    private projectService: ProjectService,
    private terminalService: TerminalService,
    private message: NzMessageService,
  ) { }

  async build(): Promise<ActionState> {
    const projectPath = this.projectService.currentProject;
    const tempPath = projectPath + '/.temp';
    const sketchPath = tempPath + '/sketch';
    const sketchFilePath = sketchPath + '/sketch.ino';
    const librariesPath = tempPath + '/libraries';
    const buildPath = tempPath + '/build';

    this.uiService.updateState({ state: 'doing', text: '编译准备中...' });

    // 创建临时文件夹
    await this.uiService.openTerminal();
    await this.terminalService.sendCmd(`New-Item -Path "${tempPath}" -ItemType Directory -Force`);
    await this.terminalService.sendCmd(`New-Item -Path "${sketchPath}" -ItemType Directory -Force`);
    await this.terminalService.sendCmd(`New-Item -Path "${librariesPath}" -ItemType Directory -Force`);
    
    await this.terminalService.sendCmd(`cd "${tempPath}"`);

    // 生成sketch文件
    const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
    await window['file'].writeFileSync(sketchFilePath, code);

    // TODO 生成libraries中的文件

    // 加载项目package.json
    const packageJson = JSON.parse(window['file'].readFileSync(`${projectPath}/package.json`));
    const dependencies = packageJson.dependencies || {};
    const boardDependencies = packageJson.boardDependencies || {};

    // 从dependencies中查找以@aily-project/board-开头的依赖
    let board = ""
    Object.entries(dependencies).forEach(([key, version]) => {
      if (key.startsWith('@aily-project/board-')) {
        board = key
      }
    });

    if (!board) {
      console.error('缺少板子信息');
      return;
    }

    // 获取板子信息(board.json)
    const boardJson = JSON.parse(window['file'].readFileSync(`${projectPath}/node_modules/${board}/board.json`));
    console.log("boardJson: ", boardJson);

    if (!boardJson) {
      console.error('缺少板子信息');
      return;
    }

    // 获取编译命令
    let compilerParam = boardJson.compilerParam;


    // 获取编译器、sdk、tool的名称和版本
    let compiler = ""
    let sdk = ""
  
    Object.entries(boardDependencies).forEach(([key, version]) => {
      if (key.startsWith('@aily-project/compiler-')) {
        compiler = key.replace(/^@aily-project\/compiler-/, '') + '@' + version;
      } else if (key.startsWith('@aily-project/sdk-')) {
        sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
      }
    });

    if (!compiler || !sdk ) {
      console.error('缺少编译器或sdk');
      return;
    }

    // 组合编译器、sdk、tools的路径
    const compilerPath = await window["env"].get('AILY_COMPILER_PATH') + `./${compiler}`;
    const sdkPath = await window["env"].get('AILY_SDK_PATH') + `/${sdk}`;
    const toolsPath = await window["env"].get('AILY_TOOL_PATH');

    this.uiService.updateState({ state: 'doing', text: '准备完成，开始编译中...' });

    // 编译
    await this.terminalService.sendCmd(`arduino-cli.exe ${compilerParam} --board-path '${sdkPath}' --compile-path '${compilerPath}' --tools-path '${toolsPath}' --output-dir '${buildPath}' --log-level debug '${sketchFilePath}' --verbose`);

    this.uiService.updateState({ state: 'done', text: '编译完成' });
    this.message.success('编译完成');
  }
}
