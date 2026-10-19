import type { ModelInfo } from "../model.js"

// Cheaper Inference: OpenAI-compatible LLM gateway.
// https://cheaperinference.com/docs · base URL: https://api.cheaperinference.com/v1
//
// The full model list (and metadata) is fetched dynamically from
// `https://api.cheaperinference.com/v1/models`, so models can be switched on the fly.
// The values below are only a fallback used before the live list resolves.

// Single source of truth for the gateway base URL, shared by the handler and
// the model fetcher so the endpoint is defined in exactly one place.
export const CHEAPER_INFERENCE_BASE_URL = "https://api.cheaperinference.com/v1"

export const cheaperInferenceDefaultModelId = "gpt-5.4-mini"

export const cheaperInferenceDefaultModelInfo: ModelInfo = {
	maxTokens: 128_000,
	contextWindow: 400_000,
	supportsImages: true,
	supportsPromptCache: false,
	description: "Cheaper Inference model. Available models and metadata are resolved dynamically from /v1/models.",
}

export const CHEAPER_INFERENCE_DEFAULT_TEMPERATURE = 0
