import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@roo-code/types"
import { cheaperInferenceDefaultModelInfo, CHEAPER_INFERENCE_BASE_URL } from "@roo-code/types"

import { throwIfAborted } from "../utils/abort-signal"

// The Cheaper Inference `/models` endpoint follows the OpenAI `/models` shape
// and requires a Bearer key. The `id` is the only guaranteed field; metadata is
// optional and best-effort, so the schema is intentionally permissive.
// The list also contains image and video models (`type` other than "text").
// Those cannot serve chat completions, so they are skipped.
// Prices are USD per 1M tokens, sent as decimal strings.
const priceSchema = z.union([z.string(), z.number()]).nullish()

const cheaperInferenceModelSchema = z.object({
	id: z.string(),
	type: z.string().optional(),
	context_length: z.number().nullish(),
	max_output_tokens: z.number().nullish(),
	capabilities: z
		.object({
			vision: z.boolean().optional(),
		})
		.passthrough()
		.optional(),
	pricing: z
		.object({
			currency: z.string().optional(),
			input_per_million: priceSchema,
			output_per_million: priceSchema,
			cache_read_input_per_million: priceSchema,
			cache_write_input_per_million: priceSchema,
		})
		.passthrough()
		.nullish(),
})

export type CheaperInferenceModel = z.infer<typeof cheaperInferenceModelSchema>

const cheaperInferenceModelsResponseSchema = z.object({
	data: z.array(cheaperInferenceModelSchema),
})

const parsePrice = (value: string | number | null | undefined): number | undefined => {
	if (value === null || value === undefined || value === "") {
		return undefined
	}
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Maps a raw Cheaper Inference model entry to the internal {@link ModelInfo} shape.
 *
 * Falls back to {@link cheaperInferenceDefaultModelInfo} when the upstream payload
 * omits context-window or max-token fields, ensuring downstream consumers
 * always receive a fully-populated object.
 *
 * @param model - Validated model entry from the `/models` response.
 * @returns Normalised model metadata suitable for the model picker.
 */
export const parseCheaperInferenceModel = (model: CheaperInferenceModel): ModelInfo => {
	const pricing = model.pricing && (model.pricing.currency ?? "USD") === "USD" ? model.pricing : undefined
	const inputPrice = parsePrice(pricing?.input_per_million)
	const outputPrice = parsePrice(pricing?.output_per_million)
	const cacheReadsPrice = parsePrice(pricing?.cache_read_input_per_million)
	const cacheWritesPrice = parsePrice(pricing?.cache_write_input_per_million)

	return {
		maxTokens: model.max_output_tokens ?? cheaperInferenceDefaultModelInfo.maxTokens,
		contextWindow: model.context_length ?? cheaperInferenceDefaultModelInfo.contextWindow,
		supportsImages: model.capabilities?.vision ?? false,
		supportsPromptCache: false,
		...(inputPrice !== undefined ? { inputPrice } : {}),
		...(outputPrice !== undefined ? { outputPrice } : {}),
		...(cacheReadsPrice !== undefined ? { cacheReadsPrice } : {}),
		...(cacheWritesPrice !== undefined ? { cacheWritesPrice } : {}),
	}
}

/**
 * Fetches the list of available chat models from the Cheaper Inference `/models` endpoint.
 *
 * The endpoint shape mirrors the OpenAI `/models` response. A permissive Zod
 * schema is used so that unknown fields are silently dropped rather than
 * causing a hard failure. Invalid entries (e.g. missing `id`) are skipped
 * with a console warning rather than propagated to the UI.
 *
 * @param apiKey - Bearer token; the endpoint requires it, so no request is made without one.
 * @param opts - Optional per-request controls; `signal` cancels the in-flight request.
 * @returns A record mapping model IDs to their normalised {@link ModelInfo}.
 */
export async function getCheaperInferenceModels(
	apiKey?: string,
	opts?: { signal?: AbortSignal },
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	if (!apiKey) {
		return models
	}

	try {
		const response = await axios.get(`${CHEAPER_INFERENCE_BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: opts?.signal,
		})

		const result = cheaperInferenceModelsResponseSchema.safeParse(response.data)
		const rawData = result.success ? result.data.data : response.data?.data
		const data = Array.isArray(rawData) ? rawData : []

		if (!result.success) {
			console.warn(
				`Cheaper Inference models response did not match expected schema; falling back to per-item parsing: ${JSON.stringify(result.error.format())}`,
			)
		}

		for (const rawModel of data) {
			const parsed = cheaperInferenceModelSchema.safeParse(rawModel)
			if (!parsed.success) {
				console.warn(`Skipping invalid Cheaper Inference model entry: ${JSON.stringify(rawModel)}`)
				continue
			}
			if (parsed.data.type !== undefined && parsed.data.type !== "text") {
				continue
			}
			models[parsed.data.id] = parseCheaperInferenceModel(parsed.data)
		}
	} catch (error) {
		// Surface cancellation as a rejection: logging and returning here would
		// present an aborted fetch to callers as a successful (partial) catalog.
		throwIfAborted(opts?.signal)

		console.error(
			`Error fetching Cheaper Inference models: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	return models
}
