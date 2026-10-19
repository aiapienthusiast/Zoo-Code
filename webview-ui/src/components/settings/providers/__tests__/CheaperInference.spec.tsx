import { render, screen, fireEvent } from "@testing-library/react"

import type { ProviderSettings, OrganizationAllowList } from "@roo-code/types"
import { cheaperInferenceDefaultModelId } from "@roo-code/types"

import { CheaperInference } from "../CheaperInference"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type }: any) => (
		<div>
			{children}
			<input type={type} value={value} onChange={(e) => onInput(e)} data-testid="api-key-input" />
		</div>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children, href }: any) => (
		<a href={href} data-testid="get-api-key-link">
			{children}
		</a>
	),
}))

// Stub ModelPicker so we can assert the props it receives without pulling in its hooks.
vi.mock("../../ModelPicker", () => ({
	ModelPicker: ({ defaultModelId, modelIdKey, serviceName }: any) => (
		<div
			data-testid="model-picker"
			data-default-model-id={defaultModelId}
			data-model-id-key={modelIdKey}
			data-service-name={serviceName}
		/>
	),
}))

describe("CheaperInference", () => {
	const organizationAllowList: OrganizationAllowList = { allowAll: true, providers: {} }
	const mockSetApiConfigurationField = vi.fn()

	const renderComponent = (apiConfiguration: ProviderSettings) =>
		render(
			<CheaperInference
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={organizationAllowList}
			/>,
		)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("updates the API key via setApiConfigurationField on input", () => {
		renderComponent({ cheaperInferenceApiKey: "" })

		fireEvent.change(screen.getByTestId("api-key-input"), { target: { value: "secret-key" } })

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("cheaperInferenceApiKey", "secret-key")
	})

	it("shows the get-API-key CTA only when no API key is set", () => {
		const { rerender } = renderComponent({ cheaperInferenceApiKey: "" })
		const link = screen.getByTestId("get-api-key-link")
		expect(link).toBeInTheDocument()
		expect(link).toHaveAttribute("href", "https://cheaperinference.com/signup")

		rerender(
			<CheaperInference
				apiConfiguration={{ cheaperInferenceApiKey: "already-set" }}
				setApiConfigurationField={mockSetApiConfigurationField}
				organizationAllowList={organizationAllowList}
			/>,
		)
		expect(screen.queryByTestId("get-api-key-link")).not.toBeInTheDocument()
	})

	it("wires the ModelPicker with the Cheaper Inference defaults", () => {
		renderComponent({ cheaperInferenceApiKey: "key" })

		const picker = screen.getByTestId("model-picker")
		expect(picker).toHaveAttribute("data-default-model-id", cheaperInferenceDefaultModelId)
		expect(picker).toHaveAttribute("data-model-id-key", "cheaperInferenceModelId")
		expect(picker).toHaveAttribute("data-service-name", "Cheaper Inference")
	})
})
