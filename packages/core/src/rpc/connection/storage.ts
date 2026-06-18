import { z } from 'zod'

import {
	hasConnectionAws,
	hasConnectionGraph,
	readConnectionAws,
	readConnectionGraph,
	saveConnectionAws,
	saveConnectionGraph
} from '../../connection'
import { p } from '../trpc'
import { connectionGraphSchema } from './schemas'

export const readGraph = p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => readConnectionGraph(input.projectPath))

export const hasGraph = p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => hasConnectionGraph(input.projectPath))

export const saveGraph = p
	.input(z.object({ projectPath: z.string(), data: connectionGraphSchema }))
	.mutation(({ input }) => saveConnectionGraph(input.data, input.projectPath))

export const readAws = p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => readConnectionAws(input.projectPath))

export const hasAws = p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => hasConnectionAws(input.projectPath))

export const saveAws = p
	.input(z.object({ projectPath: z.string(), content: z.string() }))
	.mutation(({ input }) => saveConnectionAws(input.content, input.projectPath))
