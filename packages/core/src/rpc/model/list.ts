import { listModelCatalog } from '../../model'
import { p } from '../trpc'
import { modelCatalogListSchema, normalizeModelCatalogListInput } from './schemas'

export default p.input(modelCatalogListSchema).query(({ input }) =>
	listModelCatalog({
		config: normalizeModelCatalogListInput(input).config,
		query: {
			page: normalizeModelCatalogListInput(input).page,
			pageSize: normalizeModelCatalogListInput(input).pageSize,
			search: normalizeModelCatalogListInput(input).search,
			uniformType: normalizeModelCatalogListInput(input).uniformType,
			language: normalizeModelCatalogListInput(input).language
		}
	})
)
