/** Snapshot of the actual aily-blockly-libraries/pid block definitions and generator.
 * The same replay pipeline runs its declared initializer and final real generation. */
export const pidModelFixture = {
  "blocks": [
    {
      "inputsInline": false,
      "message0": "初始化PID控制器%1输入变量%2输出变量%3目标值%4参数预设%5P参数%6I参数%7D参数%8控制方向%9",
      "type": "pid_init",
      "args0": [
        {
          "type": "field_variable",
          "name": "PID_NAME",
          "variable": "myPID",
          "variableTypes": [
            "PID"
          ],
          "defaultType": "PID"
        },
        {
          "type": "field_variable",
          "name": "INPUT",
          "variable": "input",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        },
        {
          "type": "field_variable",
          "name": "OUTPUT",
          "variable": "output",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        },
        {
          "type": "field_variable",
          "name": "SETPOINT",
          "variable": "setpoint",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        },
        {
          "type": "field_dropdown",
          "name": "PRESET",
          "options": [
            [
              "自定义",
              "custom"
            ],
            [
              "温度控制",
              "temperature"
            ],
            [
              "电机速度",
              "motor_speed"
            ],
            [
              "位置控制",
              "position"
            ],
            [
              "液位控制",
              "level"
            ]
          ]
        },
        {
          "type": "field_number",
          "name": "KP",
          "value": 2,
          "min": 0,
          "precision": 0.01
        },
        {
          "type": "field_number",
          "name": "KI",
          "value": 5,
          "min": 0,
          "precision": 0.01
        },
        {
          "type": "field_number",
          "name": "KD",
          "value": 1,
          "min": 0,
          "precision": 0.01
        },
        {
          "type": "field_dropdown",
          "name": "DIRECTION",
          "options": [
            [
              "正向控制",
              "DIRECT"
            ],
            [
              "反向控制",
              "REVERSE"
            ]
          ]
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6600",
      "extensions": [
        "pid_preset_extension"
      ],
      "icon": "fa-regular fa-dharmachakra"
    },
    {
      "inputsInline": true,
      "message0": "PID控制器%1计算",
      "type": "pid_compute",
      "args0": [
        {
          "type": "field_variable",
          "name": "PID_NAME",
          "variable": "myPID",
          "variableTypes": [
            "PID"
          ],
          "defaultType": "PID"
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6600",
      "icon": "fa-regular fa-dharmachakra"
    },
    {
      "inputsInline": true,
      "message0": "获取PID输入值%1",
      "type": "pid_get_input",
      "args0": [
        {
          "type": "field_variable",
          "name": "INPUT",
          "variable": "input",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        }
      ],
      "output": "Number",
      "colour": "#FF6600",
      "icon": "fa-regular fa-dharmachakra"
    },
    {
      "inputsInline": true,
      "message0": "获取PID输出值%1",
      "type": "pid_get_output",
      "args0": [
        {
          "type": "field_variable",
          "name": "OUTPUT",
          "variable": "output",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        }
      ],
      "output": "Number",
      "colour": "#FF6600",
      "icon": "fa-regular fa-dharmachakra"
    },
    {
      "inputsInline": true,
      "message0": "设置PID目标值%1为%2",
      "type": "pid_set_setpoint",
      "args0": [
        {
          "type": "field_variable",
          "name": "SETPOINT",
          "variable": "setpoint",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        },
        {
          "type": "input_value",
          "name": "VALUE",
          "check": "Number"
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6600",
      "icon": "fa-regular fa-dharmachakra"
    },
    {
      "inputsInline": true,
      "message0": "设置PID输入值%1为%2",
      "type": "pid_set_input",
      "args0": [
        {
          "type": "field_variable",
          "name": "INPUT",
          "variable": "input",
          "variableTypes": [
            "double"
          ],
          "defaultType": "double"
        },
        {
          "type": "input_value",
          "name": "VALUE",
          "check": "Number"
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6600",
      "icon": "fa-regular fa-dharmachakra"
    }
  ],
  "source": "// PID控制器库 Generator\r\n// 支持基础PID控制、自适应参数调节、基于测量值的比例控制等功能\r\n\r\n// 获取变量名的辅助函数\r\nfunction getVariableName(block, fieldName) {\r\n  const variableField = block.getField(fieldName);\r\n  if (variableField && variableField.getVariable) {\r\n    const variableModel = variableField.getVariable();\r\n    return variableModel.name;\r\n  }\r\n  return block.getFieldValue(fieldName);\r\n}\r\n\r\n// 预设参数配置\r\nconst PID_PRESETS = {\r\n    temperature: { kp: 2.0, ki: 0.1, kd: 0.5 },\r\n    motor_speed: { kp: 1.5, ki: 0.8, kd: 0.2 },\r\n    position: { kp: 3.0, ki: 0.05, kd: 1.0 },\r\n    level: { kp: 1.8, ki: 0.3, kd: 0.4 },\r\n    custom: { kp: 2.0, ki: 5.0, kd: 1.0 }\r\n};\r\n\r\n// 避免重复加载扩展\r\nif (Blockly.Extensions.isRegistered('pid_preset_extension')) {\r\n  Blockly.Extensions.unregister('pid_preset_extension');\r\n}\r\n\r\n// 注册预设参数切换扩展\r\nBlockly.Extensions.register('pid_preset_extension', function() {\r\n    this.getField('PRESET').setValidator(function(newValue) {\r\n        const sourceBlock = this.getSourceBlock();\r\n        if (newValue && newValue !== 'custom' && PID_PRESETS[newValue]) {\r\n            const preset = PID_PRESETS[newValue];\r\n            sourceBlock.setFieldValue(preset.kp, 'KP');\r\n            sourceBlock.setFieldValue(preset.ki, 'KI');\r\n            sourceBlock.setFieldValue(preset.kd, 'KD');\r\n        }\r\n        return newValue;\r\n    });\r\n});\r\n\r\n// 初始化PID控制器\r\n// Explicit workspace-model ownership; variable dropdown constraints alone are consumers.\r\nArduino.modelDeclarations = Arduino.modelDeclarations || {};\r\nArduino.modelDeclarations.pid_init = {\r\n    version: 1,\r\n    scope: 'workspace',\r\n    fields: { PID_NAME: 'PID', INPUT: 'double', OUTPUT: 'double', SETPOINT: 'double' },\r\n    shared: ['INPUT', 'OUTPUT', 'SETPOINT']\r\n};\r\nArduino.forBlock['pid_init'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    const outputVar = getVariableName(block, 'OUTPUT');\r\n    const setpointVar = getVariableName(block, 'SETPOINT');\r\n    if (typeof registerVariableToBlockly === 'function') {\r\n        registerVariableToBlockly(pidName, 'PID');\r\n        registerVariableToBlockly(inputVar, 'double');\r\n        registerVariableToBlockly(outputVar, 'double');\r\n        registerVariableToBlockly(setpointVar, 'double');\r\n    }\r\n    const kp = block.getFieldValue('KP');\r\n    const ki = block.getFieldValue('KI');\r\n    const kd = block.getFieldValue('KD');\r\n    const direction = block.getFieldValue('DIRECTION');\r\n\r\n    // 添加库引用\r\n    generator.addLibrary('pid_lib', '#include <PID_v1.h>');\r\n    \r\n    // 添加变量声明\r\n    generator.addVariable(`pid_var_${inputVar}`, `double ${inputVar};`);\r\n    generator.addVariable(`pid_var_${outputVar}`, `double ${outputVar};`);\r\n    generator.addVariable(`pid_var_${setpointVar}`, `double ${setpointVar};`);\r\n    generator.addVariable(`pid_tuning_${pidName}`, `double Kp_${pidName} = ${kp}, Ki_${pidName} = ${ki}, Kd_${pidName} = ${kd};`);\r\n    \r\n    // 添加PID对象\r\n    generator.addObject(`pid_object_${pidName}`, `PID ${pidName}(&${inputVar}, &${outputVar}, &${setpointVar}, Kp_${pidName}, Ki_${pidName}, Kd_${pidName}, ${direction});`);\r\n    \r\n    // 在setup中启用PID\r\n    generator.addSetup(`pid_mode_${pidName}`, `${pidName}.SetMode(AUTOMATIC);`);\r\n\r\n    return '';\r\n};\r\n\r\n// 快速PID控制设置\r\nArduino.forBlock['pid_quick_setup'] = function(block, generator) {\r\n    const inputPin = block.getFieldValue('INPUT_PIN');\r\n    const outputPin = block.getFieldValue('OUTPUT_PIN');\r\n    const setpoint = generator.valueToCode(block, 'SETPOINT', Arduino.ORDER_ATOMIC) || '100';\r\n    const application = block.getFieldValue('APPLICATION');\r\n    \r\n    // 根据应用场景选择参数\r\n    const preset = PID_PRESETS[application] || PID_PRESETS.custom;\r\n    \r\n    // 添加库引用\r\n    generator.addLibrary('pid_lib', '#include <PID_v1.h>');\r\n    \r\n    // 添加变量\r\n    generator.addVariable('pid_quick_vars', `double quickPidInput, quickPidOutput, quickPidSetpoint = ${setpoint};`);\r\n    generator.addVariable('pid_quick_tuning', `double quickKp = ${preset.kp}, quickKi = ${preset.ki}, quickKd = ${preset.kd};`);\r\n    \r\n    // 添加PID对象\r\n    generator.addObject('pid_quick_object', `PID quickPID(&quickPidInput, &quickPidOutput, &quickPidSetpoint, quickKp, quickKi, quickKd, DIRECT);`);\r\n    \r\n    // 在setup中设置\r\n    generator.addSetup('pid_quick_setup', `quickPID.SetMode(AUTOMATIC);\\n  quickPID.SetOutputLimits(0, 255);`);\r\n    generator.addSetup(`pid_quick_pin_${outputPin}`, `pinMode(${outputPin}, OUTPUT);`);\r\n    \r\n    return `quickPidInput = analogRead(${inputPin});\\nquickPID.Compute();\\nanalogWrite(${outputPin}, quickPidOutput);\\n`;\r\n};\r\n\r\n// PID控制循环\r\nArduino.forBlock['pid_control_loop'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const readInput = generator.statementToCode(block, 'READ_INPUT');\r\n    const writeOutput = generator.statementToCode(block, 'WRITE_OUTPUT');\r\n    \r\n    return `${readInput}${pidName}.Compute();\\n${writeOutput}`;\r\n};\r\n\r\n// 执行一次PID计算\r\nArduino.forBlock['pid_compute'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    return `${pidName}.Compute();\\n`;\r\n};\r\n\r\n// 设置PID工作模式\r\nArduino.forBlock['pid_set_mode'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const mode = block.getFieldValue('MODE');\r\n    return `${pidName}.SetMode(${mode});\\n`;\r\n};\r\n\r\n// 设置PID参数\r\nArduino.forBlock['pid_set_tunings'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const kp = generator.valueToCode(block, 'KP', Arduino.ORDER_ATOMIC) || '2';\r\n    const ki = generator.valueToCode(block, 'KI', Arduino.ORDER_ATOMIC) || '5';\r\n    const kd = generator.valueToCode(block, 'KD', Arduino.ORDER_ATOMIC) || '1';\r\n    return `${pidName}.SetTunings(${kp}, ${ki}, ${kd});\\n`;\r\n};\r\n\r\n// 设置PID输出范围\r\nArduino.forBlock['pid_set_output_limits'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const min = generator.valueToCode(block, 'MIN', Arduino.ORDER_ATOMIC) || '0';\r\n    const max = generator.valueToCode(block, 'MAX', Arduino.ORDER_ATOMIC) || '255';\r\n    return `${pidName}.SetOutputLimits(${min}, ${max});\\n`;\r\n};\r\n\r\n// 温度PID控制\r\nArduino.forBlock['pid_temperature_control'] = function(block, generator) {\r\n    const tempPin = block.getFieldValue('TEMP_PIN');\r\n    const heaterPin = block.getFieldValue('HEATER_PIN');\r\n    const targetTemp = generator.valueToCode(block, 'TARGET_TEMP', Arduino.ORDER_ATOMIC) || '25';\r\n    \r\n    const preset = PID_PRESETS.temperature;\r\n    \r\n    // 添加库引用\r\n    generator.addLibrary('pid_lib', '#include <PID_v1.h>');\r\n    \r\n    // 添加变量\r\n    generator.addVariable('pid_temp_vars', `double tempInput, tempOutput, tempSetpoint = ${targetTemp};`);\r\n    generator.addVariable('pid_temp_tuning', `double tempKp = ${preset.kp}, tempKi = ${preset.ki}, tempKd = ${preset.kd};`);\r\n    \r\n    // 添加PID对象\r\n    generator.addObject('pid_temp_object', `PID tempPID(&tempInput, &tempOutput, &tempSetpoint, tempKp, tempKi, tempKd, DIRECT);`);\r\n    \r\n    // 在setup中设置\r\n    generator.addSetup('pid_temp_setup', `tempPID.SetMode(AUTOMATIC);\\n  tempPID.SetOutputLimits(0, 255);`);\r\n    generator.addSetup(`pid_temp_pin_${heaterPin}`, `pinMode(${heaterPin}, OUTPUT);`);\r\n    \r\n    // 添加温度转换函数\r\n    generator.addFunction('temp_convert_function', `\r\nfloat readTemperature(int pin) {\r\n  int reading = analogRead(pin);\r\n  float voltage = reading * 5.0 / 1024.0;\r\n  return (voltage - 0.5) * 100.0; // LM35温度传感器转换\r\n}`);\r\n    \r\n    return `tempInput = readTemperature(${tempPin});\\ntempPID.Compute();\\nanalogWrite(${heaterPin}, tempOutput);\\n`;\r\n};\r\n\r\n// 电机速度PID控制\r\nArduino.forBlock['pid_motor_speed_control'] = function(block, generator) {\r\n    const encoderPin = block.getFieldValue('ENCODER_PIN');\r\n    const motorPin = block.getFieldValue('MOTOR_PIN');\r\n    const targetRpm = generator.valueToCode(block, 'TARGET_RPM', Arduino.ORDER_ATOMIC) || '100';\r\n    \r\n    const preset = PID_PRESETS.motor_speed;\r\n    \r\n    // 添加库引用\r\n    generator.addLibrary('pid_lib', '#include <PID_v1.h>');\r\n    \r\n    // 添加变量\r\n    generator.addVariable('pid_motor_vars', `double motorInput, motorOutput, motorSetpoint = ${targetRpm};\\nvolatile int encoderCount = 0;\\nlong lastTime = 0;`);\r\n    generator.addVariable('pid_motor_tuning', `double motorKp = ${preset.kp}, motorKi = ${preset.ki}, motorKd = ${preset.kd};`);\r\n    \r\n    // 添加PID对象\r\n    generator.addObject('pid_motor_object', `PID motorPID(&motorInput, &motorOutput, &motorSetpoint, motorKp, motorKi, motorKd, DIRECT);`);\r\n    \r\n    // 在setup中设置\r\n    generator.addSetup('pid_motor_setup', `motorPID.SetMode(AUTOMATIC);\\n  motorPID.SetOutputLimits(0, 255);`);\r\n    generator.addSetup(`pid_motor_pin_${motorPin}`, `pinMode(${motorPin}, OUTPUT);`);\r\n    generator.addSetup(`pid_motor_encoder_${encoderPin}`, `pinMode(${encoderPin}, INPUT_PULLUP);\\n  attachInterrupt(digitalPinToInterrupt(${encoderPin}), encoderISR, RISING);`);\r\n    \r\n    // 添加编码器中断函数和转速计算\r\n    generator.addFunction('encoder_functions', `\r\nvoid encoderISR() {\r\n  encoderCount++;\r\n}\r\n\r\nfloat calculateRPM() {\r\n  long currentTime = millis();\r\n  if (currentTime - lastTime >= 1000) {\r\n    float rpm = (encoderCount * 60.0) / ((currentTime - lastTime) / 1000.0);\r\n    encoderCount = 0;\r\n    lastTime = currentTime;\r\n    return rpm;\r\n  }\r\n  return motorInput;\r\n}`);\r\n    \r\n    return `motorInput = calculateRPM();\\nmotorPID.Compute();\\nanalogWrite(${motorPin}, motorOutput);\\n`;\r\n};\r\n\r\n// 获取PID输入值\r\nArduino.forBlock['pid_get_input'] = function(block, generator) {\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    \r\n    return [`${inputVar}`, Arduino.ORDER_ATOMIC];\r\n};\r\n\r\n// 获取PID输出值\r\nArduino.forBlock['pid_get_output'] = function(block, generator) {\r\n    const outputVar = getVariableName(block, 'OUTPUT');\r\n    \r\n    return [`${outputVar}`, Arduino.ORDER_ATOMIC];\r\n};\r\n\r\n// 设置PID目标值\r\nArduino.forBlock['pid_set_setpoint'] = function(block, generator) {\r\n    const setpointVar = getVariableName(block, 'SETPOINT');\r\n    const value = generator.valueToCode(block, 'VALUE', Arduino.ORDER_ATOMIC) || '0';\r\n    \r\n    return `${setpointVar} = ${value};\\n`;\r\n};\r\n\r\n// 设置PID输入值\r\nArduino.forBlock['pid_set_input'] = function(block, generator) {\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    const value = generator.valueToCode(block, 'VALUE', Arduino.ORDER_ATOMIC) || '0';\r\n    \r\n    return `${inputVar} = ${value};\\n`;\r\n};\r\n\r\n// 自适应PID控制\r\nArduino.forBlock['pid_adaptive_control'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    const setpointVar = getVariableName(block, 'SETPOINT');\r\n    const threshold = block.getFieldValue('THRESHOLD');\r\n    const aggKp = block.getFieldValue('AGG_KP');\r\n    const aggKi = block.getFieldValue('AGG_KI');\r\n    const aggKd = block.getFieldValue('AGG_KD');\r\n    const consKp = block.getFieldValue('CONS_KP');\r\n    const consKi = block.getFieldValue('CONS_KI');\r\n    const consKd = block.getFieldValue('CONS_KD');\r\n    \r\n    // 添加库引用\r\n    generator.addLibrary('pid_lib', '#include <PID_v1.h>');\r\n    \r\n    // 添加自适应参数变量\r\n    generator.addVariable(`adaptive_${pidName}`, `double aggKp_${pidName} = ${aggKp}, aggKi_${pidName} = ${aggKi}, aggKd_${pidName} = ${aggKd};`);\r\n    generator.addVariable(`conservative_${pidName}`, `double consKp_${pidName} = ${consKp}, consKi_${pidName} = ${consKi}, consKd_${pidName} = ${consKd};`);\r\n    \r\n    const code = `double gap_${pidName} = abs(${setpointVar} - ${inputVar});\r\nif (gap_${pidName} < ${threshold}) {\r\n    ${pidName}.SetTunings(consKp_${pidName}, consKi_${pidName}, consKd_${pidName});\r\n} else {\r\n    ${pidName}.SetTunings(aggKp_${pidName}, aggKi_${pidName}, aggKd_${pidName});\r\n}\r\n${pidName}.Compute();\r\n`;\r\n    \r\n    return code;\r\n};\r\n\r\n// PID比例控制模式设置 (P_ON_M vs P_ON_E)\r\nArduino.forBlock['pid_set_proportional_mode'] = function(block, generator) {\r\n    const pidName = getVariableName(block, 'PID_NAME');\r\n    const mode = block.getFieldValue('MODE'); // P_ON_M 或 P_ON_E\r\n    const direction = block.getFieldValue('DIRECTION');\r\n    \r\n    // 注意：需要重新初始化PID对象来改变比例模式\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    const outputVar = getVariableName(block, 'OUTPUT');\r\n    const setpointVar = getVariableName(block, 'SETPOINT');\r\n    const kp = generator.valueToCode(block, 'KP', Arduino.ORDER_ATOMIC) || '2';\r\n    const ki = generator.valueToCode(block, 'KI', Arduino.ORDER_ATOMIC) || '5';\r\n    const kd = generator.valueToCode(block, 'KD', Arduino.ORDER_ATOMIC) || '1';\r\n    \r\n    return `${pidName} = PID(&${inputVar}, &${outputVar}, &${setpointVar}, ${kp}, ${ki}, ${kd}, ${mode}, ${direction});\\n${pidName}.SetMode(AUTOMATIC);\\n`;\r\n};\r\n\r\n// 判断条件：PID是否达到目标值\r\nArduino.forBlock['pid_is_at_setpoint'] = function(block, generator) {\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    const setpointVar = getVariableName(block, 'SETPOINT');\r\n    const tolerance = block.getFieldValue('TOLERANCE');\r\n    \r\n    const code = `abs(${setpointVar} - ${inputVar}) <= ${tolerance}`;\r\n    return [code, Arduino.ORDER_RELATIONAL];\r\n};\r\n\r\n// 获取PID误差值\r\nArduino.forBlock['pid_get_error'] = function(block, generator) {\r\n    const inputVar = getVariableName(block, 'INPUT');\r\n    const setpointVar = getVariableName(block, 'SETPOINT');\r\n    \r\n    const code = `(${setpointVar} - ${inputVar})`;\r\n    return [code, Arduino.ORDER_ADDITIVE];\r\n};\r\n"
};
