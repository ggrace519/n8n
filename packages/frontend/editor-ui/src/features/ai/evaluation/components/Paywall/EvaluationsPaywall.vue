<script setup lang="ts">
import { useI18n } from '@n8n/i18n';
import { N8nEmptyState } from '@n8n/design-system';
import { EVALUATIONS_DOCS_URL } from '@/app/constants';

defineOptions({ name: 'EvaluationsPaywall' });

const i18n = useI18n();

function openDocs() {
	window.open(EVALUATIONS_DOCS_URL, '_blank', 'noopener,noreferrer');
}
</script>

<template>
	<div :class="$style.container" data-test-id="evaluations-unlicensed">
		<N8nEmptyState
			:icon="{ type: 'icon', value: 'flask-conical' }"
			:heading="i18n.baseText('evaluations.paywall.title')"
			:description="i18n.baseText('evaluations.paywall.description')"
			:button-text="i18n.baseText('evaluations.paywall.cta')"
			button-variant="solid"
			button-icon="external-link"
			@click:button="openDocs"
		/>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	height: 100%;
	width: 100%;
	padding: var(--spacing--lg);
	text-align: center;
}
</style>
