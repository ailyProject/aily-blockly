import { z } from 'zod'

import { resetLayout } from '../../project'
import { p } from '../trpc'
import { appRegistryItemSchema } from './schemas'

export default p
	.input(z.object({ defaultToolbarAppIds: z.array(z.string()), apps: z.array(appRegistryItemSchema) }))
	.query(({ input }) => resetLayout(input.defaultToolbarAppIds, new Map(input.apps.map(app => [app.id, app]))))
