import { getModelCatalogDetail } from '../../model'
import { p } from '../trpc'
import { modelCatalogDetailSchema, normalizeModelCatalogDetailInput } from './schemas'

export default p
	.input(modelCatalogDetailSchema)
	.query(({ input }) => getModelCatalogDetail(normalizeModelCatalogDetailInput(input)))
