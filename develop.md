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
```  

**开发环境配置**

- windows
    - 复制child/windows/* 到child
    - 解压child/node-v22.*.*-win-x64.7z并重命名为node
    - 解压child/aily-builder-*.7z并重命名为aily-builder 

- macos
    - 复制child/macos/* 到child即可


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
2. 7za/7zz：为了减少部分包的大小，我们使用7z极限压缩来降低部分包（如编译器）的大小
3. aily-builder: 自研的快速编译工具

### /build  
该部分是安装/卸载程序的脚本。
在安装应用时，安装程序会将`child\node-v22.19.0-win-x64.7z`解压到`child\node`。  

### /src/app/blockly/plugins
blockly相关插件

### /src/app/blockly/custom-field
自定义的特殊block