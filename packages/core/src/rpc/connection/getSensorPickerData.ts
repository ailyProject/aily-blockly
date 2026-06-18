import { z } from 'zod'

import { getConnectionSensorPickerData } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ packagesBasePath: z.string() }))
	.query(({ input }) => getConnectionSensorPickerData(input.packagesBasePath))
