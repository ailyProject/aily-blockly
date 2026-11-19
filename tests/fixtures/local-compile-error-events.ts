// Captured from a real aily-builder ESP32C3 compile of an undefined symbol.
// Only machine-specific path prefixes were replaced; stream/chunk boundaries remain.
export const localCompileDiagnostic = "error: 'local_duplicate_diagnostic_probe' was not declared in this scope";
export const localCompileErrorEvents: ReadonlyArray<{ type: 'stdout' | 'stderr'; data: string }> = [
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Starting compilation of C:\\fixture\\project\\sketch\\sketch.ino\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Board: esp32:esp32:esp32c3\n\u001b[34m[INFO]\u001b[0m Build path: C:\\fixture\\project\\build\n\u001b[34m[INFO]\u001b[0m Libraries paths: \n\u001b[34m[INFO]\u001b[0m Tool versions: {\"esp-rv32\":\"14.2.0\",\"esp32c3-libs\":\"3.3.12\",\"esptool_py\":\"5.3.1\",\"ctags\":\"5.8.0\"}\n\u001b[34m[INFO]\u001b[0m Parallel jobs: 1\n\u001b[34m[INFO]\u001b[0m Starting compilation process...\n\u001b[34m[INFO]\u001b[0m Starting preprocessing...\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Extracted 0 macros from sketch: none\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Global prebuild: 8 recipe(s)\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Starting parallel preprocessing tasks...\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Generating compile configuration...\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Analyzing dependencies...\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m - Sketch Path: C:\\fixture\\project\\sketch\\sketch.ino\n\u001b[34m[INFO]\u001b[0m - Core SDK Path: C:\\fixture\\aily-project\\sdk\\esp32_3.3.12\\cores\\esp32\n\u001b[34m[INFO]\u001b[0m - Variant Path: C:\\fixture\\aily-project\\sdk\\esp32_3.3.12\\variants\\esp32c3\n\u001b[34m[INFO]\u001b[0m - Core Libraries Path: C:\\fixture\\aily-project\\sdk\\esp32_3.3.12\\libraries\n\u001b[34m[INFO]\u001b[0m - Libraries Paths: \n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Initialized default macros: 1683 definitions\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Dependency analysis completed.\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m Found 2 dependencies.\n\u001b[34m[INFO]\u001b[0m |- core\n\u001b[34m[INFO]\u001b[0m |- variant\n\u001b[34m[INFO]\u001b[0m Preprocessing completed in 1074ms\n"
  },
  {
    "type": "stdout",
    "data": "[aily-builder:progress] {\"protocolVersion\":1,\"stage\":\"preparing\",\"percent\":1,\"status\":\"running\",\"message\":\"Preparing build\"}\n"
  },
  {
    "type": "stdout",
    "data": "[aily-builder:progress] {\"protocolVersion\":1,\"stage\":\"sketch\",\"percent\":5,\"status\":\"running\",\"message\":\"Compiling sketch\"}\n\u001b[34m[INFO]\u001b[0m Starting ninja stage: __aily_sketch_ready\n"
  },
  {
    "type": "stdout",
    "data": "\u001b[34m[INFO]\u001b[0m [1/1] riscv32-esp-elf-g++ -MMD -c \"@C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/flags/cpp_flags\" -w -Os -Werror=return-type -DF_CPU=160000000L -DARDUINO=10607 -DARDUINO_ESP32C3_DEV -DARDUINO_ARCH_ESP32 \"-DARDUINO_BOARD=\\\"ESP32C3_DEV\\\"\" \"-DARDUINO_VARIANT=\\\"esp32c3\\\"\" -DARDUINO_PARTITION_default \"-DARDUINO_HOST_OS=\\\"windows\\\"\" \"-DARDUINO_FQBN=\\\"esp32:esp32:esp32c3:JTAGAdapter=default,CDCOnBoot=default,PartitionScheme=default,CPUFreq=160,FlashMode=qio,FlashFreq=80,FlashSize=4M,UploadSpeed=921600,DebugLevel=none,EraseFlash=none,ZigbeeMode=default\\\"\" -DESP32=ESP32 -DCORE_DEBUG_LEVEL=0 -DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=0 \"@C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/flags/defines\" \"-IC:\\fixture\\project\\sketch\" -iprefix \"C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/include/\" \"@C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/flags/includes\" \"-IC:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/qio_qspi/include\" \"-IC:/fixture/aily-project/sdk/esp32_3.3.12/cores/esp32\" \"-IC:/fixture/aily-project/sdk/esp32_3.3.12/variants/esp32c3\" \"@C:\\fixture\\project\\build/build_opt.h\" \"@C:\\fixture\\project\\build/file_opts\" sketch.cpp -o sketch/sketch.cpp.o -MF \"sketch/sketch.cpp.o.d\"\n"
  },
  {
    "type": "stdout",
    "data": "[aily-builder:progress] {\"protocolVersion\":1,\"stage\":\"sketch\",\"percent\":15,\"status\":\"running\",\"message\":\"Compiling sketch\"}\n"
  },
  {
    "type": "stderr",
    "data": "\u001b[31m[ERROR]\u001b[0m FAILED: [code=1] sketch/sketch.cpp.o\n"
  },
  {
    "type": "stderr",
    "data": "\u001b[31m[ERROR]\u001b[0m riscv32-esp-elf-g++ -MMD -c \"@C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/flags/cpp_flags\" -w -Os -Werror=return-type -DF_CPU=160000000L -DARDUINO=10607 -DARDUINO_ESP32C3_DEV -DARDUINO_ARCH_ESP32 \"-DARDUINO_BOARD=\\\"ESP32C3_DEV\\\"\" \"-DARDUINO_VARIANT=\\\"esp32c3\\\"\" -DARDUINO_PARTITION_default \"-DARDUINO_HOST_OS=\\\"windows\\\"\" \"-DARDUINO_FQBN=\\\"esp32:esp32:esp32c3:JTAGAdapter=default,CDCOnBoot=default,PartitionScheme=default,CPUFreq=160,FlashMode=qio,FlashFreq=80,FlashSize=4M,UploadSpeed=921600,DebugLevel=none,EraseFlash=none,ZigbeeMode=default\\\"\" -DESP32=ESP32 -DCORE_DEBUG_LEVEL=0 -DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=0 \"@C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/flags/defines\" \"-IC:\\fixture\\project\\sketch\" -iprefix \"C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/include/\" \"@C:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/flags/includes\" \"-IC:\\fixture\\aily-project\\tools\\esp32c3-libs@3.3.12/qio_qspi/include\" \"-IC:/fixture/aily-project/sdk/esp32_3.3.12/cores/esp32\" \"-IC:/fixture/aily-project/sdk/esp32_3.3.12/variants/esp32c3\" \"@C:\\fixture\\project\\build/build_opt.h\" \"@C:\\fixture\\project\\build/file_opts\" sketch.cpp -o sketch/sketch.cpp.o -MF \"sketch/sketch.cpp.o.d\"\n\u001b[31m[ERROR]\u001b[0m C:\\fixture\\project\\sketch\\sketch.ino: In function 'void setup()':\n\u001b[31m[ERROR]\u001b[0m C:\\fixture\\project\\sketch\\sketch.ino:2:16: error: 'local_duplicate_diagnostic_probe' was not declared in this scope\n\u001b[31m[ERROR]\u001b[0m 2 | void loop() {}\n\u001b[31m[ERROR]\u001b[0m |                ^\n"
  },
  {
    "type": "stderr",
    "data": "\u001b[31m[ERROR]\u001b[0m Compilation failed: Sketch compilation failed\n"
  }
];
