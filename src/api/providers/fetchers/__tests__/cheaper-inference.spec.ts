// npx vitest run src/api/providers/fetchers/__tests__/cheaper-inference.spec.ts

import axios from "axios"

import { cheaperInferenceDefaultModelInfo } from "@roo-code/types"

import { getCheaperInferenceModels, parseCheaperInferenceModel } from "../cheaper-inference"

vi.mock("axios")

describe("Cheaper Inference Fetchers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getCheaperInferenceModels", () => {
		it("maps the /models response and sends the API key as a Bearer header", async () => {
			vi.mocked(axios.get).mockResolvedValue({
				data: {
					data: [
						{
							id: "gpt-5.4-mini",
							type: "text",
							context_length: 400000,
							max_output_tokens: 128000,
							capabilities: { vision: true, reasoning: true },
							pricing: {
								currency: "USD",
								input_per_million: "0.487500",
								output_per_million: "2.925000",
								cache_read_input_per_million: "0.048750",
								cache_write_input_per_million: null,
							},
						},
						{
							id: "glm-5.3",
							type: "text",
							context_length: 200000,
							max_output_tokens: 64000,
							capabilities: { vision: false },
						},
					],
				},
			})

			const models = await getCheaperInferenceModels("test-key")

			expect(axios.get).toHaveBeenCalledWith("https://api.cheaperinference.com/v1/models", {
				headers: { Authorization: "Bearer test-key" },
				signal: undefined,
			})

			expect(Object.keys(models).sort()).toEqual(["glm-5.3", "gpt-5.4-mini"])
			expect(models["gpt-5.4-mini"]).toMatchObject({
				contextWindow: 400000,
				maxTokens: 128000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 0.4875,
				outputPrice: 2.925,
				cacheReadsPrice: 0.04875,
			})
			expect(models["gpt-5.4-mini"].cacheWritesPrice).toBeUndefined()
			expect(models["glm-5.3"]).toMatchObject({
				contextWindow: 200000,
				maxTokens: 64000,
				supportsImages: false,
			})
		})

		it("skips image and video models", async () => {
			vi.mocked(axios.get).mockResolvedValue({
				data: {
					data: [
						{ id: "gpt-5.4-mini", type: "text" },
						{ id: "gpt-image-2", type: "image" },
						{ id: "seedance-2.0", type: "video" },
					],
				},
			})

			const models = await getCheaperInferenceModels("k")

			expect(Object.keys(models)).toEqual(["gpt-5.4-mini"])
		})

		it("falls back to default context/max tokens when metadata is absent", async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: { data: [{ id: "kimi-k2.5" }] } })

			const models = await getCheaperInferenceModels("k")

			expect(models["kimi-k2.5"]).toMatchObject({
				contextWindow: cheaperInferenceDefaultModelInfo.contextWindow,
				maxTokens: cheaperInferenceDefaultModelInfo.maxTokens,
				supportsPromptCache: false,
			})
		})

		it("does not send a request without an API key", async () => {
			expect(await getCheaperInferenceModels()).toEqual({})
			expect(axios.get).not.toHaveBeenCalled()
		})

		it("returns an empty map on network error", async () => {
			vi.mocked(axios.get).mockRejectedValue(new Error("network"))
			expect(await getCheaperInferenceModels("k")).toEqual({})
		})

		it("returns an empty map on a non-Error rejection", async () => {
			vi.mocked(axios.get).mockRejectedValue("boom")
			expect(await getCheaperInferenceModels("k")).toEqual({})
		})

		it("falls back to an empty array when response.data.data is not an array", async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: { data: null } })
			expect(await getCheaperInferenceModels("k")).toEqual({})
		})

		it("skips entries that fail safeParse with a console.warn", async () => {
			vi.mocked(axios.get).mockResolvedValue({
				data: {
					data: [
						{ id: "valid-model", context_length: 50000 },
						{ not_a_field: true }, // no `id`, so it will fail safeParse
					],
				},
			})
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const models = await getCheaperInferenceModels("k")

			expect(Object.keys(models)).toEqual(["valid-model"])
			expect(models["valid-model"].contextWindow).toBe(50000)
			// Two warns: one for the outer schema mismatch, one for the invalid item
			expect(warnSpy).toHaveBeenCalledTimes(2)
			expect(warnSpy.mock.calls[0][0]).toContain("did not match expected schema")
			expect(warnSpy.mock.calls[1][0]).toContain("Skipping invalid Cheaper Inference model entry")

			warnSpy.mockRestore()
		})

		it("forwards the caller's abort signal to the request", async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
			const controller = new AbortController()

			await getCheaperInferenceModels("test-key", { signal: controller.signal })

			expect(axios.get).toHaveBeenCalledWith("https://api.cheaperinference.com/v1/models", {
				headers: { Authorization: "Bearer test-key" },
				signal: controller.signal,
			})
		})

		it("rejects with an AbortError when the signal aborts the pending request", async () => {
			const controller = new AbortController()
			vi.mocked(axios.get).mockImplementation((_url, config) => {
				// Mirror the HTTP client: a pending request rejects when its signal fires.
				return new Promise<never>((_resolve, reject) => {
					config?.signal?.addEventListener?.("abort", () => reject(new Error("canceled")), { once: true })
				})
			})

			const fetchPromise = getCheaperInferenceModels("k", { signal: controller.signal })
			controller.abort()

			await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" })
		})
	})

	describe("parseCheaperInferenceModel", () => {
		it("ignores prices that are not in USD", () => {
			const info = parseCheaperInferenceModel({
				id: "x",
				pricing: { currency: "EUR", input_per_million: "1", output_per_million: "2" },
			})
			expect(info.inputPrice).toBeUndefined()
			expect(info.outputPrice).toBeUndefined()
		})

		it("ignores prices that are not numbers", () => {
			const info = parseCheaperInferenceModel({
				id: "x",
				pricing: { currency: "USD", input_per_million: "n/a", output_per_million: 3 },
			})
			expect(info.inputPrice).toBeUndefined()
			expect(info.outputPrice).toBe(3)
		})

		it("treats every model as not cache-capable", () => {
			const info = parseCheaperInferenceModel({ id: "x", context_length: 100000, max_output_tokens: 8000 })
			expect(info.supportsPromptCache).toBe(false)
			expect(info.contextWindow).toBe(100000)
			expect(info.maxTokens).toBe(8000)
		})
	})
})
