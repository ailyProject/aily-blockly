import type { ConnectionGraphData, ConnectionValidationResult } from './types'

const isPowerFunction = (name: string) => /VCC|3V3|5V/.test(name)

/**
 * 校验连线图安全性与基础合理性。
 * @param data - 连线图数据
 */
export const validateConnectionGraph = (data: ConnectionGraphData): Array<ConnectionValidationResult> => {
	const results: Array<ConnectionValidationResult> = []
	const pinUsage = new Map<string, Array<string>>()

	for (const connection of data.connections) {
		const fromIsGnd = connection.from.function === 'GND' || connection.type === 'gnd'
		const toIsGnd = connection.to.function === 'GND' || connection.type === 'gnd'
		const fromIsPower = isPowerFunction(connection.from.function) || connection.type === 'power'
		const toIsPower = isPowerFunction(connection.to.function) || connection.type === 'power'

		if ((fromIsGnd && toIsPower) || (fromIsPower && toIsGnd)) {
			results.push({
				ruleId: 'vcc_to_gnd',
				level: 'error',
				message: `Connection ${connection.id}: GND linked to power.`
			})
		}

		if (connection.type === 'uart') {
			if (connection.from.function === 'TX' && connection.to.function === 'TX') {
				results.push({
					ruleId: 'uart_crossover',
					level: 'error',
					message: `Connection ${connection.id}: TX should not connect to TX.`
				})
			}

			if (connection.from.function === 'RX' && connection.to.function === 'RX') {
				results.push({
					ruleId: 'uart_crossover',
					level: 'error',
					message: `Connection ${connection.id}: RX should not connect to RX.`
				})
			}
		}

		for (const key of [
			`${connection.from.ref}.${connection.from.pinId}`,
			`${connection.to.ref}.${connection.to.pinId}`
		]) {
			const existing = pinUsage.get(key) || []
			existing.push(connection.id)
			pinUsage.set(key, existing)
		}
	}

	for (const [pin, connectionIds] of pinUsage.entries()) {
		if (connectionIds.length <= 1) continue

		const connectionTypes = connectionIds.map(id => data.connections.find(connection => connection.id === id)?.type)
		const allBus = connectionTypes.every(type => type === 'i2c' || type === 'spi')
		if (!allBus) {
			results.push({
				ruleId: 'pin_conflict',
				level: 'warning',
				message: `Pin ${pin} is reused by multiple connections: ${connectionIds.join(', ')}.`
			})
		}
	}

	const boardRef = data.components[0]?.refId || ''
	const refs = new Set(data.connections.flatMap(connection => [connection.from.ref, connection.to.ref]))

	for (const ref of refs) {
		if (ref === boardRef) continue

		const hasPower = data.connections.some(
			connection => (connection.to.ref === ref || connection.from.ref === ref) && connection.type === 'power'
		)
		const hasGnd = data.connections.some(
			connection => (connection.to.ref === ref || connection.from.ref === ref) && connection.type === 'gnd'
		)

		if (!hasPower) {
			results.push({ ruleId: 'missing_power', level: 'warning', message: `Component ${ref} has no power connection.` })
		}

		if (!hasGnd) {
			results.push({
				ruleId: 'missing_ground',
				level: 'warning',
				message: `Component ${ref} has no ground connection.`
			})
		}
	}

	return results
}
