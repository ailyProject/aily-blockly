import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * 克隆当前环境变量，并显式移除会跳过 Electron 二进制下载的开关。
 * @returns {NodeJS.ProcessEnv}
 */
const createElectronInstallEnv = () => {
	const env = { ...process.env }
	delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
	return env
}

/**
 * 读取当前 Electron 包版本。
 * @param {string} packageDir
 * @returns {string}
 */
const readElectronPackageVersion = packageDir =>
	JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version

/**
 * 解析平台对应的 Electron 可执行相对路径。
 * @returns {string}
 */
const resolveElectronExecutableRelativePath = () => {
	if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
	if (process.platform === 'win32') return 'electron.exe'
	return 'electron'
}

/**
 * 解析可能存在的 Electron 缓存 zip 路径。
 * @param {string} version
 * @returns {string[]}
 */
const resolveElectronCacheZipCandidates = version => {
	const fileName = `electron-v${version}-${process.platform}-${process.arch}.zip`
	const baseDirs =
		process.platform === 'darwin'
			? [path.join(os.homedir(), 'Library/Caches/electron')]
			: [path.join(os.homedir(), '.cache/electron')]

	const candidates = []
	for (const baseDir of baseDirs) {
		if (!fs.existsSync(baseDir)) continue

		for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue

			const zipPath = path.join(baseDir, entry.name, fileName)
			if (fs.existsSync(zipPath)) candidates.push(zipPath)
		}
	}

	return candidates
}

/**
 * 从本机 Electron 缓存 zip 解压运行时。
 * @param {string} packageDir
 * @returns {Promise<boolean>}
 */
const restoreElectronRuntimeFromCache = async packageDir => {
	const version = readElectronPackageVersion(packageDir)
	const zipPath = resolveElectronCacheZipCandidates(version)[0]
	if (!zipPath) return false

	const distDir = path.join(packageDir, 'dist')
	fs.rmSync(distDir, { recursive: true, force: true })
	fs.mkdirSync(distDir, { recursive: true })

	await new Promise((resolve, reject) => {
		const child = spawn('unzip', ['-oq', zipPath, '-d', distDir], {
			stdio: 'inherit',
			env: process.env
		})
		child.once('exit', code => {
			code === 0 ? resolve() : reject(new Error(`unzip failed with exit=${String(code)}`))
		})
		child.once('error', reject)
	})

	fs.writeFileSync(path.join(packageDir, 'path.txt'), resolveElectronExecutableRelativePath())
	fs.writeFileSync(path.join(distDir, 'version'), `v${version}`)
	return hasElectronRuntime(packageDir)
}

/**
 * 定位当前 workspace 中的 Electron 包目录。
 * @returns {string}
 */
export const resolveElectronPackageDir = () => path.dirname(require.resolve('electron/package.json'))

/**
 * 读取 Electron `path.txt` 中记录的二进制相对路径。
 * @param {string} packageDir
 * @returns {string}
 */
const readElectronBinaryRelativePath = packageDir => {
	const pathFile = path.join(packageDir, 'path.txt')
	return fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : ''
}

/**
 * 判断当前 Electron 包是否已经包含可执行运行时。
 * @param {string} packageDir
 * @returns {boolean}
 */
const hasElectronRuntime = packageDir => {
	const relativePath = readElectronBinaryRelativePath(packageDir)
	if (!relativePath) return false

	return fs.existsSync(path.join(packageDir, 'dist', relativePath))
}

/**
 * 确保 Electron 运行时已完成下载与解压。
 * @returns {Promise<string>}
 */
export const ensureElectronRuntime = async () => {
	const packageDir = resolveElectronPackageDir()
	if (hasElectronRuntime(packageDir)) return packageDir

	const installExitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(packageDir, 'install.js')], {
			stdio: 'inherit',
			env: createElectronInstallEnv()
		})
		child.once('exit', code => {
			resolve(code ?? 0)
		})
		child.once('error', reject)
	})

	if (installExitCode === 0 && hasElectronRuntime(packageDir)) return packageDir
	if (await restoreElectronRuntimeFromCache(packageDir)) return packageDir

	throw new Error(
		`Electron runtime installation failed (exit=${String(installExitCode)}). Expected ${path.join(packageDir, 'dist')} and path.txt to be generated.`
	)

}

/**
 * 解析 Electron 可执行文件绝对路径。
 * @returns {Promise<string>}
 */
export const resolveElectronBinaryPath = async () => {
	const packageDir = await ensureElectronRuntime()
	const relativePath = readElectronBinaryRelativePath(packageDir)
	if (!relativePath) {
		throw new Error('Electron runtime path.txt is missing after installation.')
	}

	return path.join(packageDir, 'dist', relativePath)
}
