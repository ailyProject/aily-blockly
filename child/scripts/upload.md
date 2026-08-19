# 上传参数选择逻辑

本文描述 Aily Blockly 当前的固件上传参数选择逻辑。最终使用哪类上传命令，由用户选择的设备类型决定；`linkUploadParam` 是否存在不会自动把上传方式切换为调试器。

## 结论

| 用户选择的设备 | 命令来源 | 缺失时的行为 |
| --- | --- | --- |
| 串口（`portType: serial`） | 优先使用 `board.json.uploadParam`；为空时使用 `.temp/preprocess.json` 中的 `upload.command` | 两者都为空时终止上传 |
| 调试器（`portType: debugger`） | 只使用 `board.json.linkUploadParam` | 终止上传，禁止回退到 `uploadParam` 或 aily-builder 命令 |
| BLE OTA（`portType: ble`） | 由 BLE OTA 上传服务处理 | 不执行 `child/scripts/upload.js` 的串口或调试器命令选择逻辑 |
| WiFi OTA（`portType: network-ota`） | 由 Network OTA 上传服务处理 | 不执行 `child/scripts/upload.js` 的串口或调试器命令选择逻辑 |

## 调试器的扫描与选择

只有当前开发板的 `linkUploadParam` 是非空字符串时，端口菜单才会调用 probe-rs 扫描并显示调试器。

扫描到调试器并不代表程序会自动使用调试器。只有用户在端口菜单中选择调试器后，当前设备的 `type` 才会设为 `debugger`，上传时才进入调试器分支。

因此，完整条件是：

1. `linkUploadParam` 非空，程序扫描并显示调试器。
2. 用户主动选择某个调试器。
3. 上传时只采用当前开发板的 `linkUploadParam`。

用户选择串口时，即使开发板存在 `linkUploadParam`，也不会使用它。

## 应用层生成上传配置

上传开始时，应用层固定保存用户当前选择的端口及其类型，避免编译期间设备列表变化导致上传方式被改变。

应用层随后重新读取当前开发板的 `board.json`：

- 调试器模式：读取并校验 `linkUploadParam`。为空时在编译和烧录前报错。
- 串口模式：读取 `uploadParam`。允许它为空，以便后续由 aily-builder 的预处理结果提供完整上传命令。

应用层生成 `.temp/upload-config.json`，主要字段如下：

| 字段 | 含义 |
| --- | --- |
| `portType` | 用户选择的设备类型，默认是 `serial` |
| `serialPort` | 用户选择的串口名称或调试器显示名称 |
| `probeVidPid`、`probeSerial` | 用户选择的调试器标识 |
| `uploadParam` | 应用层传递给子进程的内部命令字段；它不是独立于 `board.json` 的第三种配置来源 |
| `use_1200bps_touch`、`wait_for_upload` | 串口切换相关标志；调试器模式固定为 `false` |
| `pnum` | 部分 STM32 开发板用于确定 probe-rs 芯片型号的选项 |

## `upload.js` 的最终选择规则

`upload.js` 会再次从已安装的开发板模块读取 `board.json`，并以 `portType` 进行严格分流。

### 调试器模式

当 `portType === "debugger"` 时：

1. 只读取 `board.json.linkUploadParam`。
2. 忽略 `upload-config.json.uploadParam` 和 `board.json.uploadParam`。
3. 不读取 `.temp/preprocess.json` 作为备用命令。
4. `linkUploadParam` 为空时立即终止。

`linkUploadParam` 可以用分号分隔多条命令，例如先执行 `probe-rs download`，再执行 `probe-rs reset`。如果用户选择的探针包含 VID/PID 或序列号，上传时会把对应的 `--probe` 参数追加到每条 probe-rs 命令。

### 串口模式

当 `portType` 不是 `debugger` 时，串口命令按以下顺序解析：

1. 使用应用层传入的 `uploadParam`。在正常流程中，它是 `board.json.uploadParam` 清理标志后的传递值。
2. 如果该值为空，再直接读取已安装开发板的 `board.json.uploadParam`。
3. 如果显式 `uploadParam` 仍为空，读取 `.temp/preprocess.json.upload.command`。
4. 如果仍然没有命令，终止上传并报告预处理没有输出上传命令。

`.temp/preprocess.json.upload.command` 是 aily-builder 根据 Arduino SDK 的 `boards.txt`、`platform.txt` 和当前菜单选项解析出的完整上传命令。`upload.js` 不再自行重新拼装 Arduino `upload.pattern`。

