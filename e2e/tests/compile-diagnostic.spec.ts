import { expect, test } from '@playwright/test';
import { extractCompileDiagnostic } from '../compile-diagnostic';

test.describe('compile diagnostic extraction', () => {
  test('提取带源码位置的 Arduino 错误并清理 ANSI 与包装文本', () => {
    const diagnostic = extractCompileDiagnostic([
      '[2026-07-15T10:20:30.123Z] 检测到编译错误: \u001B[01m\u001B[KD:\\demo\\main.ino:12:3:\u001B[m\u001B[K \u001B[01;31m\u001B[Kerror:\u001B[m\u001B[K \'ledPin\' was not declared in this scope',
      '[ERROR] 编译进程异常退出，退出码: 1',
    ]);

    expect(diagnostic).toBe(
      "D:\\demo\\main.ino:12:3: error: 'ledPin' was not declared in this scope",
    );
  });

  test('优先返回缺失头文件而不是页面网络噪音', () => {
    const diagnostic = extractCompileDiagnostic([
      'Failed to load resource: net::ERR_CONNECTION_CLOSED',
      '/tmp/sketch/main.cpp:8:10: fatal error: WiFi.h: No such file or directory',
      'compilation terminated.',
    ]);

    expect(diagnostic).toBe(
      '/tmp/sketch/main.cpp:8:10: fatal error: WiFi.h: No such file or directory',
    );
  });

  test('链接根因优先于 collect2 的退出摘要', () => {
    const diagnostic = extractCompileDiagnostic([
      "xtensa-esp32-elf-ld.exe: main.o: undefined reference to `setup()'",
      'collect2.exe: error: ld returned 1 exit status',
    ]);

    expect(diagnostic).toBe(
      "xtensa-esp32-elf-ld.exe: main.o: undefined reference to `setup()'",
    );
  });

  test('只有退出码时返回退出码作为降级诊断', () => {
    expect(extractCompileDiagnostic(['exit status 1'])).toBe('exit status 1');
    expect(extractCompileDiagnostic(['Process exited with code 2'])).toBe('Process exited with code 2');
  });

  test('只有页面和编排状态噪音时不误报', () => {
    const diagnostic = extractCompileDiagnostic([
      '[pageerror] TypeError: unrelated renderer failure',
      'Failed to load resource: net::ERR_CONNECTION_CLOSED',
      '编译命令完成： buildCompleted= false isErrored= true lastProgress= 0',
      'lastBuildStatus: error',
      '编译失败，耗时: 20.14 秒',
    ]);

    expect(diagnostic).toBeNull();
  });

  test('同级多个源码错误保留最先出现的根因', () => {
    const first = "D:\\demo\\main.ino:12:3: error: 'ledPin' was not declared in this scope";
    const diagnostic = extractCompileDiagnostic([
      first,
      first,
      'D:\\demo\\main.ino:20:5: error: expected semicolon before closing brace',
    ]);

    expect(diagnostic).toBe(first);
  });
});
