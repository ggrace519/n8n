<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useClipboard } from '@n8n/composables/useClipboard';
import { N8nIcon, N8nText, N8nTooltip } from '@n8n/design-system';
import { VARIABLE_EXPRESSION_PREFIX } from '../environments.constants';

const props = defineProps<{
	name: string;
}>();

const i18n = useI18n();
const clipboard = useClipboard();

const copied = ref(false);

const usageSyntax = computed(() => `${VARIABLE_EXPRESSION_PREFIX}.${props.name}`);

const tooltipContent = computed(() =>
	copied.value
		? i18n.baseText('variables.row.usage.copiedToClipboard')
		: i18n.baseText('variables.row.usage.copyToClipboard'),
);

async function onCopy() {
	await clipboard.copy(usageSyntax.value);
	copied.value = true;
	setTimeout(() => {
		copied.value = false;
	}, 2000);
}
</script>

<template>
	<N8nTooltip placement="top" :content="tooltipContent">
		<button
			:class="$style.badge"
			type="button"
			data-test-id="variables-usage-badge"
			@click="onCopy"
		>
			<N8nText :class="$style.syntax" size="small">{{ usageSyntax }}</N8nText>
			<N8nIcon :class="$style.icon" icon="copy" size="small" />
		</button>
	</N8nTooltip>
</template>

<style lang="scss" module>
.badge {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--3xs) var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius);
	background-color: var(--color--background--light-2);
	cursor: pointer;

	&:hover .icon {
		opacity: 1;
	}
}

.syntax {
	color: var(--color--text--shade-1);
	font-family: var(--font-family--monospace);
	white-space: nowrap;
}

.icon {
	color: var(--color--text--tint-1);
	opacity: 0;
	transition: opacity var(--duration--base) ease;
}
</style>