## 串口切换标志

串口上传可能需要以下生命周期标志：

- `upload.use_1200bps_touch`
- `upload.wait_for_upload_port`

如果使用显式 `uploadParam`，应用层从其中的兼容标志语法提取这些值。如果使用 aily-builder 命令，则优先使用 `.temp/preprocess.json.upload` 中由 SDK 解析出的标志；缺失时才使用应用层传入的默认值。

调试器模式不执行 1200 bps touch，也不等待串口重新枚举。

## OTA 共通前提

OTA 不能替代开发板的首次烧录。目标设备必须已经运行包含相应 OTA 功能的固件，并且正在提供 BLE OTA GATT 服务或 WiFi OTA HTTP(S) 服务。通常需要先通过串口或调试器烧录一版启用 OTA 的固件，之后才能使用 OTA 更新。

项目中存在 OTA 库依赖只决定 Aily Blockly 是否显示对应入口；目标设备没有启动匹配的 OTA 服务时，搜索、连接或上传仍会失败。

## BLE OTA

### 显示条件与设备发现

BLE OTA 入口只在同时满足以下条件时加入设备菜单：

1. 当前开发板的 `core` 是 `esp32` 或以 `esp32:` 开头。
2. 当前项目声明了 `@aily-project/lib-bleota` 依赖。检查范围包括 `dependencies`、`devDependencies`、`optionalDependencies` 和 `peerDependencies`。

运行环境还必须支持 Web Bluetooth 的 `navigator.bluetooth.requestDevice`，否则 BLE 搜索入口会被禁用。Electron 环境还需要提供对应的 BLE 设备选择桥接；桥接缺失时搜索会报错终止。

用户点击搜索后，程序按 BLE OTA Service UUID `00008018-0000-1000-8000-00805f9b34fb` 过滤设备。用户选择设备后，当前设备类型设为 `ble`，设备 ID 和名称会保存在当前端口信息中。仅发现设备不会自动改变上传方式。

### 固件选择

BLE OTA 仍然会先执行正常的项目编译，但不会使用 `uploadParam`、`linkUploadParam` 或 `.temp/preprocess.json.upload.command` 执行烧录命令。

编译完成后，程序递归查找构建目录中的 `.bin` 文件，并排除名称包含以下内容的辅助镜像：

- `bootloader`
- `partition`
- `boot_app0`
- `ota_data`
- `spiffs`、`littlefs`、`filesystem`、`fatfs`

优先选择文件名以 `.ino.bin` 结尾的应用固件；没有时使用第一个符合条件的应用 `.bin`。找不到应用固件时终止上传。

### 传输流程

正式上传前，程序会先确认用户已授权所选 BLE 设备。编译完成后执行以下流程：

1. 连接所选设备的 GATT 服务。
2. 获取固件接收特征 `00008020-0000-1000-8000-00805f9b34fb` 和命令特征 `00008022-0000-1000-8000-00805f9b34fb`。
3. 启用通知并协商可用数据包大小。
4. 发送开始 Flash OTA 命令和固件总长度。
5. 按 4096 字节扇区发送固件，处理 CRC、扇区确认和重试。
6. 发送停止命令，由设备端完成校验。
7. 无论成功、失败或取消，最后都断开 GATT 连接。

进度状态包括连接、协商、启动、发送、校验和完成。取消上传会中止后续传输并使待处理的确认请求失败。

## WiFi OTA

### 显示条件与目标来源

WiFi OTA 入口只在同时满足以下条件时加入设备菜单：

1. 当前开发板的 `core` 是 `esp32` 或以 `esp32:` 开头。
2. 当前项目声明了 `@aily-project/lib-wifiota` 依赖。

上传开始时会再次检查该依赖；依赖已被移除时，即使界面仍保留旧目标也会拒绝上传。

WiFi OTA 目标来自两处：

- 项目 `package.json` 的 `projectConfig.networkOtaTargets`。
- 当前会话通过 mDNS 搜索发现的目标。

两类目标按 `host + port + uploadPath` 合并去重。保存目标支持以下字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | 空 | 界面显示名称 |
| `host` | 无 | 必填，IP 地址或可解析主机名 |
| `port` | `65280` | OTA HTTP(S) 服务端口 |
| `username` | `arduino` | HTTP Basic Authentication 用户名 |
| `password` | `password` | HTTP Basic Authentication 密码 |
| `uploadPath` | `/sketch` | 固件 POST 路径 |
| `ssl` | `false` | `true` 使用 HTTPS，否则使用 HTTP |
| `timeoutMs` | `60000` | 请求超时，最小 1000 ms |

