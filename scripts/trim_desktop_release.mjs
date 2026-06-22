import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const releaseTemplatePackagePath = path.join(repoRoot, 'release', 'desktop-app', 'package.json')

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
	const current = process.argv[index]
	const next = process.argv[index + 1]
	if (current.startsWith('--') && next && !next.startsWith('--')) {
		args.set(current, next)
		index += 1
		continue
	}
	if (current.startsWith('--')) {
		args.set(current, 'true')
	}
}

const platform = args.get('--platform') || 'generic'
const skipInstall = args.get('--no-install') === 'true'
const releaseDir = path.join(repoRoot, 'release', `desktop-${platform}`)
const vendorDir = path.join(releaseDir, 'vendor')
const localPackagesDir = path.join(releaseDir, 'local-packages')
const appDir = path.join(releaseDir, 'app')

const run = (command, commandArgs, options = {}) => {
	const result = spawnSync(command, commandArgs, {
		cwd: repoRoot,
		stdio: 'inherit',
		...options
	})
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${commandArgs.join(' ')}`)
	}
}

const extractPackedPackageJson = (tarballPath) => {
	const result = spawnSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
		cwd: repoRoot,
		encoding: 'utf8'
	})
	if (result.status !== 0 || !result.stdout) {
		throw new Error(`Unable to inspect tarball: ${tarballPath}`)
	}
	return JSON.parse(result.stdout)
}

const packWorkspacePackage = async packageName => {
	run('pnpm', ['--filter', packageName, 'pack', '--pack-destination', vendorDir])
	const files = await readdir(vendorDir)
	const tarball = files
		.filter(file => file.endsWith('.tgz'))
		.find(file => file.startsWith(`${packageName}-`))
	if (!tarball) {
		throw new Error(`Packed tarball not found for ${packageName}`)
	}
	return path.join(vendorDir, tarball)
}

const unpackTarball = async (tarballPath, packageName) => {
	const targetDir = path.join(localPackagesDir, packageName)
	await mkdir(targetDir, { recursive: true })
	run('tar', ['-xf', tarballPath, '-C', targetDir, '--strip-components=1'])
	return targetDir
}

const rewritePackageJson = async (packageDir, transform) => {
	const packagePath = path.join(packageDir, 'package.json')
	const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
	const nextPackageJson = transform(packageJson)
	await writeFile(packagePath, `${JSON.stringify(nextPackageJson, null, 2)}\n`, 'utf8')
}

const readReleaseTemplatePackageJson = async () => JSON.parse(await readFile(releaseTemplatePackagePath, 'utf8'))

const createReleaseManifest = async tarballs => {
	const localDesktopPath = path.join(localPackagesDir, 'desktop')
	const templatePackageJson = await readReleaseTemplatePackageJson()
	const packageJson = {
		productName: templatePackageJson.productName,
		description: templatePackageJson.description,
		build: templatePackageJson.build,
		name: `aily-blockly-desktop-${platform}`,
		private: true,
		version: templatePackageJson.version || '0.0.0',
		type: templatePackageJson.type || 'module',
		main: './node_modules/desktop/dist/main/index.js',
		dependencies: {
			desktop: `file:${path.relative(appDir, localDesktopPath)}`
		}
	}

	await mkdir(appDir, { recursive: true })
	await writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
	await writeFile(
		path.join(releaseDir, 'release-manifest.json'),
		`${JSON.stringify(
			{
				platform,
				tarballs: Object.fromEntries(Object.entries(tarballs).map(([key, value]) => [key, path.basename(value)])),
				localPackages: ['desktop', 'core', 'shared', 'erpc'],
				createdAt: new Date().toISOString()
			},
			null,
			2
		)}\n`,
		'utf8'
	)
}

const installReleaseApp = async () => {
	const storeDir = await mkdtemp(path.join(tmpdir(), 'aily-pnpm-store-'))
	run(
		'pnpm',
		['install', '--prod', '--ignore-scripts', '--ignore-workspace', '-C', appDir, '--store-dir', storeDir],
		{ env: { ...process.env, CI: 'true' } }
	)
}

await rm(releaseDir, { recursive: true, force: true })
await mkdir(vendorDir, { recursive: true })
await mkdir(localPackagesDir, { recursive: true })

const tarballs = {
	shared: await packWorkspacePackage('shared'),
	erpc: await packWorkspacePackage('erpc'),
	core: await packWorkspacePackage('core'),
	desktop: await packWorkspacePackage('desktop')
}

const localPackages = {
	shared: await unpackTarball(tarballs.shared, 'shared'),
	erpc: await unpackTarball(tarballs.erpc, 'erpc'),
	core: await unpackTarball(tarballs.core, 'core'),
	desktop: await unpackTarball(tarballs.desktop, 'desktop')
}

await rewritePackageJson(localPackages.shared, packageJson => ({
	...packageJson,
	devDependencies: undefined,
	scripts: undefined
}))

await rewritePackageJson(localPackages.erpc, packageJson => ({
	...packageJson,
	devDependencies: undefined,
	scripts: undefined
}))

await rewritePackageJson(localPackages.core, packageJson => ({
	...packageJson,
	dependencies: {
		...(packageJson.dependencies || {}),
		shared: 'file:../shared'
	},
	devDependencies: undefined,
	scripts: undefined
}))

await rewritePackageJson(localPackages.desktop, packageJson => ({
	...packageJson,
	dependencies: {
		...(packageJson.dependencies || {}),
		core: 'file:../core',
		shared: 'file:../shared',
		erpc: 'file:../erpc'
	},
	devDependencies: undefined,
	scripts: undefined
}))

await createReleaseManifest(tarballs)
if (!skipInstall) {
	await installReleaseApp()
}

const appPackage = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'))
console.log(`Prepared trimmed desktop release at ${releaseDir}`)
console.log(`Entry: ${appPackage.main}`)
