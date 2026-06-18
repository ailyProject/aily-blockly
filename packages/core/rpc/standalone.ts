import { createAilyCoreServer } from './server'

const parsePort = (value: string | undefined) => {
	const port = Number(value)
	return Number.isInteger(port) && port > 0 ? port : undefined
}

const server = createAilyCoreServer({
	host: process.env['AILY_CORE_SERVICE_HOST'],
	port: parsePort(process.env['AILY_CORE_SERVICE_PORT']),
	transport: 'utility-process',
	version: process.env['npm_package_version'] || '0.0.0'
})

const shutdown = async () => {
	await server.stop()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const address = await server.start()
console.log(`[aily-core] listening on ${address.baseUrl}`)