### mDNS 搜索

点击搜索后，程序运行 `child/scripts/network-ota-mdns-search.js`，通过 UDP 5353 查询 `_arduino._tcp.local`，界面当前使用约 4 秒的搜索窗口。

搜索脚本解析 PTR、SRV、TXT、A 和 AAAA 记录。目标端口来自 SRV；`upload_path`、`username` 和 `password` 可以来自 TXT 记录，缺失时使用上表默认值。mDNS 自动发现的目标当前固定为非 SSL。

如果本机无法绑定 UDP 5353，搜索脚本会改用临时端口并请求单播响应。mDNS 发现结果只保存在当前运行会话中，不会自动写入 `projectConfig.networkOtaTargets`。

用户选择某个目标后，当前设备类型设为 `network-ota`。发现目标本身不会自动改变上传方式。

### 固件与上传协议

WiFi OTA 使用与 BLE OTA 相同的应用 `.bin` 查找规则：优先 `.ino.bin`，并排除 bootloader、分区表和文件系统等辅助镜像。

它不会使用普通 `child/scripts/upload.js`，也不会读取 `uploadParam`、`linkUploadParam` 或 aily-builder 的上传命令。应用层会生成 `.temp/network-ota-upload-config.json`，然后运行独立脚本 `child/scripts/network-ota-upload.js`。

该脚本执行以下操作：

1. 读取完整应用固件并检查文件非空。
2. 向 `http[s]://host:port/uploadPath` 发起 HTTP POST。
3. 使用 `Content-Type: application/octet-stream` 和固件长度作为 `Content-Length`。
4. 用户名和密码都非空时添加 HTTP Basic Authentication。
5. 以 16 KiB 数据块写入请求并报告进度。
6. 只有服务端返回 HTTP 200 才视为成功；其他状态码、网络错误或超时均视为失败。

取消 WiFi OTA 时，应用会终止独立上传进程。使用 HTTP 时，固件和 Basic Authentication 信息不会被加密；需要加密传输时应配置 `ssl: true` 并确保设备端 HTTPS 服务及证书环境可用。

### 两种 OTA 与普通上传的边界

| 项目 | BLE OTA | WiFi OTA | 串口/调试器 |
| --- | --- | --- | --- |
| 入口条件 | ESP32 + `lib-bleota` | ESP32 + `lib-wifiota` | 串口可见，或开发板存在 `linkUploadParam` |
| 目标选择 | Web Bluetooth 设备 | 保存目标或 mDNS 目标 | 串口或调试探针 |
| 固件 | 应用 `.bin` | 应用 `.bin` | 由最终上传命令引用构建产物 |
| 传输实现 | 应用内 GATT 协议 | 独立 HTTP(S) POST 脚本 | `child/scripts/upload.js` |
| 使用 `uploadParam` | 否 | 否 | 仅串口模式可能使用 |
| 使用 `linkUploadParam` | 否 | 否 | 仅用户选择调试器时使用 |
| 使用 aily-builder 上传命令 | 否 | 否 | 仅串口显式 `uploadParam` 为空时使用 |

## 开发板切换

切换开发板时，程序会使正在进行的调试器扫描失效并清空探针缓存。

如果之前选择的是调试器，程序会清除该选择，然后根据新开发板信息选择默认串口：

1. 优先匹配新开发板配置中的 USB VID/PID。
2. 没有唯一 VID/PID 匹配时，可以选择唯一可用的烧录串口。
3. 多个串口无法可靠区分时保持未选择，由用户手动选择。

即使新开发板也支持 `linkUploadParam`，旧开发板的调试器选择也不会被自动沿用；用户需要重新选择调试器后才能使用 `linkUploadParam`。

## 必须保持的约束

- `linkUploadParam` 只控制调试器能力和调试器上传命令，不是默认上传命令。
- 用户选择的设备类型决定进入串口分支还是调试器分支。
- 调试器分支只允许 `linkUploadParam`，不存在任何串口或 aily-builder 回退。
- 串口分支不使用 `linkUploadParam`。
- aily-builder 必须输出完整的 `upload.command`，而不是只输出待二次拼装的上传参数。
