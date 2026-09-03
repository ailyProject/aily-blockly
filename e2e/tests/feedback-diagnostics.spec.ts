import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import {
  expect,
  getMainWindow,
  launchAilyElectron,
  openBlocklyProject,
  test,
} from '../fixtures/electron-app';

type FeedbackLabel = 'bug' | 'build&upload' | 'library' | 'other' | 'feature';

interface FeedbackRequestPayload {
  label?: unknown;
  title?: unknown;
  content?: unknown;
  contact?: unknown;
  timestamp?: unknown;
  email?: unknown;
  [key: string]: unknown;
}

interface CrashDiagnosticFixture {
  forbiddenMarkers: string[];
  userPathSegments: string[];
}

const CONTACT_EMAIL = 'feedback-e2e-contact@example.invalid';
const TRUNCATION_MARKER = '[truncated; latest content retained]';
const LONG_LOG_TAIL = 'feedback-e2e-latest-crash-tail';
const COMPILE_LOG_TAIL = 'feedback-e2e-older-compile-tail';
const UPLOAD_LOG_TAIL = 'feedback-e2e-newest-upload-tail';
const PRIVATE_PROJECT_NAME = 'feedback-e2e-private-project';
const PRIVATE_PROJECT_NICKNAME = 'Feedback E2E Private Project';
const PRIVATE_SOURCE_CODE = 'feedback_e2e_private_source();';
const PRIVATE_USER_AGENT = 'feedback-e2e-private-user-agent/1.0';
const PRIVATE_OS_USERNAME = 'feedback-e2e-private-os-user';
const VISIBLE_NON_USER_PATH = 'D:\\ailyblockly\\feedback-visible-project\\src\\partitions.csv';
const PRIVATE_USER_PATH = `C:\\Users\\${PRIVATE_OS_USERNAME}\\workspace\\src\\partitions.csv`;
const REDACTED_USER_PATH = 'C:\\Users\\[USER]\\workspace\\src\\partitions.csv';
const DIAGNOSTIC_TEXT_MAX_BYTES = 32 * 1024;
const ISSUE_FOOTER = '> This issue was sent by the user using the built-in feedback function.';
const EXPECTED_PAYLOAD_KEYS = ['contact', 'content', 'email', 'label', 'timestamp', 'title'];

const feedbackCases: ReadonlyArray<{
  label: FeedbackLabel;
  radioIndex: number;
  diagnosticHeadings: readonly string[];
}> = [
  {
    label: 'bug',
    radioIndex: 0,
    diagnosticHeadings: ['### Project Summary', '### Crash Summary', '### Logs'],
  },
  {
    label: 'build&upload',
    radioIndex: 1,
    diagnosticHeadings: [
      '### Board and Port',
      '### Libraries',
      '### Parameters',
      '### Last Results',
      '### Compile / Upload Logs',
    ],
  },
  {
    label: 'library',
    radioIndex: 2,
    diagnosticHeadings: ['### Library', '### Related Logs'],
  },
  {
    label: 'other',
    radioIndex: 3,
    diagnosticHeadings: ['### Latest Error'],
  },
  {
    label: 'feature',
    radioIndex: 4,
    diagnosticHeadings: [],
  },
];

