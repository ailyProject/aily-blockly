/**
 * Ripgrep 二进制文件下载和配置脚本
 * 
 * 用途: 下载各平台的 ripgrep 二进制文件并放置到正确的位置
 * 运行: node electron/download-ripgrep.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const { URL } = require('url');

// ripgrep 版本
const RIPGREP_VERSION = '14.1.0';

// 目标平台配置
const PLATFORMS = [
    {
        name: 'Windows x64',
        platform: 'win32',
        arch: 'x64',
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
        extractPath: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc/rg.exe`,
        targetDir: 'x64-win32',
        targetFile: 'rg.exe'
    },
    {
        name: 'Windows x86',
        platform: 'win32',
        arch: 'ia32',
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-i686-pc-windows-msvc.zip`,
        extractPath: `ripgrep-${RIPGREP_VERSION}-i686-pc-windows-msvc/rg.exe`,
        targetDir: 'ia32-win32',
        targetFile: 'rg.exe'
    },
    {
        name: 'macOS x64',
        platform: 'darwin',
        arch: 'x64',
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
        extractPath: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin/rg`,
        targetDir: 'x64-darwin',
        targetFile: 'rg'
    },
    {
        name: 'macOS ARM64',
        platform: 'darwin',
        arch: 'arm64',
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
        extractPath: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin/rg`,
        targetDir: 'arm64-darwin',
        targetFile: 'rg'
    },
    {
        name: 'Linux x64',
        platform: 'linux',
        arch: 'x64',
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
        extractPath: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg`,
        targetDir: 'x64-linux',
        targetFile: 'rg'
    }
];

// 目标目录
const VENDOR_DIR = path.join(__dirname, 'vendor', 'ripgrep');

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * 下载文件
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        console.log(`  下载: ${url}`);
        
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        
        const request = protocol.get(url, (response) => {
            // 处理重定向
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                fs.unlinkSync(destPath);
                return downloadFile(response.headers.location, destPath)
                    .then(resolve)
                    .catch(reject);
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                return reject(new Error(`下载失败: HTTP ${response.statusCode}`));
            }
            
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            let lastProgress = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const progress = Math.floor((downloadedSize / totalSize) * 100);
                if (progress - lastProgress >= 10) {
                    process.stdout.write(`\r  进度: ${progress}%`);
                    lastProgress = progress;
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                console.log('\r  下载完成!              ');
                resolve();
            });
        });
        
        request.on('error', (err) => {
            file.close();
            fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

/**
 * 解压文件
 */
function extractArchive(archivePath, extractPath, targetDir) {
    console.log(`  解压: ${path.basename(archivePath)}`);
    
    const tempDir = path.join(os.tmpdir(), 'ripgrep-extract-' + Date.now());
    ensureDir(tempDir);
    
    try {
        if (archivePath.endsWith('.zip')) {
            // Windows: 使用 PowerShell 解压
            if (process.platform === 'win32') {
                const cmd = `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force"`;
                execSync(cmd, { stdio: 'ignore' });
            } else {
                // 在非 Windows 系统上尝试使用 unzip
                execSync(`unzip -q "${archivePath}" -d "${tempDir}"`, { stdio: 'ignore' });
            }
        } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
            // macOS/Linux: 使用 tar
            console.log(`  执行: tar -xzf "${archivePath}" -C "${tempDir}"`);
            execSync(`tar -xzf "${archivePath}" -C "${tempDir}"`, { stdio: 'pipe' });
        } else {
            throw new Error(`不支持的压缩格式: ${path.extname(archivePath)}`);
        }
        
        // 复制二进制文件到目标位置
        const sourcePath = path.join(tempDir, extractPath);
        const destPath = path.join(VENDOR_DIR, targetDir, path.basename(extractPath));
        
        console.log(`  查找源文件: ${sourcePath}`);
        
        if (!fs.existsSync(sourcePath)) {
            // 如果找不到文件，列出临时目录的内容进行调试
            console.log(`  ✗ 未找到源文件，临时目录内容:`);
            try {
                const files = fs.readdirSync(tempDir, { recursive: true });
                files.forEach(file => console.log(`    - ${file}`));
            } catch (e) {
                console.log(`    无法列出目录内容: ${e.message}`);
            }
            throw new Error(`未找到文件: ${sourcePath}`);
        }
        
        ensureDir(path.dirname(destPath));
        fs.copyFileSync(sourcePath, destPath);
        
        // 在 Unix 系统上设置执行权限
        if (process.platform !== 'win32') {
            fs.chmodSync(destPath, 0o755);
        }
        
        console.log(`  ✓ 已安装到: ${destPath}`);
        
        // 清理临时文件
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.unlinkSync(archivePath);
        
        return destPath;
    } catch (error) {
        console.error(`  解压失败: ${error.message}`);
        // 清理
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }
        throw error;
    }
}

