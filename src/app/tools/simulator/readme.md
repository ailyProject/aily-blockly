# todo
使用项目： 
https://github.com/wokwi/wokwi-elements  
https://github.com/wokwi/wokwi-gdbserver  
https://github.com/wokwi/avr8js  


## ESP32  
对于EPS32由于wokwi没有提供esp32版本模拟器。
可以直接运行[qemu](https://github.com/espressif/qemu)实现模拟，然后通过qemu提供的监视器接口获取硬件状态。

# 硬件连接描述
基本参考[wokwi diagram.json](https://docs.wokwi.com/diagram-format)  
```json
{
    "version": 1,
    "author": "aily",
    "editor": "simulator",
    "parts":[
        {
            "id": "led1",
            "type": "wokwi-led",
            "left": 100,
            "top": 50,
            "attrs": {
                "color": "red"
            }
        },
        {
            "id": "uno1",
            "type": "wokwi-arduino-uno",
            "left": 100,
            "top": 200
        }
    ],
    "connections":[
        ["uno1:D13","led1:anode","#FFFFFF"],  //arduino-uno的13引脚 连接到 led的anode引脚，连接线颜色#FFFFFF
        ["uno1:gnd","led1:cathode","#000000"],  //arduino-uno的GND引脚 连接到 led的cathode引脚，连接线颜色#000000
    ]
}
```

## 元器件配置  
```json
{
    "parts":[
        {
            "id": "led1",
            "type": "wokwi-led",
            "left": 100,
            "top": 50,
            "attrs": {
                "color": "red"
            }
        },
        {
            "id": "uno1",
            "type": "wokwi-arduino-uno",
            "left": 100,
            "top": 200
        }
    ]
}
```

## 连接配置
软件中通过以下json描述硬件连接方式
```json
{
    "connections":[
        ["uno1:D13","led1:anode","#FFFFFF"],  //arduino-uno的13引脚 连接到 led的anode引脚，连接线颜色#FFFFFF
        ["uno1:gnd","led1:cathode","#000000"],  //arduino-uno的GND引脚 连接到 led的cathode引脚，连接线颜色#000000
    ]
}
```