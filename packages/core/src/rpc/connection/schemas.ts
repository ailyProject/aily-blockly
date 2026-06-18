import { z } from 'zod'

const endpointSchema = z.object({
	ref: z.string(),
	pinId: z.string(),
	function: z.string()
})

const connectionSchema = z.object({
	id: z.string(),
	from: endpointSchema,
	to: endpointSchema,
	type: z.string(),
	half: z.boolean().optional(),
	label: z.string(),
	color: z.string().optional().default(''),
	note: z.string().optional()
})

const componentSchema = z.object({
	refId: z.string(),
	componentId: z.string(),
	componentName: z.string(),
	configFile: z.string().optional(),
	pinmapId: z.string().optional(),
	instance: z.number().optional(),
	componentType: z.enum(['hardware', 'software']).optional(),
	softwareConfig: z.record(z.string(), z.unknown()).optional()
})

export const connectionGraphSchema = z.object({
	version: z.string(),
	description: z.string(),
	components: z.array(componentSchema),
	connections: z.array(connectionSchema)
})