/**
 * 下载并安装 ripgrep
 */
async function downloadAndInstallRipgrep(platformConfig) {
    console.log(`\n[${platformConfig.name}]`);
    
    const targetPath = path.join(VENDOR_DIR, platformConfig.targetDir, platformConfig.targetFile);
    
    // 检查是否已存在
    if (fs.existsSync(targetPath)) {
        console.log(`  已存在，跳过下载`);
        return;
    }
    
    // 下载
    const tempFile = path.join(os.tmpdir(), `ripgrep-${platformConfig.arch}-${platformConfig.platform}.tar.gz`);
    
    console.log(`  临时文件: ${tempFile}`);
    
    try {
        await downloadFile(platformConfig.url, tempFile);
        extractArchive(tempFile, platformConfig.extractPath, platformConfig.targetDir);
    } catch (error) {
        console.error(`  ✗ 失败:`, error.message);
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }
}

/**
 * 主函数
 */
async function main() {
    console.log('='.repeat(60));
    console.log('Ripgrep 二进制文件下载工具');
    console.log('='.repeat(60));
    console.log(`版本: ${RIPGREP_VERSION}`);
    console.log(`目标目录: ${VENDOR_DIR}\n`);
    
    // 确保 vendor 目录存在
    ensureDir(VENDOR_DIR);
    
    // 询问用户要下载哪些平台
    console.log('可用平台:');
    console.log('  1. 仅当前平台');
    console.log('  2. Windows 平台 (x64 + x86)');
    console.log('  3. macOS 平台 (x64 + ARM64)');
    console.log('  4. Linux 平台 (x64)');
    console.log('  5. 所有平台\n');
    
    // 默认下载所有平台
    const choice = process.argv[2] || '5';
    
    let platformsToDownload = [];
    
    switch (choice) {
        case '1':
            platformsToDownload = PLATFORMS.filter(p => 
                p.platform === process.platform && p.arch === process.arch
            );
            break;
        case '2':
            platformsToDownload = PLATFORMS.filter(p => p.platform === 'win32');
            break;
        case '3':
            platformsToDownload = PLATFORMS.filter(p => p.platform === 'darwin');
            break;
        case '4':
            platformsToDownload = PLATFORMS.filter(p => p.platform === 'linux');
            break;
        case '5':
        default:
            platformsToDownload = PLATFORMS;
            break;
    }
    
    console.log(`将下载 ${platformsToDownload.length} 个平台的二进制文件\n`);
    
    // 下载所有平台
    for (const platform of platformsToDownload) {
        await downloadAndInstallRipgrep(platform);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✓ 所有下载完成!');
    console.log('='.repeat(60));
    console.log('\n已安装的文件:');
    
    // 列出所有已安装的文件
    for (const platform of PLATFORMS) {
        const filePath = path.join(VENDOR_DIR, platform.targetDir, platform.targetFile);
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`  ✓ ${platform.name}: ${filePath} (${sizeMB} MB)`);
        }
    }
    
    console.log('\n提示:');
    console.log('  - 这些二进制文件将被打包到应用中');
    console.log('  - 用户无需额外安装 ripgrep');
    console.log('  - 应用会自动选择对应平台的版本');
}

// 运行
main().catch(console.error);
