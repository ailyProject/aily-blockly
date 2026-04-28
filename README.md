# aily blockly  

[中文](README_ZH.md) | English

## About This Software
Aily Project is a hardware development integrated environment that plans to integrate numerous AI capabilities to help hardware developers develop more smoothly.  
Aily Blockly is a blockly IDE under the aily Project. In the early stage, it provides AI-assisted programming capabilities for non-professional users. The long-term goal is to break the boundary between professional development and non-professional development, and ultimately achieve natural language programming.  

<img src="./img/home.webp" />

> We aim to design and develop this project as industrial-grade software, but the project is currently in the alpha stage and is not recommended for mass production device firmware development. However, the current version is perfectly suitable for prototype verification and educational teaching.  

## Current Version Highlights  
1. **Engineering Project Management**
Uses npm for project management, achieving board and library management on a per-project basis. This solves many engineering deficiencies in traditional embedded development environments. For example, using Arduino IDE may result in board package, library, and current project mismatches, causing compilation failures and runtime errors. In this software, the board versions and library versions in each project are independent and do not affect each other.

2. **Library Manager**
More than 200 commonly used extension libraries are already available, covering most development needs, and the collection is still growing.

3. **Powerful and Compact Serial Debug Tool**
Attempts to create an all-purpose serial tool. Welcome everyone to test, provide feedback, and propose new ideas.

4. **AI Project Generation**
According to user requirements, automatically analyzes projects, recommends development boards, modules, and libraries, generates project architecture diagrams and pin connection diagrams, and creates projects for users.

5. **AI Code Generation**
According to user requirements, automatically writes programs.

6. **AI Library Conversion**
Native C/C++ libraries can be easily converted to libraries used by this software. Based on large model configuration generation, during development, if you want to use an Arduino library but don't have the corresponding blockly library, just provide the Arduino library to AI, and AI will automatically analyze and generate the corresponding blockly library. With this feature, this software can become the blockly platform with the most libraries.

7. **AI Development Board Configuration Generation (Under improvement)**
Based on large model configuration generation, when adding development boards, you no longer need to write new configurations purely by hand. Just provide the development board documentation (md format), and AI will automatically analyze it and help you generate development board configuration files. (Currently supports only development boards based on esp32, avr, renesas, rp2040, and stm32, because the compilers and core SDKs still need to be prepared in the repository in advance. For binary programs, this is how we ensure the source remains trustworthy.)

8. **Lightning Compilation Tool** (Phase 1 online, Phase 2 coming soon!)
Edge-cloud collaboration, lightning compilation. Reduces the original 1-hour compilation work to 1 minute!

9. **Pin Diagram**
Provides a beautiful development board pin diagram viewing solution.

10. **Wiring Diagram (Simulator Phase 1)**
AI can generate module wiring diagrams based on user programs and requirements for user reference.

## Unofficial Version Notes  
This alpha version for testing only guarantees the minimum usability, and many planned highlight features have not yet been designed and developed.
The current version is not recommended for actual work use, as many adjustments we make later may cause incompatibility between versions.

## Planned Features
· Hardware simulation  
· microPython support (mode added, but no library support yet)  

## Documentation
[User Documentation](https://aily.pro/doc)  
[Library Adaptation Documentation](https://github.com/ailyProject/aily-blockly-libraries/blob/main/%E5%BA%93%E8%A7%84%E8%8C%83.md)  
[Software Development Documentation](./develop.md)  

## Related Repositories
[Development Boards](https://github.com/ailyProject/aily-blockly-boards)  
[Block Libraries](https://github.com/ailyProject/aily-blockly-libraries)  
[Compilers](https://github.com/ailyProject/aily-blockly-compilers)  
[Related Tools](https://github.com/ailyProject/aily-project-tools)  

## Main Open Source Projects Used in This Project
[electron](https://github.com/electron/electron) This project uses electron to build desktop applications  
[angular](https://github.com/angular/angular) This project uses angular as the rendering end to build main UI logic  
[node](https://github.com/nodejs/node) This project uses npm and node for package management and executing necessary scripts  
[7z](https://github.com/sparanoid/7z) This project uses 7z to reduce the size of some packages (such as the huge ESP32 compiler)  
[probe-rs](https://github.com/probe-rs/probe-rs) This project uses probe-rs to interface with debuggers such as DAPLink  
Other content can be found in [package.json](./package.json)  

## The AI features of this project reference the following projects
[Kode](https://github.com/shareAI-lab/Kode-cli)  
[copilot](https://github.com/microsoft/vscode-copilot-chat)  

## Additional Rights Statement  
1. This software is free software under the GPL license. Without authorization, the sale of this software or derivative software based on this software is prohibited.
2. Hardware works developed using this software are not restricted by the GPL, and users may decide on their own release and usage methods.
3. For derivatives based on this software, information about relevant rights holders and sponsors of this project must not be removed, and such information must appear on the software startup page.
4. Without authorization, the online service content and user agreement attached to this project must not be removed.

## Sponsors

This project is sponsored by the following companies and individuals

### Corporate Sponsors

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

### Individual Sponsors

Tao Dong (Tianwei Electronics) | Xia Qing (Mushroom Cloud Maker Space) | Du Zhongzhong Dzz (Community Partner) | Li Duan (Yixuehui) | Sun Junjie (Community Partner)

### Technical Sponsors

<table>
  <tr>
    <td><a href="https://signpath.io/"><img src="https://signpath.org/assets/favicon-50x50.png" alt="SignPath" width="32" /></a></td>
    <td>Free code signing on Windows provided by <a href="https://signpath.io/">SignPath.io</a>, certificate by <a href="https://signpath.org/">SignPath Foundation</a></td>
  </tr>
</table>