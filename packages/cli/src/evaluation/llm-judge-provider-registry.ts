import type { LlmJudgeProvider } from '@n8n/api-types';
import { LLM_JUDGE_PROVIDERS } from '@n8n/api-types';
import { Service } from '@n8n/di';

/**
 * Lookup over the canonical LLM-judge provider list in `@n8n/api-types` —
 * the single source of truth shared with the config DTO schema, so supported
 * providers can't drift between validation and runtime.
 */
@Service()
export class LlmJudgeProviderRegistry {
	private readonly byCredentialType = new Map<string, LlmJudgeProvider>();

	constructor() {
		for (const provider of LLM_JUDGE_PROVIDERS) {
			for (const credentialType of provider.credentialTypes) {
				this.byCredentialType.set(credentialType.name, provider);
			}
		}
	}

	/** The provider selected by a credential type, or undefined when the type is not a judge provider. */
	getByCredentialType(credentialType: string): LlmJudgeProvider | undefined {
		return this.byCredentialType.get(credentialType);
	}

	getAll(): LlmJudgeProvider[] {
		return [...LLM_JUDGE_PROVIDERS];
	}
}
