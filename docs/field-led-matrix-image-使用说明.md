# field_led_matrix_image 使用说明

`field_led_matrix_image` 是用于编辑点阵 LED 图像的 Blockly 自定义字段，支持单色 LED 点阵和 RGB LED 点阵。字段值会同时保存模式、宽度、高度和像素数据，适合在代码生成器里根据硬件类型输出不同格式。

## 功能

- 支持 `mono` 单色模式，像素值为 `0` 或 `1`。
- 支持 `rgb` 彩色模式，像素值为 `null` 或 `#rrggbb`。
- 支持通过字段配置指定默认宽高。
- 支持在编辑器中修改宽高，并保留左上角已有像素。
- 支持画笔、橡皮、清空和填充。
- RGB 模式可通过颜色选择器设置当前画笔颜色。

## 注册

字段已在 Blockly 初始化入口中导入：

```typescript
import './custom-field/field-led-matrix-image';
```

注册名为：

```text
field_led_matrix_image
```

## 基本积木配置

单色 8x8 点阵：

```json
{
  "type": "led_matrix_mono_demo",
  "message0": "单色点阵 %1",
  "args0": [
    {
      "type": "field_led_matrix_image",
      "name": "IMAGE",
      "mode": "mono",
      "width": 8,
      "height": 8
    }
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": 230
}
```

RGB 16x16 点阵：

```json
{
  "type": "led_matrix_rgb_demo",
  "message0": "RGB点阵 %1",
  "args0": [
    {
      "type": "field_led_matrix_image",
      "name": "IMAGE",
      "mode": "rgb",
      "width": 16,
      "height": 16,
      "selectedColour": "#ff3b30"
    }
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": 20
}
```

## 字段值结构

字段返回一个对象：

```typescript
interface LedMatrixImageValue {
  mode: 'mono' | 'rgb';
  width: number;
  height: number;
  pixels: Array<Array<0 | 1 | string | null>>;
}
```

单色模式示例：

```json
{
  "mode": "mono",
  "width": 4,
  "height": 3,
  "pixels": [
    [0, 1, 1, 0],
    [1, 0, 0, 1],
    [0, 1, 1, 0]
  ]
}
```

RGB 模式示例：

```json
{
  "mode": "rgb",
  "width": 4,
  "height": 2,
  "pixels": [
    [null, "#ff0000", null, "#00ff00"],
    ["#0000ff", null, null, "#ffffff"]
  ]
}
```

说明：

- `mono` 模式中，`0` 表示熄灭，`1` 表示点亮。
- `rgb` 模式中，`null` 表示熄灭，`#rrggbb` 表示点亮颜色。
- `width` 和 `height` 是当前点阵尺寸；用户在编辑器中应用新尺寸后，这两个值会一起更新。

## 可用配置项

```typescript
{
  type: 'field_led_matrix_image',
  name: 'IMAGE',
  mode?: 'mono' | 'rgb',
  width?: number,
  height?: number,
  minWidth?: number,
  maxWidth?: number,
  minHeight?: number,
  maxHeight?: number,
  pixelSize?: number,
  blockPixelSize?: number,
  fieldHeight?: number,
  selectedColour?: string,
  buttons?: {
    fill: boolean,
    clear: boolean
  },
  colours?: {
    empty: string,
    mono: string,
    border: string,
    background: string
  },
  value?: LedMatrixImageValue
}
```

常用配置说明：

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `mode` | 默认灯类型，`mono` 或 `rgb` | `mono` |
| `width` | 默认宽度 | `8` |
| `height` | 默认高度 | `8` |
| `minWidth` / `maxWidth` | 编辑器允许的宽度范围 | `1` / `128` |
| `minHeight` / `maxHeight` | 编辑器允许的高度范围 | `1` / `128` |
| `pixelSize` | 下拉编辑器内单个像素的显示尺寸 | 自动计算 |
| `blockPixelSize` | 积木上预览图单个像素的显示尺寸 | 自动计算 |
| `fieldHeight` | 固定积木上预览高度，会自动反推 `blockPixelSize` | 未设置 |
| `selectedColour` | RGB 模式默认画笔颜色 | `#ff3b30` |

## 代码生成器读取示例

```typescript
const image = block.getFieldValue('IMAGE') as LedMatrixImageValue;

if (image.mode === 'mono') {
  const rows = image.pixels.map(row => row.map(pixel => pixel === 1 ? 1 : 0));
  return `displayMono(${image.width}, ${image.height}, ${JSON.stringify(rows)});\n`;
}

const pixels = image.pixels.map(row => row.map(pixel => {
  if (typeof pixel !== 'string') return [0, 0, 0];
  const r = parseInt(pixel.slice(1, 3), 16);
  const g = parseInt(pixel.slice(3, 5), 16);
  const b = parseInt(pixel.slice(5, 7), 16);
  return [r, g, b];
}));

return `displayRgb(${image.width}, ${image.height}, ${JSON.stringify(pixels)});\n`;
```

如果需要生成 NeoPixel 一维数组，可以按行优先展开：

```typescript
const flatPixels = image.pixels.flat();
```

如果硬件是蛇形走线，可以在生成器里按行号决定是否反转该行：

```typescript
const orderedPixels = image.pixels.flatMap((row, rowIndex) => {
  return rowIndex % 2 === 0 ? row : [...row].reverse();
});
```

## 编辑器操作

- `Paint`：画笔模式，单色模式写入 `1`，RGB 模式写入当前颜色。
- `Erase`：橡皮模式，单色模式写入 `0`，RGB 模式写入 `null`。
- `Fill`：填满当前点阵。
- `Clear`：清空当前点阵。
- `W` / `H` + `Apply`：调整点阵宽高。
- 右键拖动画布时会临时作为橡皮使用。

## 注意事项

- 字段值会被 Blockly 序列化到工程数据中，不需要额外手动保存。
- 切换 `mono` 和 `rgb` 模式时，已点亮的像素会保留亮灭关系：单色转 RGB 会使用当前颜色，RGB 转单色会把非空颜色转为 `1`。
- 对于较大的点阵，编辑器和积木预览会自动缩小像素显示尺寸，保存的数据尺寸不受影响。
