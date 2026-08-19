# aily blockly

[中文](README_ZH.md) | English

## About This Software
aily Blockly is the Blockly IDE under aily Project. In the early stage, it provides AI-assisted programming capabilities for non-professional users. Its long-term goal is to break the boundary between professional and non-professional development, and ultimately make natural-language programming possible.

aily Blockly is not companion software for a single piece of hardware. It is a truly general-purpose hardware development environment. It currently supports 100+ development boards/chips, includes 400+ preset libraries, and continues to expand with more hardware, libraries, and AI development capabilities. We hope it helps ideas become runnable hardware projects faster, with less interruption from configuration, progress bars, and error messages.

<img src="./img/home.webp" />

> We aim to design and develop this project as industrial-grade software, but the project is currently in the alpha stage and is not recommended for mass-production device firmware development. The current version is fully suitable for prototyping and education.

## Video Introduction
[ailyblockly-2min.webm](https://github.com/user-attachments/assets/bc8da095-2e4d-4ba0-ad31-2a4824a21576)

## Downloads
- [China Version](https://yiyu.pro/download)
- [International Version](https://aily.pro/download)

## Project Highlights
1. **Ready Out of the Box**
After installation, you only need to select a development board/chip to start building. Board packages, toolchains, and common libraries are managed per project, reducing configuration work as much as possible.

2. **Hardware Agnostic**
aily Blockly is a general-purpose hardware development environment, not tied to any specific board or kit. It already supports 100+ development boards/chips, with more being added continuously.

3. **Lightning Compilation**
Edge-cloud collaboration and caching help shorten compile waits, so long progress bars interrupt inspiration less often.

4. **AI-Native Support**
AI can participate throughout the development flow, from project analysis, solution recommendations, and wiring-diagram generation to code writing, compile-error analysis, and debugging advice.

5. **Project Square**
Share and browse projects, get inspiration and feedback, connect with the developer community, and showcase your hardware ideas.

6. **Project Analysis**
Whether your requirement is still vague or already well defined, AI can help clarify goals, recommend development boards/modules/libraries, and generate a project structure diagram.

7. **Code Generation**
AI plans tasks from your requirements, gradually understands project dependencies and library usage, and then generates practical project code.

8. **Unlimited Extension**
The software includes 400+ common extension libraries. If a Blockly library is missing, AI can analyze a native Arduino/C/C++ library and generate an adaptation.

9. **Wiring Diagrams**
When you are unsure how to wire modules, AI can generate a wiring diagram from your requirements and program. It can also help generate code from an existing wiring setup.

10. **Automatic Debugging**
When compilation fails or debug logs are hard to understand, AI can read the error output, locate the issue, and provide repair suggestions.

## Unofficial Version Notes
This alpha test version only guarantees minimum usability, and many planned highlight features have not yet been designed or developed.
The current version is not recommended for real work because later adjustments may introduce incompatibilities between versions.

## Documentation
- [User Documentation](https://yiyu.pro/doc)
- [Library Adaptation Documentation](https://github.com/ailyProject/aily-blockly-libraries/blob/main/%E5%BA%93%E8%A7%84%E8%8C%83.md)
- [Software Development Documentation](./develop.md)

## Related Repositories
- [Development Boards](https://github.com/ailyProject/aily-blockly-boards)
- [Block Libraries](https://github.com/ailyProject/aily-blockly-libraries)
- [Compilers](https://github.com/ailyProject/aily-blockly-compilers)
- [Related Tools](https://github.com/ailyProject/aily-project-tools)

## Main Open Source Projects Used in This Project
- [electron](https://github.com/electron/electron) This project uses Electron to build the desktop application.
- [angular](https://github.com/angular/angular) This project uses Angular as the renderer-side framework for the main UI logic.
- [node](https://github.com/nodejs/node) This project uses npm and Node.js for package management and required script execution.
- [7z](https://github.com/sparanoid/7z) This project uses 7z to reduce the size of some packages, such as the large ESP32 compiler.
- [probe-rs](https://github.com/probe-rs/probe-rs) This project uses probe-rs to communicate with DAPLink and other debuggers.
Other content can be found in [package.json](./package.json).

## The AI Features of This Project Reference the Following Projects
- [Kode](https://github.com/shareAI-lab/Kode-cli)
- [copilot](https://github.com/microsoft/vscode-copilot-chat)
- [ESPConnect](https://github.com/thelastoutpostworkshop/ESPConnect)
- [BLEOTA](https://github.com/gb88/BLEOTA)

## Additional Rights Statement
1. This software is free software under the GPL license. Without authorization, this software and derivative software based on it may not be sold.
2. Hardware works developed with this software are not restricted by the GPL, and users may decide how to publish and use them.
3. Derivative products based on this software must not remove information about the relevant rights holders or sponsors of this project, and must ensure that such information appears on the software startup page.
4. Without authorization, the online service content and user agreement included with this project must not be removed.

## Sponsors

This project is sponsored by the following companies and individuals.

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