test.describe('反馈诊断正文', () => {
  test('五类反馈只提交允许公开的正文与独立联系方式', async () => {
    test.setTimeout(180_000);
    const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'aily-feedback-e2e-home-'));
    try {
      const projectPath = await stageProjectDiagnosticFixture(temporaryHome);
      const launched = await launchAilyElectron({
        environment: homeEnvironment(temporaryHome),
      });
      try {
        const mainWindow = await getMainWindow(launched.app);
        await mainWindow.waitForLoadState('domcontentloaded').catch(() => {});
        const capturedRequests: FeedbackRequestPayload[] = [];

        await mainWindow.route('**/api/v1/feedback/submit', async (route) => {
          const request = route.request();
          if (request.method() !== 'POST') {
            await route.fulfill({ status: 204 });
            return;
          }

          const body = request.postDataJSON();
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('反馈请求正文不是 JSON 对象。');
          }
          capturedRequests.push(body as FeedbackRequestPayload);
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 201,
              data: '',
              messages: 'Feedback created successfully',
            }),
          });
        });

        await dismissBlockingLoginDialog(mainWindow);
        await openBlocklyProject(mainWindow, projectPath);
        await expect(mainWindow.locator('app-blockly-editor')).toBeVisible();
        await expect(mainWindow.locator('app-header .project-box')).toContainText(PRIVATE_PROJECT_NICKNAME);
        const crashFixture = await appendCrashDiagnosticFixture(mainWindow, temporaryHome);
        const forbiddenMarkers = [
          ...crashFixture.forbiddenMarkers,
          PRIVATE_SOURCE_CODE,
        ];

        for (const [caseIndex, feedbackCase] of feedbackCases.entries()) {
          await openFeedbackDialog(mainWindow);
          const dialog = mainWindow.locator('app-feedback-dialog');
          await expect(dialog).toBeVisible();

          const radios = dialog.locator('nz-radio-group input[type="radio"]');
          const radioLabels = dialog.locator('nz-radio-group label.ant-radio-wrapper');
          await expect(radios).toHaveCount(feedbackCases.length);
          await expect(radioLabels).toHaveCount(feedbackCases.length);
          const targetRadio = radios.nth(feedbackCase.radioIndex);
          const targetRadioLabel = radioLabels.nth(feedbackCase.radioIndex);
          await targetRadioLabel.click();
          await expect(targetRadioLabel).toHaveClass(/ant-radio-wrapper-checked/);
          await expect(targetRadio).toBeChecked();

          const descriptionInput = dialog.locator('textarea.form-control');
          if (feedbackCase.label === 'library') {
            await expect(descriptionInput).toHaveValue('');
          }

          const title = `Feedback diagnostics E2E ${feedbackCase.label}`;
          const description = `Feedback diagnostics E2E description for ${feedbackCase.label}.`;
          const textInputs = dialog.locator('input.form-control');
          await expect(textInputs).toHaveCount(2);
          await textInputs.nth(0).fill(`  ${title}  `);
          await descriptionInput.fill(description);
          await textInputs.nth(1).fill(`  ${CONTACT_EMAIL}  `);

          await dialog.locator('app-base-dialog .footer button').click();
          await expect.poll(() => capturedRequests.length).toBe(caseIndex + 1);
          await expect(dialog).toHaveCount(0);

          const payload = capturedRequests[caseIndex];
          expect(payload).toBeDefined();
          expect(payload.label).toBe(feedbackCase.label);
          expect(payload.title).toBe(title);
          expect(payload.email).toBe(CONTACT_EMAIL);
          expect(typeof payload.timestamp).toBe('string');
          expect(typeof payload.content).toBe('string');
          expect(Object.keys(payload).sort()).toEqual(EXPECTED_PAYLOAD_KEYS);
          expect(payload).not.toHaveProperty('userAgent');

          const content = String(payload.content);
          const timestamp = String(payload.timestamp);
          expect(content.startsWith('## Issue Description\n\n')).toBe(true);
          expect(content).toContain(description);
          expect(content).not.toContain('Please describe the issue you encountered:');
          expect(content).not.toContain('请描述你遇到的问题：');
          expect(content.endsWith(ISSUE_FOOTER)).toBe(true);

          const levelTwoHeadings = content.match(/^## .+$/gm) || [];
          expect(levelTwoHeadings).toEqual(
            feedbackCase.label === 'feature'
              ? ['## Issue Description', '## Environment']
              : ['## Issue Description', '## Environment', '## Diagnostics'],
          );
          expectInOrder(content, [
            '## Issue Description',
            '## Environment',
            ...(feedbackCase.label === 'feature' ? [] : ['## Diagnostics']),
            '\n\n---\n\n',
            ISSUE_FOOTER,
          ]);

          for (const field of [
            'Software Version',
            'OS',
            'UI Language',
            'Feedback Time',
            'Account Status Code',
          ]) {
            expect(content).toContain(`| ${field} |`);
          }
          expectNonNullTableValue(content, 'Software Version');
          expect(readTableValue(content, 'OS')).toBe(process.platform);
          expectNonNullTableValue(content, 'UI Language');
          expect(content).toContain(`| Feedback Time | ${timestamp} |`);
          expect(/^\| Account Status Code \| (?:000|110|101|100|null) \|$/m.test(content)).toBe(true);

          const actualDiagnosticHeadings = content.match(/^### .+$/gm) || [];
          expect(actualDiagnosticHeadings).toEqual(feedbackCase.diagnosticHeadings);
          expect(diagnosticCodeBlockByteLength(content)).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_MAX_BYTES);

          const hasForbiddenMarker = forbiddenMarkers.some((marker) => marker && content.includes(marker));
          expect(hasForbiddenMarker, '公开反馈正文不得包含联系方式、账号身份、凭证或用户目录名').toBe(false);
          const hasUnredactedUserPathSegment = crashFixture.userPathSegments.some((username) => (
            new RegExp(`[\\\\/]${escapeRegExp(username)}(?=[\\\\/])`, 'i').test(content)
          ));
          expect(hasUnredactedUserPathSegment, '公开反馈正文不得包含路径中的用户名段').toBe(false);
          expect(content.includes(CONTACT_EMAIL), '邮箱只能存在于独立请求字段').toBe(false);
          expect(hasForbiddenPublicField(content)).toBe(false);

          if (feedbackCase.label === 'bug') {
            expect(content).toContain('[REDACTED]');
            expect(content).toContain('[USER]');
            expect(content).toContain(VISIBLE_NON_USER_PATH);
            expect(content).toContain(REDACTED_USER_PATH);
            expect(content).not.toContain(PRIVATE_USER_PATH);
            expect(content).toContain('renderer/index.html');
            expect(content).toContain('partitions.csv');
            expect(content).toContain(TRUNCATION_MARKER);
            expect(content).toContain(LONG_LOG_TAIL);
          }
          if (feedbackCase.label === 'build&upload') {
            const compileLog = readDetailsText(content, 'Compile Log');
            const uploadLog = readDetailsText(content, 'Upload Log');
            expect(compileLog).toBe(TRUNCATION_MARKER);
            expect(compileLog).not.toContain(COMPILE_LOG_TAIL);
            expect(uploadLog).toContain(TRUNCATION_MARKER);
            expect(uploadLog).toContain(UPLOAD_LOG_TAIL);
            expect(content).toContain('"status": "success"');
            expect(content).not.toContain(PRIVATE_SOURCE_CODE);
          }
        }

        expect(capturedRequests).toHaveLength(feedbackCases.length);
      } finally {
        await launched.close();
      }
    } finally {
      await rm(temporaryHome, { recursive: true, force: true });
    }
  });
});

