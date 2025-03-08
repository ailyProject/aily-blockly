function findDependencies(prjPath) {
    boardList = [];
    libraryList = [];
  
    const nodeModulesPath = path.join(prjPath, 'node_modules/@aily-blockly');
  
    if (!fs.existsSync(nodeModulesPath)) {
      return { boardList, libraryList };
    }
  
    fs.readdirSync(nodeModulesPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        if (entry.name.startsWith('board-')) {
          boardList.push(path.join(nodeModulesPath, entry.name));
        } else if (entry.name.startsWith('library-')) {
          libraryList.push(path.join(nodeModulesPath, entry.name));
        } else {
          console.log(`Unknown module: ${entry.name}`);
        }
      });
  
    return { boardList, libraryList };
  }
  
  function getDependencieName(depPath) {
    return path.basename(depPath);
  }
  
  // 读取依赖的配置文件（<depName>.json）
  function getDependencieConfJson(depPath, keys) {
    const depName = getDependencieName(depPath);
    let configFileName;
    if (depName.startsWith("board-")) {
      configFileName = depName.substring("board-".length) + ".json";
    } else if (depName.startsWith("library-")) {
      configFileName = depName.substring("library-".length) + ".json";
    } else {
      configFileName = depName + ".json";
    }
    const configPath = path.join(depPath, configFileName);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const configContent = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configContent);
  
    if (Array.isArray(keys) && keys.length > 0) {
      return keys.reduce((result, key) => {
        if (Object.prototype.hasOwnProperty.call(config, key)) {
          result[key] = config[key];
        }
        return result;
      }, {});
    }
  
    return config;
  }
  
  function getDependencies(prjPath) {
    const result = findDependencies(prjPath);
    result["boardConfList"] = [];
    result["libraryConfList"] = [];
  
    result.boardList.map(depPath => {
      const depName = getDependencieName(depPath);
      const depConf = getDependencieConfJson(depPath, ["core", "type", "compilerTool", "compilerParam", "uploadParam"]);
      result["boardConfList"].push(depConf);
    });
    result.libraryList.map(depPath => {
      const depName = getDependencieName(depPath);
      const depConf = getDependencieConfJson(depPath, ["source"]);
      result["libraryConfList"].push(depConf);
    });
  
    console.log("buildResult: ", result);
    return result;
  }
  
  /**
   * 初始化arduino-cli配置文件
   * @param {string} prjPath 项目路径
   * @param {string} rootPath 程序资源根目录
   * @returns {string} arduino-cli配置文件路径
   */
  function initArduinoCliConf(prjPath, rootPath) {
    // 判断项目下是否存在arduino-cli.yaml配置文件，如果存在则直接返回
    console.log("initArduinoCliConf: ", prjPath, rootPath);
    const cliYamlPath = path.join(prjPath, "arduino-cli.yaml");
    if (fs.existsSync(cliYamlPath)) {
      return cliYamlPath;
    }
  
    const directories = {
      "data": path.join(rootPath, "arduino15"),
      "downloads": path.join(rootPath, "staging"),
      "user": path.join(prjPath, "libraries"),
    }
  
    // 创建arduino-cli配置文件
    let cliYamlContent = `directories:\n`;
    Object.keys(directories).map(key => {
      cliYamlContent += `  ${key}: ${directories[key]}\n`;
    });
    fs.writeFileSync(cliYamlPath, cliYamlContent);
  
    console.log("arduino-cli.yaml created: ", cliYamlPath);
    return cliYamlPath;
  }
  
  function genBuilderJson(data, prjPath) {
    const builderJson = {
      "core": data.core,
      "type": data.type,
      "compilerOutput": data.compilerOutput,
      "compilerParam": data.compilerParam,
      "cliYamlPath": data.cliYamlPath,
      "sketchPath": data.sketchPath,
    }
  
    const builderJsonPath = path.join(prjPath, ".builder.json");
    fs.writeFileSync(builderJsonPath, JSON.stringify(builderJson, null, 2));
  }
  
  function arduinoCodeGen(code, prjPath) {
    // 读取prjPath下的builder.json文件
    const builderJsonPath = path.join(prjPath, ".builder.json");
    if (!fs.existsSync(builderJsonPath)) {
      throw new Error("builder.json not found");
    }
    const builderJsonContent = fs.readFileSync(builderJsonPath, "utf8");
    const builderJson = JSON.parse(builderJsonContent);
  
    const sketchPath = builderJson.sketchPath;
    if (!fs.existsSync(sketchPath)) {
      fs.mkdirSync(sketchPath, { recursive: true });
    }
    const folderName = path.basename(sketchPath);
    const codePath = path.join(sketchPath, `${folderName}.ino`);
    fs.writeFileSync(codePath, code);
  }
  
  function arduinoCliBuilder(prjPath) {
    const cliPath = '.\\child\\arduino-cli.exe';
  
    // 读取prjPath下的builder.json文件
    const builderJsonPath = path.join(prjPath, ".builder.json");
    if (!fs.existsSync(builderJsonPath)) {
      throw new Error("builder.json not found");
    }
    const builderJsonContent = fs.readFileSync(builderJsonPath, "utf8");
    const builderJson = JSON.parse(builderJsonContent);
  
    return new Promise((resolve, reject) => {
      console.log("FQBN: ", builderJson.type);
      const arduinoCli = spawn(
        cliPath,
        ['compile', '-b', builderJson.type, builderJson.sketchPath, '--config-file', builderJson.cliYamlPath, '--output-dir', builderJson.compilerOutput, '--log-level', 'trace']);
      arduinoCli.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
      });
      arduinoCli.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });
      arduinoCli.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        if (code === 0) {
          resolve();
        } else {
          reject();
        }
      });
    });
  }
  
  function arduinoCliUploader(port, prjPath) {
    const cliPath = '.\\child\\arduino-cli.exe';
  
    // 读取prjPath下的builder.json文件
    const builderJsonPath = path.join(prjPath, ".builder.json");
    if (!fs.existsSync(builderJsonPath)) {
      throw new Error("builder.json not found");
    }
    const builderJsonContent = fs.readFileSync(builderJsonPath, "utf8");
    const builderJson = JSON.parse(builderJsonContent);
  
    return new Promise((resolve, reject) => {
      console.log("FQBN: ", builderJson.type);
      const arduinoCli = spawn(
        cliPath,
        ['upload', '-b', builderJson.type, '--input-dir', builderJson.compilerOutput, '-p', port]);
      arduinoCli.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
      });
      arduinoCli.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });
      arduinoCli.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        if (code === 0) {
          resolve();
        } else {
          reject();
        }
      });
    });
  }


  ipcMain.handle("builder-codeGen", async (event, data) => {
    try {
      arduinoCodeGen(data.code, data.prjPath);
      return { success: true };
    } catch (error) {
      console.error("builder-codeGen error: ", error);
      return { success: false };
    }
  });

  ipcMain.handle("builder-build", async (event, data) => {
    try {
      await arduinoCliBuilder(data.prjPath);
      return { success: true };
    } catch (error) {
      console.error("builder-build error: ", error);
      return { success: false };
    }
  });

  ipcMain.handle("uploader-upload", async (event, data) => {
    try {
      await arduinoCliUploader(data.port, data.prjPath);
      return { success: true };
    } catch (error) {
      console.error("uploader-upload error: ", error);
      return { success: false };
    }
  });