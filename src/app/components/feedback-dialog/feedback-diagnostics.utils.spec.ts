import {
  FEEDBACK_CRASH_CONTEXT_MAX_BYTES,
  FEEDBACK_DIAGNOSTICS_MAX_BYTES,
  FEEDBACK_TRUNCATION_MARKER,
  enforceDiagnosticTextBudget,
  extractLatestCrashDiagnostic,
  resolveAccountStatusCode,
  sanitizeDiagnosticText,
  selectRecentDiagnosticLogs,
  truncateUtf8Tail,
  utf8ByteLength,
} from './feedback-diagnostics.utils';

describe('feedback diagnostics utilities', () => {
  describe('resolveAccountStatusCode', () => {
    it('does not report the initial false authentication value as signed out', () => {
      expect(resolveAccountStatusCode('idle', false, null)).toBeNull();
      expect(resolveAccountStatusCode('checking', false, null)).toBeNull();
      expect(resolveAccountStatusCode('unavailable', false, null)).toBeNull();
      expect(resolveAccountStatusCode('authenticated', false, 'free')).toBeNull();
    });

    it('maps signed-out, free, pro, and unknown authenticated plans', () => {
      expect(resolveAccountStatusCode('signed_out', false, null)).toBe('000');
      expect(resolveAccountStatusCode('authenticated', true, ' Free ')).toBe('110');
      expect(resolveAccountStatusCode('authenticated', true, 'PRO Annual')).toBe('101');
      expect(resolveAccountStatusCode('authenticated', true, undefined)).toBe('100');
    });
  });

  describe('selectRecentDiagnosticLogs', () => {
    const now = Date.parse('2026-09-02T08:00:00.000Z');

    it('selects only the newest ten matching errors from the last thirty minutes', () => {
      const logs = Array.from({ length: 13 }, (_, index) => ({
        title: `error-${index}`,
        detail: `detail-${index}`,
        state: 'error',
        timestamp: now - (index * 60_000),
      }));
      logs.push({
        title: 'old-error',
        detail: 'outside-window',
        state: 'error',
        timestamp: now - (31 * 60_000),
      });

      const result = selectRecentDiagnosticLogs(logs, {
        now,
        withinMs: 30 * 60_000,
        limit: 10,
        state: 'error',
      });

      expect(result.content?.split('\n').length).toBe(10);
      expect(result.content).toContain('error-0');
      expect(result.content).toContain('error-9');
      expect(result.content).not.toContain('error-10');
      expect(result.content).not.toContain('old-error');
      expect(result.latestTimestamp).toBe(now);
    });

    it('distinguishes an unavailable list from a confirmed empty selection', () => {
      expect(selectRecentDiagnosticLogs(null, { now, withinMs: 1, limit: 1 }).content).toBeNull();
      expect(selectRecentDiagnosticLogs([], { now, withinMs: 1, limit: 1 }).content).toBe('none');
    });

    it('can select related operation logs by library name', () => {
      const result = selectRecentDiagnosticLogs([
        { detail: 'Installed @aily-project/lib-led', state: 'done', timestamp: now },
        { detail: 'Unrelated operation', state: 'error', timestamp: now },
      ], {
        now,
        withinMs: 30 * 60_000,
        limit: 10,
        query: '@aily-project/lib-led',
      });

      expect(result.content).toContain('lib-led');
      expect(result.content).not.toContain('Unrelated');
    });
  });

  describe('sanitizeDiagnosticText', () => {
    it('redacts credentials and identity while preserving diagnostic paths and file names', () => {
      const result = sanitizeDiagnosticText([
        '\u001b[31mAuthorization: Bearer token-value\u001b[0m',
        'Cookie=session-value',
        'api_key=key-value',
        'token=standalone-token',
        'password=alpha beta',
        'accessToken=alpha,beta',
        'apiKey=alpha;beta',
        'API Key: sk-fake-private-123',
        'userAgent=feedback-e2e-private-user-agent',
        'Serial number: DEVICE-SECRET-123',
        'serial_number=DEVICE-SECRET-456',
        'PNP ID: USB\\VID_1234&PID_5678\\PRIVATE-ID',
        'pnp_id=PRIVATE-PNP-ID',
        'Probe Serial: PRIVATE-PROBE-SERIAL',
        'Ocp-Apim-Subscription-Key: private-subscription-key',
        'AWS_ACCESS_KEY_ID=private-aws-access-key-id',
        'AWS_SECRET_ACCESS_KEY=private-aws-secret-access-key',
        '{"accessKeyId":"private-json-access-key-id"}',
        '{"secretAccessKey":"private-json-secret-access-key"}',
        '{"privateKey":"private-json-private-key"}',
        'PRIVATE KEY: private-human-private-key',
        'AccountKey=private-account-key',
        'secretKey=private-secret-key',
        'email=private-local-email@localhost',
        'contact=13800138000',
        'username=private-login-name',
        'loginName=private-login-name-two',
        'accountName=private-account-name',
        'serial=PRIVATE-SERIAL-ONE',
        'serial_no=PRIVATE-SERIAL-TWO',
        'user=private-user-alias',
        'account: private-account-alias',
        'uid=private-uid-alias',
        'GITHUB_TOKEN=ghp_private-github-token',
        'NPM_TOKEN=private-npm-token',
        'OPENAI_API_KEY=private-openai-key',
        'AZURE_OPENAI_API_KEY=private-azure-openai-key',
        'MY_PASSWORD=private-prefixed-password',
        'AUTH_TOKEN=private-auth-token',
        'customApiKey=private-custom-api-key',
        'githubToken=private-github-token',
        'wifiPassword=private-wifi-password',
        'databasePassword=private-database-password',
        'https://private-user:private-password@example.invalid/resource',
        'mongodb://PRIVATE_DB_USER:PRIVATE_DB_PASS@localhost/private-db',
        'postgres://PRIVATE_SQL_USER:PRIVATE_SQL_PASS@localhost/private-db',
        'mqtt://PRIVATE_MQTT_USER:PRIVATE_MQTT_PASS@localhost/private-topic',
        'ftp://PRIVATE_FTP_USER:PRIVATE_FTP_PASS@localhost/private-file',
        'https://PRIVATE_URL_TOKEN@localhost/private-repo',
        'https://example.invalid/path?token=query-secret&safe=yes',
        'https://example.invalid/path?key=fake-google-api-key&safe=yes',
        'https://example.invalid/path?X-Amz-Signature=private-aws-signature&safe=yes',
        'urls=file:///home/alice/app/renderer/index.html file:///C:/Users/alice/app/index.html file://server/share/user/private.txt',
        'url="file:///C:/Users/alice/private,project;name/index.html"',
        JSON.stringify({ url: 'file:///home/alice/private"project/index.html' }),
        'email=user@example.com',
        'user_id=account-42',
        'phoneNumber="13800138000"',
        'avatarUrl=https://example.invalid/private-avatar.png',
        'projectName=private-project',
        'projectPath=private,project/src/main.html',
        '{"projectName":"Private Customer Project"}',
        '{"projectPath":"projects/Private Customer Project"}',
        '{"conversationFilePath":"conversations/private-customer-chat.data"}',
        '{"localLibraryPath":"libraries/private-client-lib"}',
        '{"cloudId":"customer-cloud-id"}',
        'C:\\Users\\alice\\private-project\\secret-folder\\main.cpp:12:4: error',
        '/home/alice/private-project/source.py',
        '/workspace/alice/My Project/source with spaces.cpp: secret path suffix',
        'fatal: customer-secret-config.json could not be read',
        'src/private-customer/secret-module.S:19: error',
        'Compiling src/customer-secret-feature.o',
        'Linking private-client-firmware.exe',
        'Loaded tenant-alpha.lock',
        'Loaded My Secret File.json',
        '编译 客户机密配置.json 失败',
        '私密项目/src/客户算法.cpp:5: error',
        'Error: Cannot find module ./private-customer-lib',
        'make: Entering directory private-customer-module/src',
        'cwd=private-customer-module/build',
        'local library path -> ../private-client-library',
        'dependency=file:../private-client-library-two',
        'resolved link:./private-customer-lib-two',
        'source=file:..\\private-windows-lib',
        '[2026-09-02 10:01:00.000] [DEBUG] [upload] Writing private-firmware.bin',
        'Using src/CustomerProject/main.c',
        'undefined reference in build/customer.o',
        'main.c: fatal error',
        'secrets.json missing',
        'Opening ~/SecretProject/Makefile',
        'Using src/CustomerProject/Makefile',
      ].join('\n'), ['C:\\Users\\alice\\private-project']);

      expect(result).not.toContain('token-value');
      expect(result).not.toContain('session-value');
      expect(result).not.toContain('key-value');
      expect(result).not.toContain('standalone-token');
      expect(result).not.toContain('alpha beta');
      expect(result).not.toContain('alpha,beta');
      expect(result).not.toContain('alpha;beta');
      expect(result).not.toContain('sk-fake-private-123');
      expect(result).not.toContain('feedback-e2e-private-user-agent');
      expect(result).not.toContain('DEVICE-SECRET');
      expect(result).not.toContain('PRIVATE-ID');
      expect(result).not.toContain('PRIVATE-PNP-ID');
      expect(result).not.toContain('PRIVATE-PROBE-SERIAL');
      expect(result).not.toContain('private-subscription-key');
      expect(result).not.toContain('private-aws-access-key-id');
      expect(result).not.toContain('private-aws-secret-access-key');
      expect(result).not.toContain('private-json-access-key-id');
      expect(result).not.toContain('private-json-secret-access-key');
      expect(result).not.toContain('private-json-private-key');
      expect(result).not.toContain('private-human-private-key');
      expect(result).not.toContain('private-account-key');
      expect(result).not.toContain('private-secret-key');
      expect(result).not.toContain('private-local-email');
      expect(result).not.toContain('13800138000');
      expect(result).not.toContain('private-login-name');
      expect(result).not.toContain('private-login-name-two');
      expect(result).not.toContain('private-account-name');
      expect(result).not.toContain('PRIVATE-SERIAL-ONE');
      expect(result).not.toContain('PRIVATE-SERIAL-TWO');
      expect(result).not.toContain('private-user-alias');
      expect(result).not.toContain('private-account-alias');
      expect(result).not.toContain('private-uid-alias');
      expect(result).not.toContain('ghp_private-github-token');
      expect(result).not.toContain('private-npm-token');
      expect(result).not.toContain('private-openai-key');
      expect(result).not.toContain('private-azure-openai-key');
      expect(result).not.toContain('private-prefixed-password');
      expect(result).not.toContain('private-auth-token');
      expect(result).not.toContain('private-custom-api-key');
      expect(result).not.toContain('private-github-token');
      expect(result).not.toContain('private-wifi-password');
      expect(result).not.toContain('private-database-password');
      expect(result).not.toContain('private-password');
      expect(result).not.toContain('PRIVATE_DB_USER');
      expect(result).not.toContain('PRIVATE_DB_PASS');
      expect(result).not.toContain('PRIVATE_SQL_USER');
      expect(result).not.toContain('PRIVATE_SQL_PASS');
      expect(result).not.toContain('PRIVATE_MQTT_USER');
      expect(result).not.toContain('PRIVATE_MQTT_PASS');
      expect(result).not.toContain('PRIVATE_FTP_USER');
      expect(result).not.toContain('PRIVATE_FTP_PASS');
      expect(result).not.toContain('PRIVATE_URL_TOKEN');
      expect(result).not.toContain('query-secret');
      expect(result).not.toContain('fake-google-api-key');
      expect(result).not.toContain('private-aws-signature');
      expect(result).not.toContain('user@example.com');
      expect(result).not.toContain('account-42');
      expect(result).not.toContain('13800138000');
      expect(result).not.toContain('private-avatar');
      expect(result).not.toContain('customer-cloud-id');
      expect(result).not.toContain('/home/alice/');
      expect(result).not.toContain('/Users/alice/');
      expect(result).not.toContain('\\Users\\alice\\');
      expect(result).toContain('/workspace/alice/My Project/source with spaces.cpp: secret path suffix');
      expect(result).toContain('file:///home/[USER]/app/renderer/index.html');
      expect(result).toContain('file:///C:/Users/[USER]/app/index.html');
      expect(result).toContain('file://server/share/user/private.txt');
      expect(result).toContain('projectPath=private,project/src/main.html');
      expect(result).toContain('conversations/private-customer-chat.data');
      expect(result).toContain('libraries/private-client-lib');
      expect(result).toContain('C:\\Users\\[USER]\\private-project\\secret-folder\\main.cpp:12:4: error');
      expect(result).toContain('/home/[USER]/private-project/source.py');
      expect(result).toContain('fatal: customer-secret-config.json could not be read');
      expect(result).toContain('src/private-customer/secret-module.S:19: error');
      expect(result).toContain('Compiling src/customer-secret-feature.o');
      expect(result).toContain('Linking private-client-firmware.exe');
      expect(result).toContain('Loaded tenant-alpha.lock');
      expect(result).toContain('Loaded My Secret File.json');
      expect(result).toContain('编译 客户机密配置.json 失败');
      expect(result).toContain('私密项目/src/客户算法.cpp:5: error');
      expect(result).toContain('Error: Cannot find module ./private-customer-lib');
      expect(result).toContain('make: Entering directory private-customer-module/src');
      expect(result).toContain('cwd=private-customer-module/build');
      expect(result).toContain('local library path -> ../private-client-library');
      expect(result).toContain('dependency=file:../private-client-library-two');
      expect(result).toContain('resolved link:./private-customer-lib-two');
      expect(result).toContain('source=file:..\\private-windows-lib');
      expect(result).toContain('[2026-09-02 10:01:00.000] [DEBUG] [upload] Writing private-firmware.bin');
      expect(result).toContain('Using src/CustomerProject/main.c');
      expect(result).toContain('undefined reference in build/customer.o');
      expect(result).toContain('main.c: fatal error');
      expect(result).toContain('secrets.json missing');
      expect(result).toContain('Opening ~/SecretProject/Makefile');
      expect(result).toContain('Using src/CustomerProject/Makefile');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('[USER]');
      expect(result).not.toContain('[PATH]');
      expect(result).not.toContain('[FILE]');
    });

    it('keeps the complete partitions.csv error when no username appears in its path', () => {
      const diagnostic = '[2026-09-02 23:05:37.409] [ERROR] [compile] '
        + '选择了自定义分区方案，但未找到 partitions.csv 分区文件。'
        + '请将文件保存到 D:\\ailyblockly\\AI-VOX3yuyinkongzhiLED_357163\\src\\partitions.csv';

      expect(sanitizeDiagnosticText(diagnostic)).toBe(diagnostic);
    });

    it('masks only explicit user-home path segments and keeps every other path and file name', () => {
      const input = [
        'C:\\Users\\alice\\private-project\\src\\partitions.csv',
        'C:/Users/alice/private-project/src/main.cpp',
        '/home/alice/private-project/source.py',
        '/Users/Alice Smith/My Project/config.json',
        'file:///home/alice/app/renderer/index.html',
        JSON.stringify({ projectPath: 'C:\\Users\\alice\\Json Project\\main.ts' }),
        '/workspace/alice/My Project/source with spaces.cpp',
        '~alice/project/main.cpp',
        '~/project/main.cpp',
        'D:\\ailyblockly\\project\\src\\partitions.csv',
        '..\\private-client-library\\library.json',
        '\\\\server\\share\\user\\private.txt',
      ].join('\n');
      const expected = [
        'C:\\Users\\[USER]\\private-project\\src\\partitions.csv',
        'C:/Users/[USER]/private-project/src/main.cpp',
        '/home/[USER]/private-project/source.py',
        '/Users/[USER]/My Project/config.json',
        'file:///home/[USER]/app/renderer/index.html',
        JSON.stringify({ projectPath: 'C:\\Users\\[USER]\\Json Project\\main.ts' }),
        '/workspace/alice/My Project/source with spaces.cpp',
        '~[USER]/project/main.cpp',
        '~/project/main.cpp',
        'D:\\ailyblockly\\project\\src\\partitions.csv',
        '..\\private-client-library\\library.json',
        '\\\\server\\share\\user\\private.txt',
      ].join('\n');

      const sanitized = sanitizeDiagnosticText(input, ['C:\\Users\\alice\\private-project']);

      expect(sanitized).toBe(expected);
      expect(sanitizeDiagnosticText(sanitized, ['C:\\Users\\alice\\private-project'])).toBe(expected);
    });

    it('does not treat matching ordinary directory names as user-home paths', () => {
      const input = [
        'build succeeded',
        'root cause identified',
        'build/src/main.cpp',
        '/tmp/root/log.txt',
        '/home/alice: permission denied',
        '/home/alice, next candidate',
        '/workspace/Alice Smith/project/main.cpp',
        'file:///workspace/Alice%20Smith/project/main.cpp',
      ].join('\n');

      expect(sanitizeDiagnosticText(input, [
        'C:\\Users\\build\\project',
        '/home/root/project',
        'C:\\Users\\Alice Smith',
      ])).toBe([
        'build succeeded',
        'root cause identified',
        'build/src/main.cpp',
        '/tmp/root/log.txt',
        '/home/[USER]: permission denied',
        '/home/[USER], next candidate',
        '/workspace/Alice Smith/project/main.cpp',
        'file:///workspace/Alice%20Smith/project/main.cpp',
      ].join('\n'));
    });

    it('masks an exact custom user home before URL, JSON, and markup delimiters', () => {
      const result = sanitizeDiagnosticText([
        'path=/workspace/alice?mode=debug',
        'path=<C:\\Users\\alice>',
        'path=/workspace/alice} next',
        'path=/workspace/alice|next',
      ].join('\n'), [], undefined, '/workspace/alice');

      expect(result).toBe([
        'path=/workspace/[USER]?mode=debug',
        'path=<C:\\Users\\[USER]>',
        'path=/workspace/[USER]} next',
        'path=/workspace/[USER]|next',
      ].join('\n'));
    });

    it('masks a username serialized as consecutive JSON Unicode escapes', () => {
      const nestedWindowsPath = JSON.stringify(
        String.raw`{"path":"C:\\Users\\\u5f20\u4e09\\main.cpp"}`,
      );
      const nestedPosixPath = JSON.stringify(
        String.raw`{"path":"/home/\u5f20\u4e09/project"}`,
      );
      const input = [
        String.raw`{"path":"C:\\Users\\\u5f20\u4e09\\main.cpp"}`,
        String.raw`{"path":"C:/Users/\u5f20\u4e09/main.cpp"}`,
        String.raw`{"path":"/home/\u5f20\u4e09/main.cpp"}`,
        String.raw`{"path":"/Users/\u5f20\u4e09/main.cpp"}`,
        String.raw`{"path":"file:///home/\u5f20\u4e09/main.cpp"}`,
        String.raw`{"path":"C:\\Users\\\u5f20\u4e09"}`,
        String.raw`{"path":"C:/Users/\u5f20\u4e09"}`,
        String.raw`{"path":"/home/\u5f20\u4e09"}`,
        String.raw`{"path":"/Users/\u5f20\u4e09"}`,
        String.raw`{"path":"file:///home/\u5f20\u4e09"}`,
        nestedWindowsPath,
        nestedPosixPath,
      ].join('\n');
      const expected = [
        String.raw`{"path":"C:\\Users\\[USER]\\main.cpp"}`,
        String.raw`{"path":"C:/Users/[USER]/main.cpp"}`,
        String.raw`{"path":"/home/[USER]/main.cpp"}`,
        String.raw`{"path":"/Users/[USER]/main.cpp"}`,
        String.raw`{"path":"file:///home/[USER]/main.cpp"}`,
        String.raw`{"path":"C:\\Users\\[USER]"}`,
        String.raw`{"path":"C:/Users/[USER]"}`,
        String.raw`{"path":"/home/[USER]"}`,
        String.raw`{"path":"/Users/[USER]"}`,
        String.raw`{"path":"file:///home/[USER]"}`,
        JSON.stringify(String.raw`{"path":"C:\\Users\\[USER]\\main.cpp"}`),
        JSON.stringify(String.raw`{"path":"/home/[USER]/project"}`),
      ].join('\n');

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('masks an exact custom user home through nested JSON escaping', () => {
      const wrapJson = (value: string, layers: number): string => {
        let wrapped = value;
        for (let index = 0; index < layers; index += 1) {
          wrapped = JSON.stringify(wrapped);
        }
        return wrapped;
      };
      const username = 'Alice张😀';
      const posixPath = String.raw`{"path":"D:/workspace/Alice\u5f20\ud83d\ude00/project","id":9007199254740993}`;
      const redactedPosixPath = '{"path":"D:/workspace/[USER]/project","id":9007199254740993}';
      const windowsPath = String.raw`{"path":"D:\\workspace\\Alice\u5f20\ud83d\ude00\\project"}`;
      const redactedWindowsPath = String.raw`{"path":"D:\\workspace\\[USER]\\project"}`;
      const input = [
        posixPath,
        windowsPath,
        wrapJson(posixPath, 1),
        wrapJson(windowsPath, 3),
        `[2026-09-02] [ERROR] [compile] ${posixPath}`,
        `payload=${wrapJson(posixPath, 1)}`,
        `details: ${posixPath}`,
        `context: ${wrapJson(posixPath, 1)}`,
        `message: ${posixPath}`,
        `[2026-09-02] [ERROR] Error details: ${posixPath}`,
        `[2026-09-02] [ERROR] [ProcessHealth][RendererGone] ${posixPath}`,
        `details: ${posixPath} trailing text`,
        `first=${posixPath}; second=${windowsPath} trailing text`,
        `prefix { invalid ${posixPath} trailing text`,
        `prefix { invalid ${posixPath} } trailing text`,
        `prefix "unterminated ${posixPath} trailing text`,
        String.raw`"D:/workspace/Alice\u5f20\ud83d\ude00/one"D:/workspace/Alice\u5f20\ud83d\ude00/two"`,
      ].join('\n');
      const expected = [
        redactedPosixPath,
        redactedWindowsPath,
        wrapJson(redactedPosixPath, 1),
        wrapJson(redactedWindowsPath, 3),
        `[2026-09-02] [ERROR] [compile] ${redactedPosixPath}`,
        `payload=${wrapJson(redactedPosixPath, 1)}`,
        `details: ${redactedPosixPath}`,
        `context: ${wrapJson(redactedPosixPath, 1)}`,
        `message: ${redactedPosixPath}`,
        `[2026-09-02] [ERROR] Error details: ${redactedPosixPath}`,
        `[2026-09-02] [ERROR] [ProcessHealth][RendererGone] ${redactedPosixPath}`,
        `details: ${redactedPosixPath} trailing text`,
        `first=${redactedPosixPath}; second=${redactedWindowsPath} trailing text`,
        `prefix { invalid ${redactedPosixPath} trailing text`,
        `prefix { invalid ${redactedPosixPath} } trailing text`,
        `prefix "unterminated ${redactedPosixPath} trailing text`,
        '"D:/workspace/[USER]/one"D:/workspace/[USER]/two"',
      ].join('\n');

      const userHome = `D:\\workspace\\${username}`;
      const sanitized = sanitizeDiagnosticText(input, [], undefined, userHome);

      expect(sanitized).toBe(expected);
      expect(sanitizeDiagnosticText(sanitized, [], undefined, userHome)).toBe(expected);
    });

    it('masks URL-encoded NFC and NFD forms of an exact custom user home', () => {
      const nfcHome = '/workspace/é';
      const nfdHome = `/workspace/${'é'.normalize('NFD')}`;

      expect(sanitizeDiagnosticText(
        'file:///workspace/e%CC%81/main.cpp',
        [],
        undefined,
        nfcHome,
      )).toBe('file:///workspace/[USER]/main.cpp');
      expect(sanitizeDiagnosticText(
        'file:///workspace/%C3%A9/main.cpp',
        [],
        undefined,
        nfdHome,
      )).toBe('file:///workspace/[USER]/main.cpp');
      expect(sanitizeDiagnosticText(
        'file:///workspace/%c3%a9/main.cpp',
        [],
        undefined,
        nfcHome,
      )).toBe('file:///workspace/[USER]/main.cpp');
    });

    it('uses a conventional path hint to mask a terminal home with spaces', () => {
      expect(sanitizeDiagnosticText(
        'cwd=C:\\Users\\Alice Smith\npath=/home/Alice Smith',
        [
          'C:\\Users\\Alice Smith\\AppData\\Local\\aily-project',
          '/home/Alice Smith/.config/aily-project',
        ],
      )).toBe('cwd=C:\\Users\\[USER]\npath=/home/[USER]');
    });

    it('matches an encoded custom-home parent without treating similar paths as that home', () => {
      expect(sanitizeDiagnosticText(
        'file:///srv/My%20Profiles/e%CC%81/main.cpp',
        [],
        undefined,
        '/srv/My Profiles/é',
      )).toBe('file:///srv/My%20Profiles/[USER]/main.cpp');

      const input = [
        '/workspace/alice/project/main.cpp',
        '/tmp/workspace/alice/project/main.cpp',
        'https://example.invalid/workspace/alice/project/main.cpp',
        '/Workspace/alice/project/main.cpp',
      ].join('\n');

      expect(sanitizeDiagnosticText(input, [], undefined, '/workspace/alice')).toBe([
        '/workspace/[USER]/project/main.cpp',
        '/tmp/workspace/alice/project/main.cpp',
        'https://example.invalid/workspace/alice/project/main.cpp',
        '/Workspace/alice/project/main.cpp',
      ].join('\n'));
      expect(sanitizeDiagnosticText(
        'prefixD:\\Profiles\\Alice\\project path=D:\\Profiles\\Alice\\project',
        [],
        undefined,
        'D:\\Profiles\\Alice',
      )).toBe('prefixD:\\Profiles\\Alice\\project path=D:\\Profiles\\[USER]\\project');
    });

    it('omits an oversized single line before scanning JSON string fragments', () => {
      const oversizedLine = `prefix ${'"noise"'.repeat(20_000)} `
        + String.raw`{"path":"/workspace/Alice\u5f20\ud83d\ude00/project"}`;

      expect(sanitizeDiagnosticText(oversizedLine, ['C:\\Users\\Alice张😀']))
        .toBe(FEEDBACK_TRUNCATION_MARKER);
    });

    it('bounds total JSON scanning while retaining the newest complete compile error', () => {
      const diagnostic = '[2026-09-02 23:05:37.409] [ERROR] [compile] '
        + '选择了自定义分区方案，但未找到 partitions.csv 分区文件。'
        + '请将文件保存到 D:\\ailyblockly\\AI-VOX3yuyinkongzhiLED_357163\\src\\partitions.csv';
      const olderLine = `prefix ${'"noise"'.repeat(20_000)}`;

      const result = sanitizeDiagnosticText(
        [olderLine, olderLine, diagnostic].join('\n'),
        ['C:\\Users\\alice'],
        FEEDBACK_DIAGNOSTICS_MAX_BYTES,
      );

      expect(result).toContain(FEEDBACK_TRUNCATION_MARKER);
      expect(result).toContain(diagnostic);
      expect(result).not.toContain(olderLine);
    });

    it('redacts a sensitive JSON container before applying the scan-output budget', () => {
      const input = JSON.stringify({
        tokens: Array.from({ length: 8_000 }, (_, index) => `TOP-SECRET-${index}`),
        path: 'D:\\ailyblockly\\project\\src\\partitions.csv',
        error: 'compile failed',
      }, null, 2);

      const result = sanitizeDiagnosticText(input);

      expect(result).not.toContain('TOP-SECRET');
      expect(result).toContain('D:\\\\ailyblockly\\\\project\\\\src\\\\partitions.csv');
      expect(result).toContain('compile failed');
    });

    it('fails closed above the scan budget even when a sensitive key uses Unicode escapes', () => {
      const input = JSON.stringify({
        token: Array.from({ length: 55_000 }, (_, index) => `ULTRA-SECRET-${index}`),
        path: 'D:\\repo\\src\\partitions.csv',
      }, null, 2).replace('"token"', String.raw`"\u0074\u006f\u006b\u0065\u006e"`);

      expect(utf8ByteLength(input)).toBeGreaterThan(1024 * 1024);
      expect(sanitizeDiagnosticText(input)).toBe(FEEDBACK_TRUNCATION_MARKER);
    });

    it('removes a clearly structured compiler source excerpt', () => {
      const result = sanitizeDiagnosticText([
        '[2026-09-02 10:00:00.000] [ERROR] [compile] C:\\work\\main.cpp:3:2: error: invalid value',
        '[2026-09-02 10:00:00.000] [ERROR] [compile] 3 | secret_source();',
        '[2026-09-02 10:00:00.000] [ERROR] [compile]   | ^~~~~~~~~~~~~',
        '[2026-09-02 10:00:00.000] [ERROR] [compile] compilation failed',
      ].join('\n'));

      expect(result).not.toContain('secret_source');
      expect(result).not.toContain('^~~~~~~~~~~~~');
      expect(result).toContain('C:\\work\\main.cpp:3:2: error: invalid value');
      expect(result).toContain('invalid value');
      expect(result).toContain('compilation failed');
    });

    it('uses path hints only to mask known username segments', () => {
      const result = sanitizeDiagnosticText([
        'My Private Project/src/customer.cpp:5: error: invalid value',
        'C:\\Users\\alice\\My Private Project\\secret-client\\main.cpp:5: error',
        '/home/alice/My Private Project/customer-secret-module/src/main.cpp:5: error',
      ].join('\n'), [
        'My Private Project',
        'C:\\Users\\alice\\My Private Project',
        '/home/alice/My Private Project',
      ]);

      expect(result).toBe([
        'My Private Project/src/customer.cpp:5: error: invalid value',
        'C:\\Users\\[USER]\\My Private Project\\secret-client\\main.cpp:5: error',
        '/home/[USER]/My Private Project/customer-secret-module/src/main.cpp:5: error',
      ].join('\n'));
    });

    it('removes source excerpts from two-prefix app log lines', () => {
      const result = sanitizeDiagnosticText([
        '[2026-09-02 10:00:00.000] [error] /workspace/private/main.cpp:3:2: error: invalid value',
        '[2026-09-02 10:00:00.000] [error] 3 | app_log_secret_source();',
        '[2026-09-02 10:00:00.000] [error]   | ^~~~~~~~~~~~~~~~~~~~~~~',
        '[2026-09-02 10:00:00.000] [error] compilation failed',
      ].join('\n'));

      expect(result).not.toContain('app_log_secret_source');
      expect(result).not.toContain('^~~~~~~~~~~~~~~~~~~~~~~');
      expect(result).toContain('/workspace/private/main.cpp:3:2: error: invalid value');
      expect(result).toContain('compilation failed');
    });

    it('keeps dotted identifiers and host names that are not file names', () => {
      const result = sanitizeDiagnosticText([
        'TypeError: Object.entries is not a function',
        'Connection to api.example.com failed',
        'TypeError: items.map is not a function',
        'response.data is undefined',
        'console.log failed',
      ].join('\n'));

      expect(result).toContain('Object.entries');
      expect(result).toContain('api.example.com');
      expect(result).toContain('items.map');
      expect(result).toContain('response.data');
      expect(result).toContain('console.log');
    });

    it('removes a Python traceback source line while retaining its exception summary', () => {
      const result = sanitizeDiagnosticText([
        'Traceback (most recent call last):',
        '  File "C:\\Users\\alice\\private-project\\main.py", line 5, in <module>',
        '    print(private_source_value)',
        'ValueError: invalid value',
      ].join('\n'));

      expect(result).not.toContain('private_source_value');
      expect(result).not.toContain('Users\\alice');
      expect(result).toContain('File "C:\\Users\\[USER]\\private-project\\main.py", line 5');
      expect(result).toContain('ValueError: invalid value');
    });

    it('omits a prefixed Python traceback whose source indentation was lost by logging', () => {
      const result = sanitizeDiagnosticText([
        '[2026-09-02 10:00:00.000] [ERROR] [compile] Traceback (most recent call last):',
        '[2026-09-02 10:00:00.000] [ERROR] [compile] File "C:\\Users\\alice\\private-project\\main.py", line 5, in <module>',
        '[2026-09-02 10:00:00.000] [ERROR] [compile] print(private_source_value)',
        '[2026-09-02 10:00:00.000] [ERROR] [compile] ValueError: invalid value',
      ].join('\n'));

      expect(result).toBeNull();
    });

    it('omits a block containing a serialized Blockly workspace', () => {
      expect(sanitizeDiagnosticText('<xml><block type="controls_if"></block></xml>')).toBeNull();
      expect(sanitizeDiagnosticText('{"blocks":[{"type":"logic_boolean"}]}')).toBeNull();
      expect(sanitizeDiagnosticText('{"blocks":{"languageVersion":0,"blocks":[{"type":"logic_boolean"}]}}')).toBeNull();
      expect(sanitizeDiagnosticText('<xml><variables><variable>privateWifiPassword</variable></variables></xml>')).toBeNull();
      expect(sanitizeDiagnosticText('{"blocks":[]}')).toBeNull();
      expect(sanitizeDiagnosticText("workspace={ blocks: { languageVersion: 0, blocks: [{ type: 'secretBlock' }] } }")).toBeNull();
      expect(sanitizeDiagnosticText('{"workspaceXml":"<xml><block type=\\"controls_if\\"></block></xml>"}')).toBeNull();
      expect(sanitizeDiagnosticText(String.raw`payload="{\"blocks\":[{\"type\":\"logic_boolean\"}]}"`)).toBeNull();
      expect(sanitizeDiagnosticText(String.raw`payload="{\\\"blocks\\\":[{\\\"type\\\":\\\"logic_boolean\\\"}]}"`)).toBeNull();
    });

    it('omits a block containing an explicit source payload field', () => {
      expect(sanitizeDiagnosticText('lastBuildCode:\nsecret_source();')).toBeNull();
      expect(sanitizeDiagnosticText('{"lastBuildCode":"secret_source();"}')).toBeNull();
      expect(sanitizeDiagnosticText('{"sourceCode":"secret_source();"}')).toBeNull();
      expect(sanitizeDiagnosticText('{"generatedCode":"secret_source();"}')).toBeNull();
      expect(sanitizeDiagnosticText(String.raw`payload="{\"sourceCode\":\"secret_source();\"}"`)).toBeNull();
      expect(sanitizeDiagnosticText(String.raw`payload="{\\\"generatedCode\\\":\\\"secret_source();\\\"}"`)).toBeNull();
    });

    it('redacts credentials inside escaped nested JSON strings', () => {
      const result = sanitizeDiagnosticText([
        String.raw`payload="{\"token\":\"nested-secret\"}"`,
        String.raw`payload="{\\\"password\\\":\\\"deep-secret\\\"}"`,
      ].join('\n'));

      expect(result).not.toContain('nested-secret');
      expect(result).not.toContain('deep-secret');
      expect(result).toContain('[REDACTED]');
    });

    it('redacts only sensitive JSON values and preserves later diagnostic fields byte-for-byte', () => {
      const input = String.raw`{"token":"secret,with\"quote\\slash","path":"D:\\repo\\src\\partitions.csv","error":"compile failed","buildId":9007199254740993}`;
      const expected = String.raw`{"token":"[REDACTED]","path":"D:\\repo\\src\\partitions.csv","error":"compile failed","buildId":9007199254740993}`;

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('redacts multiple scalar and structured JSON identity values without swallowing safe fields', () => {
      const input = String.raw`prefix {"credential":{"token":"inner-secret"},"serial":12345,"path":"D:\\repo\\main.cpp","error":"link failed"} suffix`;
      const expected = String.raw`prefix {"credential":"[REDACTED]","serial":"[REDACTED]","path":"D:\\repo\\main.cpp","error":"link failed"} suffix`;

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('redacts plural sensitive containers and multiline JSON values as a single field', () => {
      const input = [
        '{',
        '  "credentials": {',
        '    "token": "TOP-SECRET",',
        '    "values": ["ALSO-SECRET"]',
        '  },',
        '  "tokens": ["TOKEN-ONE", "TOKEN-TWO"],',
        '  "secrets": {"build": "SECRET-THREE"},',
        '  "cookies": ["COOKIE-FOUR"],',
        '  "path": "D:\\\\repo\\\\src\\\\partitions.csv",',
        '  "error": "compile failed",',
        '  "buildId": 9007199254740993',
        '}',
      ].join('\n');
      const expected = [
        '{',
        '  "credentials": "[REDACTED]",',
        '  "tokens": "[REDACTED]",',
        '  "secrets": "[REDACTED]",',
        '  "cookies": "[REDACTED]",',
        '  "path": "D:\\\\repo\\\\src\\\\partitions.csv",',
        '  "error": "compile failed",',
        '  "buildId": 9007199254740993',
        '}',
      ].join('\n');

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('redacts plural identity and device containers without losing safe fields', () => {
      const input = String.raw`{"userIds":["USER-ONE"],"serials":["SERIAL-TWO"],"pnpIds":["PNP-THREE"],"accounts":[{"id":"ACCOUNT-FOUR"}],"path":"D:\\repo\\main.cpp","error":"compile failed"}`;
      const expected = String.raw`{"userIds":"[REDACTED]","serials":"[REDACTED]","pnpIds":"[REDACTED]","accounts":"[REDACTED]","path":"D:\\repo\\main.cpp","error":"compile failed"}`;

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('retains later compile lines after an unclosed sensitive JSON container', () => {
      const diagnostic = '[2026-09-02 23:05:37.409] [ERROR] [compile] '
        + 'D:\\ailyblockly\\project\\src\\partitions.csv not found';
      const result = sanitizeDiagnosticText([
        '{"token": {',
        diagnostic,
      ].join('\n'));

      expect(result).toContain('[REDACTED]');
      expect(result).toContain(diagnostic);
    });

    it('drops an unclosed sensitive container continuation but retains the next diagnostic record', () => {
      const diagnostic = '[ERROR] D:\\repo\\src\\partitions.csv not found';
      const result = sanitizeDiagnosticText([
        '[WARN] payload={"token": {',
        '  "value": "TOP-SECRET-IN-CHILD"',
        diagnostic,
      ].join('\n'));

      expect(result).not.toContain('TOP-SECRET-IN-CHILD');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain(diagnostic);
    });

    it('redacts credentials inside a safe JSON message without swallowing sibling fields', () => {
      const input = String.raw`{"message":"request failed token=secret-value","path":"D:\\repo\\main.cpp","error":"compile failed"}`;
      const expected = String.raw`{"message":"request failed token=[REDACTED]","path":"D:\\repo\\main.cpp","error":"compile failed"}`;

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('keeps later free-text diagnostics after a credential assignment', () => {
      const result = sanitizeDiagnosticText(
        'token=secret-value path=D:\\repo\\src\\partitions.csv error=compile failed',
      );

      expect(result).toBe(
        'token=[REDACTED] path=D:\\repo\\src\\partitions.csv error=compile failed',
      );
    });

    it('does not treat compiler prose using the word token as a credential field', () => {
      const diagnostic = 'unexpected token: partitions.csv at D:\\repo\\main.cpp:12';
      const jsonDiagnostic = JSON.stringify({
        message: diagnostic,
        path: 'D:\\repo\\main.cpp',
        error: 'compile failed',
      });

      expect(sanitizeDiagnosticText(diagnostic)).toBe(diagnostic);
      expect(sanitizeDiagnosticText(jsonDiagnostic)).toBe(jsonDiagnostic);
    });

    it('preserves safe fields around a credential in escaped nested JSON', () => {
      const input = String.raw`payload="{\"token\":\"nested,secret\",\"path\":\"D:\\\\repo\\\\src\\\\partitions.csv\",\"error\":\"compile failed\"}" suffix`;
      const expected = String.raw`payload="{\"token\":\"[REDACTED]\",\"path\":\"D:\\\\repo\\\\src\\\\partitions.csv\",\"error\":\"compile failed\"}" suffix`;

      expect(sanitizeDiagnosticText(input)).toBe(expected);
    });

    it('keeps near-match JSON keys that are not sensitive fields', () => {
      const input = String.raw`{"tokenCount":7,"file":"token.cpp","path":"D:\\repo\\src\\partitions.csv"}`;

      expect(sanitizeDiagnosticText(input)).toBe(input);
    });

    it('keeps malformed repeated JSON candidates within the sanitizer scan budget', () => {
      const input = String.raw`"token":{,`.repeat(5_000);
      const startedAt = performance.now();

      const result = sanitizeDiagnosticText(input);

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(result).not.toContain('token":{');
      expect(result).toContain('[REDACTED]');
    });

    it('omits a block containing private key material', () => {
      expect(sanitizeDiagnosticText([
        '-----BEGIN PRIVATE KEY-----',
        'FAKE_PRIVATE_MATERIAL',
        '-----END PRIVATE KEY-----',
      ].join('\n'))).toBeNull();
      expect(sanitizeDiagnosticText([
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'FAKE_OPENSSH_PRIVATE_MATERIAL',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'))).toBeNull();
    });
  });

  describe('extractLatestCrashDiagnostic', () => {
    it('uses the last abnormal process record and ignores a clean child exit', () => {
      const result = extractLatestCrashDiagnostic([
        '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":1}',
        '[2026-09-02 09:01:00.000] [error] [ProcessHealth][ChildGone] {"reason":"clean-exit","exitCode":0}',
        '[2026-09-02 09:02:00.000] [error] [ProcessHealth][ChildGone] {"reason":"oom","exitCode":9,"type":"GPU"}',
      ]);

      expect(result?.reason).toBe('oom');
      expect(result?.exitCode).toBe(9);
      expect(result?.processState).toBeNull();
      expect(result?.context).toContain('[ProcessHealth][ChildGone]');
    });

    it('caps sanitized crash context by UTF-8 bytes', () => {
      const crash = extractLatestCrashDiagnostic([
        `before-${'中'.repeat(10_000)}`,
        '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":1}',
        `after-${'文'.repeat(10_000)}`,
      ]);
      const result = sanitizeDiagnosticText(crash?.context, [], FEEDBACK_CRASH_CONTEXT_MAX_BYTES);

      expect(result).not.toBeNull();
      expect(utf8ByteLength(result!)).toBeLessThanOrEqual(FEEDBACK_CRASH_CONTEXT_MAX_BYTES);
      expect(result).toContain(FEEDBACK_TRUNCATION_MARKER);
    });

    it('redacts a long credential before bounding crash context', () => {
      const crash = extractLatestCrashDiagnostic([
        '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":1}',
        `Authorization: Bearer ${'sensitive-value'.repeat(4000)}`,
      ]);
      const result = sanitizeDiagnosticText(crash?.context, [], FEEDBACK_CRASH_CONTEXT_MAX_BYTES);

      expect(result).not.toBeNull();
      expect(result).toContain('Authorization: [REDACTED]');
      expect(result).not.toContain('sensitive-value');
      expect(utf8ByteLength(result!)).toBeLessThanOrEqual(FEEDBACK_CRASH_CONTEXT_MAX_BYTES);
    });

    it('omits source payloads before a crash context can be truncated', () => {
      const sourceTail = `private_source_${'x'.repeat(FEEDBACK_CRASH_CONTEXT_MAX_BYTES)}`;
      const rawWindow = [
        'sourceCode:',
        'private_source_line_1();',
        'private_source_line_2();',
        'private_source_line_3();',
        sourceTail,
        '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":1}',
      ].join('\n');

      expect(utf8ByteLength(rawWindow)).toBeGreaterThan(FEEDBACK_CRASH_CONTEXT_MAX_BYTES);
      expect(sanitizeDiagnosticText(rawWindow, [], FEEDBACK_CRASH_CONTEXT_MAX_BYTES)).toBeNull();
    });

    it('does not report clean exits or malformed child records as crashes', () => {
      expect(extractLatestCrashDiagnostic([
        '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"clean-exit","exitCode":0}',
        '[2026-09-02 09:01:00.000] [error] [ProcessHealth][ChildGone] not-json',
      ])).toBeNull();
    });
  });

  describe('UTF-8 budget', () => {
    it('drops an older log before trimming the newest log tail and preserves results', () => {
      const newestTail = 'newest-tail';
      const resultText = JSON.stringify({ status: 'success' });
      const result = enforceDiagnosticTextBudget([
        { key: 'old', kind: 'log', occurredAt: 1, content: '旧'.repeat(8_000) },
        { key: 'new', kind: 'log', occurredAt: 2, content: `${'新'.repeat(15_000)}${newestTail}` },
        { key: 'result', kind: 'result', content: resultText },
      ]);

      expect(result.find((block) => block.key === 'old')?.content).toBe(FEEDBACK_TRUNCATION_MARKER);
      expect(result.find((block) => block.key === 'new')?.content).toContain(FEEDBACK_TRUNCATION_MARKER);
      expect(result.find((block) => block.key === 'new')?.content?.endsWith(newestTail)).toBeTrue();
      expect(result.find((block) => block.key === 'result')?.content).toBe(resultText);
      expect(result.reduce(
        (total, block) => total + utf8ByteLength(block.content === null ? 'null' : block.content),
        0,
      ))
        .toBeLessThanOrEqual(32 * 1024);
    });

    it('counts rendered null literals in the shared byte limit', () => {
      const result = enforceDiagnosticTextBudget([
        { key: 'large', kind: 'result', content: 'x'.repeat(64) },
        { key: 'missing-result', kind: 'result', content: null },
        { key: 'missing-log', kind: 'log', content: null },
      ], 64);

      expect(result.reduce(
        (total, block) => total + utf8ByteLength(block.content === null ? 'null' : block.content),
        0,
      )).toBeLessThanOrEqual(64);
    });

    it('truncates on Unicode boundaries and counts the marker in the limit', () => {
      const result = truncateUtf8Tail(`${'汉'.repeat(100)}tail`, 64);

      expect(result.startsWith(FEEDBACK_TRUNCATION_MARKER)).toBeTrue();
      expect(result.endsWith('tail')).toBeTrue();
      expect(utf8ByteLength(result)).toBeLessThanOrEqual(64);
    });
  });
});