async function stageProjectDiagnosticFixture(temporaryHome: string): Promise<string> {
  const projectPath = path.join(temporaryHome, PRIVATE_PROJECT_NAME);
  if (!isPathInside(projectPath, temporaryHome)) {
    throw new Error(`拒绝创建未隔离的 E2E 项目：${projectPath}`);
  }

  const compileDirectory = path.join(projectPath, '.log', 'compile', '20260902');
  const uploadDirectory = path.join(projectPath, '.log', 'upload', '20260902');
  await Promise.all([
    mkdir(compileDirectory, { recursive: true }),
    mkdir(uploadDirectory, { recursive: true }),
  ]);

  const packageJson = {
    name: PRIVATE_PROJECT_NAME,
    nickname: PRIVATE_PROJECT_NICKNAME,
    version: '1.0.0',
    devmode: 'arduino',
    dependencies: {},
    buildInfo: {
      lastBuildStatus: 'success',
      lastBuildTime: '2026-09-02T10:14:00.000Z',
      lastBuildDuration: 1.25,
      lastBuildCode: PRIVATE_SOURCE_CODE,
    },
  };
  const projectAbi = {
    blocks: { languageVersion: 0, blocks: [] },
    variables: [],
  };
  const compileLines = createLargeProjectLogLines(
    'compile',
    '2026-09-02 10:15:00.000',
    '编',
    COMPILE_LOG_TAIL,
  );
  const uploadLines = createLargeProjectLogLines(
    'upload',
    '2026-09-02 10:16:00.000',
    '传',
    UPLOAD_LOG_TAIL,
  );

  await Promise.all([
    writeFile(path.join(projectPath, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8'),
    writeFile(path.join(projectPath, 'project.abi'), `${JSON.stringify(projectAbi, null, 2)}\n`, 'utf8'),
    writeFile(path.join(compileDirectory, '10-15.log'), `${compileLines.join('\n')}\n`, 'utf8'),
    writeFile(path.join(uploadDirectory, '10-16.log'), `${uploadLines.join('\n')}\n`, 'utf8'),
  ]);
  return projectPath;
}

function createLargeProjectLogLines(
  source: 'compile' | 'upload',
  timestamp: string,
  fill: string,
  tailMarker: string,
): string[] {
  return Array.from({ length: 400 }, (_, index) => (
    `[${timestamp}] [ERROR] [${source}] ${fill.repeat(40)}-${index}`
    + (index === 399 ? `-${tailMarker}` : '')
  ));
}

async function openFeedbackDialog(page: Page): Promise<void> {
  await page.locator('app-header .header-box > .menu').click();
  const feedbackItem = page.locator('app-header app-menu.main-menu-parity .menu-item', {
    has: page.locator('i.fa-messages-question'),
  });
  await expect(feedbackItem).toBeVisible();
  await feedbackItem.click();
}

async function dismissBlockingLoginDialog(page: Page): Promise<void> {
  const loginModal = page.locator('nz-modal-container.login-modal-wrap');
  await loginModal.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (!await loginModal.isVisible()) {
    return;
  }
  const closeButton = loginModal.locator('app-login button.login-close');
  await expect(closeButton).toBeVisible();
  await closeButton.click();
  await expect(loginModal).toHaveCount(0);
}

async function appendCrashDiagnosticFixture(page: Page, temporaryHome: string): Promise<CrashDiagnosticFixture> {
  const runtimePaths = await page.evaluate(() => {
    const pathApi = (window as unknown as {
      path?: {
        getAppDataPath?: () => unknown;
        getUserHome?: () => unknown;
      };
    }).path;
    const appDataPath = pathApi?.getAppDataPath?.();
    const userHome = pathApi?.getUserHome?.();
    return {
      appDataPath: typeof appDataPath === 'string' ? appDataPath : '',
      userHome: typeof userHome === 'string' ? userHome : '',
      userAgent: navigator.userAgent,
    };
  });
  if (!runtimePaths.appDataPath) {
    throw new Error('E2E 临时 AppData 路径不可用。');
  }
  if (!isPathInside(runtimePaths.appDataPath, temporaryHome)) {
    throw new Error(`拒绝写入未隔离的 AppData 路径：${runtimePaths.appDataPath}`);
  }

  const privateUserId = 'feedback-e2e-private-user-id';
  const privateToken = 'feedback-e2e-private-token';
  const privateSerial = 'feedback-e2e-private-serial';
  const privateProjectPath = path.join(runtimePaths.appDataPath, 'projects', 'private-project');
  const privateLibraryPath = path.join(runtimePaths.appDataPath, 'libraries', 'private-library');
  const privateFileUrl = pathToFileURL(path.join(runtimePaths.appDataPath, 'renderer', 'index.html')).href;
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const crashLines = [
    `[${timestamp}] [error] ${'旧'.repeat(3_000)}`,
    `[${timestamp}] [error] ${'旧'.repeat(3_000)}`,
    `[${timestamp}] [error] Missing partitions.csv: ${VISIBLE_NON_USER_PATH}; mirror ${PRIVATE_USER_PATH}`,
    `[${timestamp}] [error] [ProcessHealth][RendererGone] ${JSON.stringify({ reason: 'crashed', exitCode: 17, url: privateFileUrl })}`,
    `[${timestamp}] [error] user_id=${privateUserId} email=${CONTACT_EMAIL} serialNumber=${privateSerial} Authorization: Bearer ${privateToken}`,
    `[${timestamp}] [error] userAgent=${PRIVATE_USER_AGENT} projectPath="${privateProjectPath}" localLibraryPath="${privateLibraryPath}"`,
    `[${timestamp}] [error] ${LONG_LOG_TAIL}`,
  ];

  const logDirectory = path.join(runtimePaths.appDataPath, 'logs');
  await mkdir(logDirectory, { recursive: true });
  await appendFile(path.join(logDirectory, 'app.log'), `\n${crashLines.join('\n')}\n`, 'utf8');
  const runtimeUsernames = readUserDirectoryNames(runtimePaths.appDataPath, runtimePaths.userHome);
  if (process.platform === 'win32' && runtimeUsernames.length === 0) {
    throw new Error('E2E 未能从 Windows 运行时路径提取用户名目录段。');
  }

  return {
    forbiddenMarkers: [
      CONTACT_EMAIL,
      privateUserId,
      privateToken,
      privateSerial,
      PRIVATE_USER_AGENT,
      runtimePaths.userAgent,
    ],
    userPathSegments: [...new Set([
      PRIVATE_OS_USERNAME,
      ...runtimeUsernames,
      ...runtimeUsernames.map((username) => encodeURIComponent(username)),
    ])],
  };
}

function homeEnvironment(temporaryHome: string): Record<string, string> {
  if (process.platform !== 'win32') {
    return { HOME: temporaryHome };
  }

  const root = path.parse(temporaryHome).root;
  return {
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    HOMEDRIVE: root.replace(/[\\/]$/, ''),
    HOMEPATH: temporaryHome.slice(Math.max(0, root.length - 1)),
  };
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readUserDirectoryNames(...paths: string[]): string[] {
  const usernames = new Set<string>();
  for (const candidate of paths) {
    for (const match of candidate.matchAll(/(?:^|[\\/])(?:Users|home)[\\/]([^\\/]+)/gi)) {
      if (match[1]) {
        usernames.add(match[1]);
      }
    }
  }
  return [...usernames];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectInOrder(content: string, sections: readonly string[]): void {
  let previousIndex = -1;
  for (const section of sections) {
    const currentIndex = content.indexOf(section, previousIndex + 1);
    expect(currentIndex, `正文缺少或顺序错误：${section.trim()}`).toBeGreaterThan(previousIndex);
    previousIndex = currentIndex;
  }
}

function readTableValue(content: string, field: string): string | null {
  const prefix = `| ${field} | `;
  const row = content.split(/\r\n|\n|\r/).find((line) => line.startsWith(prefix));
  return row?.endsWith(' |') ? row.slice(prefix.length, -2).trim() : null;
}

function expectNonNullTableValue(content: string, field: string): void {
  const value = readTableValue(content, field);
  expect(value, `环境字段不可为空：${field}`).not.toBeNull();
  expect(value, `环境字段不可为 null：${field}`).not.toBe('null');
  expect(value, `环境字段不可为空字符串：${field}`).not.toBe('');
}

function diagnosticCodeBlockByteLength(content: string): number {
  const diagnosticsStart = content.indexOf('## Diagnostics');
  if (diagnosticsStart < 0) {
    return 0;
  }
  const footerStart = content.indexOf('\n\n---\n\n', diagnosticsStart);
  const diagnostics = content.slice(diagnosticsStart, footerStart < 0 ? content.length : footerStart);
  const lines = diagnostics.split(/\r\n|\n|\r/);
  let total = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^(`{3,})(?:json|text)$/);
    if (!opening) {
      continue;
    }
    const fence = opening[1];
    const closingIndex = lines.indexOf(fence, index + 1);
    if (closingIndex < 0) {
      throw new Error(`诊断代码块缺少闭合 fence：${fence}`);
    }
    total += new TextEncoder().encode(lines.slice(index + 1, closingIndex).join('\n')).byteLength;
    index = closingIndex;
  }
  return total;
}

function readDetailsText(content: string, summary: string): string {
  const summaryMarker = `<summary>${summary}</summary>`;
  const summaryIndex = content.indexOf(summaryMarker);
  if (summaryIndex < 0) {
    throw new Error(`正文缺少折叠日志：${summary}`);
  }
  const remainder = content.slice(summaryIndex + summaryMarker.length);
  const opening = remainder.match(/^\n\n(`{3,})text\n/);
  if (!opening) {
    throw new Error(`折叠日志缺少 text 代码块：${summary}`);
  }
  const closingMarker = `\n${opening[1]}\n</details>`;
  const closingIndex = remainder.indexOf(closingMarker, opening[0].length);
  if (closingIndex < 0) {
    throw new Error(`折叠日志缺少闭合标记：${summary}`);
  }
  return remainder.slice(opening[0].length, closingIndex);
}

function hasForbiddenPublicField(content: string): boolean {
  return [
    '| Email |',
    '| User ID |',
    '| User Agent |',
    '| Project Name |',
    '| Project Path |',
    '| File Name |',
    '| Serial Number |',
    '| PNP ID |',
    '| Local Library Path |',
    '| Source Code |',
    '| Blockly Workspace |',
  ].some((field) => content.includes(field));
}
