# arduino-cli

## 编译

```
./arduino-cli.exe compile 
    -b aily:avr_1.8.6:nano 
    --board-path 'C:\\Users\\stao\\AppData\\Local\\aily-project\\sdk\\renesas_uno_1.3.2' 
    --compile-path 'C:\Users\stao\AppData\Local\aily-project\compiler\avr-gcc@7.3.0' 
    --tools-path 'C:\\Users\\stao\\AppData\\Local\\aily-project\\tools' 
    --output-dir ./output 
    --log-level debug 
    ./hello 
    --verbose
```

- `-b`: 指定板子型号
- `--board-path`: sdk文件夹
- `--compile-path`: 用到的编译器路径
- `--builtin-path`: arduino-cli的builtin/tools文件夹
- `--output-dir`: 编译后文件输出文件夹

## 上传

```
./arduino-cli.exe upload 
    --input-dir ./output 
    -p 'COM4' 
    -b aily:renesas_uno_1.3.2:unor4wifi 
    --board-path 'C:\\Users\\stao\\AppData\\Local\\aily-project\\sdk'  
    --builtin-path 'C:\\Users\\stao\\AppData\\Local\\aily-project\\builtin\\tools'
```

- `--input-dir`: 编译时指定的输出文件夹路径（`--output`）
- `-p`: 端口
- `-b`: 板子型号
- `--board-path`: sdk文件夹
- `--builtin-path`: arduino-cli的builtin/tools文件夹
- `--tool-path`: 用到的上传工具路径
