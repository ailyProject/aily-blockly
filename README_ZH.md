# aily blockly  

[English](README.md) | 中文

## 关于本软件
aily Project是一个硬件开发集成环境，计划集成诸多AI能力，帮助硬件开发者更畅快的进行开发。  
aily Blockly是aily Project下的blockly IDE，前期面向非专业用户提供AI辅助编程能力，长远目标是打破专业开发和非专业开发的界限，最终实现自然语言编程。  

<img src="./img/home.webp" />

> 我们以提供工业级别软件为目标，进行本项目的设计和开发，但本项目目前还处于alpha阶段，不建议用于量产设备固件开发，但当前版本用于原型验证、教育教学是完全没有问题的。  

## 当前版本亮点  
1. 工程化项目管理
使用npm进行项目管理，做到以项目为单位进行开发板和库的管理。解决了诸多传统嵌入式开发环境的工程化不足的问题。如，使用Arduino IDE可能出现board package、库和当前项目不匹配，造成编译失败，运行错误的问题。在本软件上，各项目中的开发板版本和库版本是独立的，项目间互不影响。
2. 库管理器
虽然我们已经准备了很多库（几乎涵盖了常用模组），但实际上这些库都是AI生成的，我们没有经过详细验证。需要内测参与者和我们一道进行验证和完善。
3. 全能且小巧的串口调试工具
试图打造一个全能的串口工具，欢迎大家测试、反馈、提出新的想法。
4. AI项目生成
根据用户需求，自动分析项目，推荐开发板、模组、库，生成项目架构图、引脚连接图，并为用户创建出项目。
5. AI代码生成
根据用户需求，自动编写程序
6. AI转库
原生C/C++库都可以轻松转换成本软件使用的库。基于大模型的配置生成，开发过程中，如果想使用arduino库，但没有对应的blockly库，只用将arduino库提供给AI，AI自动分析，生成对应的blockly库。借助该功能，本软件可以成为blockly最多的开发平台。
7. AI开发板配置生成（完善中）
基于大模型的配置生成，添加开发板时不用再纯手写新配置，只用提供开发板文档（md格式），AI自动分析，帮你生成开发板配置文件。（仅支持esp32、avr、renesas、rp2040、stm32为核心的开发板，因为编译器和核心sdk，还是需要我们提前准备的到仓库的）
8. 闪电编译工具（一期已上线，二期还将提速！）
端云协同，闪电连编 将原本1小时的编译工作缩短到1分钟！


## 非正式版注意事项  
本次测试的alpha版本，仅保证最低限度的能用，很多计划的亮点功能还未完成设计和开发。
当前版本不建议实际用于工作，因为后期我们做出的诸多调整，可能会导致版本间的不兼容。

## 计划功能    
· 硬件仿真  
· microPython支持（已添加模式，但暂无库支持）

## 文档
[使用文档](https://aily.pro/doc)  
[库适配文档](https://github.com/ailyProject/aily-blockly-libraries/blob/main/%E5%BA%93%E8%A7%84%E8%8C%83.md)  
[软件开发文档](./develop.md)  

## 相关仓库
[开发板](https://github.com/ailyProject/aily-blockly-boards)  
[block库](https://github.com/ailyProject/aily-blockly-libraries)  
[编译器](https://github.com/ailyProject/aily-blockly-compilers)  
[相关工具](https://github.com/ailyProject/aily-project-tools)  

## 项目赞助
本项目由以下企业和个人赞助

### 企业赞助
<a target="_blank" href="https://www.seeedstudio.com/" >
    <img src=".\public\sponsor\seeedstudio\logo_l.webp" alt="seeedstudio" width=200 />
</a><br>  
<a target="_blank" href="https://www.seekfree.cn/" >
    <img src=".\public\sponsor\seekfree\logo_l.webp" alt="seekfree" width=200 />
</a><br>
<a target="_blank" href="https://www.diandeng.tech/" >
    <img src=".\public\sponsor\diandeng\logo_l.webp" alt="diandeng" width=200 />
</a><br>  
<a target="_blank" href="https://www.openjumper.com/" >
    <img src=".\public\sponsor\openjumper\logo.webp" alt="openjumper" width=200 />
</a><br>
<a target="_blank" href="https://www.pdmicro.cn/" >
    <img src=".\public\sponsor\pengde\logo.webp" alt="pengde" width=200 />
</a><br>  
<a target="_blank" href="https://www.titlab.cn/" >
    <img src=".\public\sponsor\titlab\logo_l.webp" alt="titlab" width=200 />
</a><br>  
<a target="_blank" href="https://www.emakefun.com" >
    <img src=".\public\sponsor\emakefun\logo_l.webp" alt="emakefun" width=200 />
</a><br>  
<a target="_blank" href="http://www.keyes-robot.com/" >
    <img src=".\public\sponsor\keyes\logo_l.webp" alt="keyes" width=200 />
</a>  


### 个人赞助   
陶冬(天微电子)  
夏青(蘑菇云创客空间)  
杜忠忠Dzz(社区伙伴)  
李端(益学汇)  
孙俊杰(社区伙伴)  

## 项目使用到的主要开源项目
[electron]()本项目使用electron构建桌面程序  
[angular]()本项目使用angular作为渲染端构建主要UI逻辑  
[node]()本项目使用npm和node进行包管理和执行必要脚本  
[7z]()本项目使用7z减小部分包的大小（如巨大的ESP32编译器）  
其他内容可见[package.json](./package.json)  

## 本项目AI功能参考了以下项目
[Kode](https://github.com/shareAI-lab/Kode-cli)  
[copilot](https://github.com/microsoft/vscode-copilot-chat)  

## 附加权利说明  
基于本项目产生的衍生品或修改，在未取得本项目负责人（奈何col）的同意下，不得进行以下事项：
1. 不得移除本项目相关权利人、赞助者信息，且必须保证相关信息出现在软件启动页。
2. 不得移除本项目附带的线上服务内容

