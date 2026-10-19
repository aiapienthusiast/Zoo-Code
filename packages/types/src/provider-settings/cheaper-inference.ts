import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

const CHEAPER_INFERENCE_MODEL_ID_FIELD = "cheaperInferenceModelId"

export const cheaperInferenceProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.cheaperInference,
	modelIdKey: CHEAPER_INFERENCE_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(CHEAPER_INFERENCE_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		cheaperInferenceApiKey: z.string().optional(),
		[CHEAPER_INFERENCE_MODEL_ID_FIELD]: z.string().optional(),
	},
})
