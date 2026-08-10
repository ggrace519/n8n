<script lang="ts">
import { computed, defineComponent, type PropType } from 'vue';
import { useSettingsStore } from '@n8n/stores/settings.store';
import type { EnterpriseEditionFeatureValue } from '@/Interface';

/**
 * Feature gate: renders the default slot only when the required licensed
 * features are enabled on the instance, otherwise the optional `fallback` slot.
 *
 * Implemented as a render-function component so it renders the slot content
 * directly (no wrapper element), keeping the consumers' DOM layout intact.
 */
export default defineComponent({
	name: 'EnterpriseEdition',
	inheritAttrs: false,
	props: {
		features: {
			type: Array as PropType<EnterpriseEditionFeatureValue[]>,
			default: () => [],
		},
		// `allOf` (default): every feature must be enabled. `oneOf`: any one.
		mode: {
			type: String as PropType<'allOf' | 'oneOf'>,
			default: 'allOf',
		},
	},
	setup(props, { slots }) {
		const settingsStore = useSettingsStore();

		const canAccess = computed<boolean>(() => {
			if (props.features.length === 0) {
				return true;
			}

			const enabledFeatures = settingsStore.isEnterpriseFeatureEnabled;

			return props.mode === 'oneOf'
				? props.features.some((feature) => Boolean(enabledFeatures[feature]))
				: props.features.every((feature) => Boolean(enabledFeatures[feature]));
		});

		return () => (canAccess.value ? slots.default?.() : slots.fallback?.());
	},
});
</script>
