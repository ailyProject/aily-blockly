# 开发人员须知  

## 软件框架
软件主体使用electron开发，渲染端使用angular开发  

## 开发&&打包  

**依赖安装**
```
git clone https://github.com/ailyProject/aily-blockly.git
cd aily-blockly
npm i
cd electron
npm i
cd child
.\7za.exe x node-v18.20.8-win-x64.7z -onode
```  

**electron运行**
```
npm run electron
```

**electron打包**
```
npm run build
```
打包需要开启windows的开发者模式
打包后生成的安装包在路径为dist\aily-blockly



## 相关目录

### /child  
内为程序必须的组件：
1. node：程序使用npm和node进行包管理和执行必要脚本，该npm中添加了npmrc文件，用以指向到aily blockly仓库
2. 7za：为了减少部分包的大小，我们使用7z极限压缩来降低部分包（如编译器）的大小
3. arduino-cli：用于构建arduino项目

### /build  
该部分是安装/卸载程序的脚本。
在安装应用时，安装程序会将`child\node-v9.11.2-win-x64.7z`解压到`child\node`。  

### /src/app/blockly/plugins
blockly相关插件

### /src/app/blockly/custom-field
自定义的特殊block