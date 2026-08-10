import { computed, type ComputedRef } from 'vue';

import { usePostHog } from '@/app/stores/posthog.store';
import { useSettingsStore } from '@n8n/stores/settings.store';

// PostHog flag gating the agent-evals surface. Kept in sync with the backend
// `AGENT_EVALS_FLAG` (`101_agent_evals`).
const AGENT_EVALS_FLAG = '101_agent_evals';

/**
 * Whether the agent-evals surface is available. The operator override
 * (`N8N_AGENT_EVALS_ENABLED`, surfaced on settings) wins; otherwise the
 * `101_agent_evals` PostHog flag is the source of truth.
 *
 * NOTE: the agent-evals backend (item E17) is not live yet — this flag simply
 * gates the UI entry points until it lands.
 */
export function useAgentEvalsFlag(): ComputedRef<boolean> {
	const posthogStore = usePostHog();
	const settingsStore = useSettingsStore();

	return computed(
		() =>
			settingsStore.settings.evaluation?.agentEvalsEnabled === true ||
			posthogStore.isFeatureEnabled(AGENT_EVALS_FLAG),
	);
}
