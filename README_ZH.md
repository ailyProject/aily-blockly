# aily blockly  

[English](README.md) | 中文

## 关于本软件
aily Blockly是aily Project下的blockly IDE，前期面向非专业用户提供AI辅助编程能力，长远目标是打破专业开发和非专业开发的界限，最终实现自然语言编程。  

aily Blockly 不是某一款硬件的配套软件，而是一个真正通用的硬件开发环境。目前已支持 100+ 开发板/芯片，内置 400+ 预设库，并持续扩展更多硬件、库和 AI 开发能力。我们希望它能让想法更快变成可运行的硬件项目，让灵感少被配置、进度条和报错打断。  

<img src="./img/home.webp" />

> 我们以提供工业级别软件为目标，进行本项目的设计和开发，但本项目目前还处于alpha阶段，不建议用于量产设备固件开发，但当前版本用于原型验证、教育教学是完全没有问题的。  

## 视频介绍
[ailyblockly-2min.webm](https://github.com/user-attachments/assets/bc8da095-2e4d-4ba0-ad31-2a4824a21576)  

## 中国版下载地址
[下载](https://yiyu.pro/download)  


## 项目亮点  
1. **开箱即用**  
下载安装后，只需选择开发板/芯片，即可开始开发。开发板包、工具链和常用库按项目管理，尽量做到 0 配置、少折腾。

2. **不限硬件**  
aily Blockly 是通用硬件开发环境，不绑定某一款开发板或套件。目前已支持 100 多种开发板/芯片，并持续增加中。

3. **闪电编译**  
通过端云协同和缓存能力缩短编译等待，告别漫长进度条，让灵感不再被等待打断。

4. **AI 原生支持**  
从项目分析、方案推荐、连线图生成，到代码编写、编译报错分析和调试建议，AI 都可以贯穿开发流程。

5. **项目广场**  
分享和浏览项目，获取灵感和反馈，与开发者社区连接，展示自己的硬件创意。

6. **项目分析**  
无论是模糊需求还是明确任务，AI 都可以辅助梳理目标、推荐开发板/模组/库，并生成项目结构图。

7. **代码生成**  
AI 会根据需求自主规划任务，逐步理解项目依赖和库的使用方式，再生成可落地的项目代码。

8. **无限扩展**  
内置 400 多个常用扩展库。缺少 Blockly 库时，可以让 AI 分析原生 Arduino/C/C++ 库并生成适配。

9. **连线图**  
不知道怎么接线时，AI 可以根据需求和程序生成连线图；也可以根据已有连线反向辅助生成代码。

10. **自动调试**  
编译有错误、调试信息看不懂时，可以交给 AI 读取报错、定位问题并给出修复建议。


## 非正式版注意事项  
本次测试的alpha版本，仅保证最低限度的能用，很多计划的亮点功能还未完成设计和开发。
当前版本不建议实际用于工作，因为后期我们做出的诸多调整，可能会导致版本间的不兼容。

## 文档
[使用文档](https://yiyu.pro/doc)  
[库适配文档](https://github.com/ailyProject/aily-blockly-libraries/blob/main/%E5%BA%93%E8%A7%84%E8%8C%83.md)  
[软件开发文档](./develop.md)  

## 相关仓库
[开发板](https://github.com/ailyProject/aily-blockly-boards)  
[block库](https://github.com/ailyProject/aily-blockly-libraries)  
[编译器](https://github.com/ailyProject/aily-blockly-compilers)  
[相关工具](https://github.com/ailyProject/aily-project-tools)  

## 项目使用到的主要开源项目
[electron](https://github.com/electron/electron)本项目使用electron构建桌面程序  
[angular](https://github.com/angular/angular)本项目使用angular作为渲染端构建主要UI逻辑  
[node](https://github.com/nodejs/node)本项目使用npm和node进行包管理和执行必要脚本  
[7z](https://github.com/sparanoid/7z)本项目使用7z减小部分包的大小（如巨大的ESP32编译器）  
[probe-rs](https://github.com/probe-rs/probe-rs)本项目使用probe-rs调用daplink等调试器  
其他内容可见[package.json](./package.json)  

## 本项目AI功能参考了以下项目
[Kode](https://github.com/shareAI-lab/Kode-cli)  
[copilot](https://github.com/microsoft/vscode-copilot-chat)  
[ESPConnect](https://github.com/thelastoutpostworkshop/ESPConnect)  
[BLEOTA](https://github.com/gb88/BLEOTA)  

## 附加权利说明  
1. 本软件为GPL协议下的免费软件，在无授权的情况下，不得销售本软件及基于本软件的衍生软件；
2. 使用本软件开发的硬件作品不受GPL限制，用户可自行决定发布和使用方式；
3. 基于本软件的衍生品，不得移除本项目相关权利人、赞助者信息，且必须保证相关信息出现在软件启动页；
4. 在无授权的情况下，不得移除本项目附带的线上服务内容、及用户协议。

## 赞助

本项目由以下企业和个人赞助

### 企业赞助

<table>
  <tr>
    <td><a target="_blank" href="https://www.seeedstudio.com/"><img src=".\public\sponsor\seeedstudio\logo-light.webp" alt="seeedstudio" width="200" /></a></td>
    <td><a target="_blank" href="https://www.seekfree.cn/"><img src=".\public\sponsor\seekfree\logo-light.webp" alt="seekfree" width="200" /></a></td>
    <td><a target="_blank" href="https://www.diandeng.tech/"><img src=".\public\sponsor\diandeng\logo-light.webp" alt="diandeng" width="200" /></a></td>
    <td><a target="_blank" href="https://www.openjumper.com/"><img src=".\public\sponsor\openjumper\logo.webp" alt="openjumper" width="200" /></a></td>
  </tr>
  <tr>
    <td><a target="_blank" href="https://www.pdmicro.cn/"><img src=".\public\sponsor\pengde\logo.webp" alt="pengde" width="200" /></a></td>
    <td><a target="_blank" href="https://www.titlab.cn/"><img src=".\public\sponsor\titlab\logo-light.webp" alt="titlab" width="200" /></a></td>
    <td><a target="_blank" href="https://www.emakefun.com"><img src=".\public\sponsor\emakefun\logo-light.webp" alt="emakefun" width="200" /></a></td>
    <td><a target="_blank" href="http://www.keyes-robot.com/"><img src=".\public\sponsor\keyes\logo-light.webp" alt="keyes" width="200" /></a></td>
  </tr>
</table>

### 个人赞助

陶冬(天微电子) | 夏青(蘑菇云创客空间) | 杜忠忠Dzz(社区伙伴) | 李端(益学汇) | 孙俊杰(社区伙伴)

### 技术赞助

<table>
  <tr>
    <td><a href="https://signpath.io/"><img src="https://signpath.org/assets/favicon-50x50.png" alt="SignPath" width="32" /></a></td>
    <td>由 <a href="https://signpath.io/">SignPath.io</a> 提供 Windows 免费代码签名，证书由 <a href="https://signpath.org/">SignPath Foundation</a> 颁发</td>
  </tr>
</table>

