import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useSettingsStore } from '@n8n/stores/settings.store';

interface EvaluationsLicense {
	/** Whether this instance is entitled to the evaluations surface. */
	isLicensed: ComputedRef<boolean>;
	/** Whether the entitlement has been resolved (settings loaded). */
	isResolved: Ref<boolean>;
	/** Ensures settings are loaded so `isLicensed` reflects the real entitlement. */
	ensureLicenseLoaded: () => Promise<void>;
}

/**
 * Entitlement gate for the evaluations surface.
 *
 * There is no enterprise licence for evaluations in this fork; entitlement is
 * expressed through the evaluation `quota` surfaced on settings — a quota of `0`
 * means the instance is not entitled (the paywall is shown), while `-1`
 * (unlimited) or any positive quota grants access.
 */
export function useEvaluationsLicense(): EvaluationsLicense {
	const settingsStore = useSettingsStore();

	const isResolved = ref(false);

	const isLicensed = computed(() => {
		const quota = settingsStore.settings.evaluation?.quota;
		return quota !== undefined && quota !== 0;
	});

	async function ensureLicenseLoaded() {
		if (isResolved.value) return;
		try {
			if (!settingsStore.settings.evaluation) {
				await settingsStore.getSettings();
			}
		} finally {
			isResolved.value = true;
		}
	}

	return { isLicensed, isResolved, ensureLicenseLoaded };
}
