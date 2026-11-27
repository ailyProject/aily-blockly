'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const builderVersion = '25.1.8';
const extractTemplateHash = 'e4174388a0f7a1df0b85a0742aa1ea7a4b2b18f9f29dccd6ef10a66212f68148';
const extractTemplate = path.join('include', 'extractAppPackage.nsh');
const copyRecovery = [
  '',
  '  LoopExtract7za:',
  '    IntOp $R1 $R1 + 1',
  '    ClearErrors',
  '    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
  '    IfErrors 0 DoneExtract7za',
  '',
  '    DetailPrint "$(ailyInstallCopyFailed)"',
  '    ${If} $R1 >= 5',
  '      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(ailyInstallCopyFailed)" /SD IDCANCEL IDRETRY RetryExtract7za',
  '      SetErrorLevel 2',
  '      Quit',
  '',
  '      RetryExtract7za:',
  '        StrCpy $R1 0',
  '    ${EndIf}',
  '',
  '    Sleep 1000',
  '    Goto LoopExtract7za',
  '',
].join('\n');
const copyFailureMessages = `

ailyInstallCopyFailed:
  en: |-
    Could not write the application files to:
    $OUTDIR
    Check for files in use, directory permissions, and free disk space before retrying.
  zh_CN: |-
    无法将应用文件写入以下目录：
    $OUTDIR
    请检查文件占用、目录写入权限和磁盘剩余空间，然后重试。
  zh_TW: |-
    無法將應用程式檔案寫入以下目錄：
    $OUTDIR
    請檢查檔案占用、目錄寫入權限與磁碟剩餘空間，然後重試。
`;

let prepared = false;

module.exports = function prepareWindowsNsis({ targetPresentableName }) {
  if (targetPresentableName !== 'nsis' || prepared) return;

  const requireBuilder = createRequire(require.resolve('electron-builder/package.json'));
  const version = requireBuilder('app-builder-lib/package.json').version;
  const nsis = requireBuilder('app-builder-lib/out/targets/nsis/nsisUtil');
  const source = nsis.nsisTemplatesDir;
  const template = fs.readFileSync(path.join(source, extractTemplate), 'utf8');
  const hash = createHash('sha256').update(template).digest('hex');
  if (version !== builderVersion || hash !== extractTemplateHash) {
    throw new Error(`Review the Windows NSIS file-copy patch for app-builder-lib ${version} (${hash})`);
  }

  const from = template.indexOf('\n  LoopExtract7za:');
  const to = template.indexOf('\n  DoneExtract7za:', from);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-nsis-'));
  try {
    fs.cpSync(source, directory, { recursive: true });
    fs.writeFileSync(path.join(directory, extractTemplate), template.slice(0, from) + copyRecovery + template.slice(to));
    fs.appendFileSync(path.join(directory, 'messages.yml'), copyFailureMessages);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  // Use a private template tree so concurrent builds and the installed dependency remain untouched.
  nsis.nsisTemplatesDir = directory;
  prepared = true;
  process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
};
