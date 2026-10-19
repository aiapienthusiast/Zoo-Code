// npx vitest run src/api/providers/__tests__/cheaper-inference.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { cheaperInferenceDefaultModelId } from "@roo-code/types"

import { CheaperInferenceHandler } from "../cheaper-inference"
import { getModels } from "../fetchers/modelCache"
import { ApiHandlerOptions } from "../../../shared/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

vitest.mock("openai")
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(() =>
		Promise.resolve({
			"glm-5.3": {
				maxTokens: 32768,
				contextWindow: 1048576,
				supportsImages: false,
				supportsPromptCache: false,
				description: "GLM 5.3",
			},
		}),
	),
	refreshModels: vitest.fn(async (options, handler) => {
		const { getModels } = await import("../fetchers/modelCache")
		return getModels(options, handler)
	}),
	getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}))

const mockCreate = vitest.fn()

vitest.mocked(OpenAI).mockImplementation(function () {
	// Only chat.completions.create is used by the handler under test.
	return { chat: { completions: { create: mockCreate } } } as unknown as OpenAI
})

describe("CheaperInferenceHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		cheaperInferenceApiKey: "test-key",
		cheaperInferenceModelId: "glm-5.3",
	}

	beforeEach(() => {
		clearAllMocks()
		mockCreate.mockClear()
	})

	it("initializes the OpenAI client with the Cheaper Inference base URL and key", () => {
		const handler = new CheaperInferenceHandler(mockOptions)
		expect(handler).toBeInstanceOf(CheaperInferenceHandler)
		expect(OpenAI).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.cheaperinference.com/v1",
				apiKey: "test-key",
			}),
		)
	})

	describe("fetchModel", () => {
		it("returns the configured model info", async () => {
			const handler = new CheaperInferenceHandler(mockOptions)
			const result = await handler.fetchModel()
			expect(result.id).toBe("glm-5.3")
			expect(result.info.maxTokens).toBe(32768)
			expect(result.info.contextWindow).toBe(1048576)
			expect(result.info.supportsPromptCache).toBe(false)
		})

		it("falls back to the default model id when none is configured", async () => {
			const handler = new CheaperInferenceHandler({ cheaperInferenceApiKey: "test-key" })
			const result = await handler.fetchModel()
			expect(result.id).toBe(cheaperInferenceDefaultModelId)
		})
	})

	describe("createMessage", () => {
		beforeEach(() => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [
							{
								delta: {
									content: "Hello",
									reasoning_content: "thinking…",
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "read_file", arguments: '{"path":' },
										},
									],
								},
								index: 0,
							},
						],
						usage: null,
					},
					{
						choices: [{ delta: {}, index: 0 }],
						usage: {
							prompt_tokens: 12,
							completion_tokens: 7,
							total_tokens: 19,
							prompt_tokens_details: { cached_tokens: 4 },
						},
					},
				]),
			)
		})

		it("streams text, reasoning, tool-call and usage chunks", async () => {
			const handler = new CheaperInferenceHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]

			const chunks = await collectStream(handler.createMessage("You are helpful.", messages))

			expect(chunks).toContainEqual({ type: "text", text: "Hello" })
			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking…" })
			expect(chunks).toContainEqual({
				type: "tool_call_partial",
				index: 0,
				id: "call_1",
				name: "read_file",
				arguments: '{"path":',
			})
			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 4,
			})
		})

		it("yields nothing for a chunk whose delta has no content, reasoning or tool calls", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{ choices: [{ delta: {}, index: 0 }], usage: null },
					{ choices: [], usage: null },
				]),
			)

			const handler = new CheaperInferenceHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([])
		})

		it("streams tool call chunks even when the function name and arguments are missing", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { tool_calls: [{ index: 1 }] }, index: 0 }],
						usage: null,
					},
				]),
			)

			const handler = new CheaperInferenceHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 1,
					id: undefined,
					name: undefined,
					arguments: undefined,
				},
			])
		})

		it("reports undefined cache reads when usage has no prompt_tokens_details", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: {}, index: 0 }],
						usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
					},
				]),
			)

			const handler = new CheaperInferenceHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([
				{
					type: "usage",
					inputTokens: 3,
					outputTokens: 2,
					cacheReadTokens: undefined,
				},
			])
		})

		it("skips the reasoning chunk when reasoning_content is an empty string", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "Hi", reasoning_content: "" }, index: 0 }],
						usage: null,
					},
				]),
			)

			const handler = new CheaperInferenceHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toEqual([{ type: "text", text: "Hi" }])
		})

		it("emits reasoning from the OpenRouter-style `reasoning` field when reasoning_content is absent", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "Hi", reasoning: "thinking…" }, index: 0 }],
						usage: null,
					},
				]),
			)

			const handler = new CheaperInferenceHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toContainEqual({ type: "reasoning", text: "thinking…" })
		})

		it("omits temperature for models that do not support it", async () => {
			vitest.mocked(getModels).mockResolvedValueOnce({
				"openai/o3-mini": {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					description: "o3-mini via Cheaper Inference",
				},
			})

			const handler = new CheaperInferenceHandler({
				cheaperInferenceApiKey: "test-key",
				cheaperInferenceModelId: "openai/o3-mini",
			})
			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "openai/o3-mini",
					temperature: undefined,
				}),
			)
		})

		it("sends an explicitly configured model temperature", async () => {
			const handler = new CheaperInferenceHandler({ ...mockOptions, modelTemperature: 0.7 })
			await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.7 }))
		})

		it("honors metadata.parallelToolCalls false", async () => {
			const handler = new CheaperInferenceHandler(mockOptions)
			await collectStream(
				handler.createMessage("sys", [{ role: "user", content: "Hi" }], {
					taskId: "task-1",
					parallelToolCalls: false,
				}),
			)

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parallel_tool_calls: false }))
		})

		it("reports zero usage when the upstream counts are zero", async () => {
			mockCreate.mockImplementation(async () =>
				asyncStreamFrom([
					{
						choices: [{ delta: { content: "x" }, index: 0 }],
						usage: { prompt_tokens: 0, completion_tokens: 0 },
					},
				]),
			)

			const handler = new CheaperInferenceHandler(mockOptions)
			const chunks = await collectStream(handler.createMessage("sys", [{ role: "user", content: "Hi" }]))

			expect(chunks).toContainEqual({
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: undefined,
			})
		})

		it("requests a streaming completion with usage included", async () => {
			const handler = new CheaperInferenceHandler(mockOptions)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hi" }]
			await collectStream(handler.createMessage("sys", messages))

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.3",
					stream: true,
					stream_options: { include_usage: true },
					max_completion_tokens: 32768,
					temperature: expect.any(Number),
				}),
			)
		})
	})

	describe("completePrompt", () => {
		it("returns the message content for a non-streaming completion", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "the answer" } }] })
			const handler = new CheaperInferenceHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("the answer")
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: "glm-5.3",
					stream: false,
					max_completion_tokens: 32768,
				}),
			)
		})

		it("returns an empty string when the completion has no content", async () => {
			mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] })
			const handler = new CheaperInferenceHandler(mockOptions)
			expect(await handler.completePrompt("ping")).toBe("")
		})

		it("wraps errors with a Cheaper Inference-specific message", async () => {
			mockCreate.mockRejectedValue(new Error("boom"))
			const handler = new CheaperInferenceHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toThrow("Cheaper Inference completion error: boom")
		})

		it("re-throws non-Error rejections unchanged", async () => {
			mockCreate.mockRejectedValue("string failure")
			const handler = new CheaperInferenceHandler(mockOptions)
			await expect(handler.completePrompt("ping")).rejects.toBe("string failure")
		})

		it("omits temperature for models that do not support it", async () => {
			vitest.mocked(getModels).mockResolvedValueOnce({
				"openai/o3-mini": {
					maxTokens: 4096,
					contextWindow: 128000,
					supportsImages: false,
					supportsPromptCache: false,
					description: "o3-mini via Cheaper Inference",
				},
			})
			mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] })

			const handler = new CheaperInferenceHandler({
				cheaperInferenceApiKey: "test-key",
				cheaperInferenceModelId: "openai/o3-mini",
			})
			expect(await handler.completePrompt("ping")).toBe("ok")

			const callArgs = mockCreate.mock.calls[0][0]
			expect(callArgs.model).toBe("openai/o3-mini")
			expect("temperature" in callArgs).toBe(false)
		})
	})

	describe("model catalog", () => {
		it("reports its cache scope", () => {
			const handler = new CheaperInferenceHandler(mockOptions)
			expect(handler.getModelCacheScope()).toEqual({ urlScoped: false, keyScoped: true, authScoped: false })
		})
	})
})
