<script setup lang="ts">
import { computed } from 'vue';
import { useLocalStorage } from '@vueuse/core';
import { useI18n } from '@n8n/i18n';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { N8nButton, N8nIcon, N8nText } from '@n8n/design-system';

import { useFocusPanelStore } from '@/app/stores/focusPanel.store';
import { useInjectWorkflowId } from '@/app/composables/useInjectWorkflowId';
import { useEvaluationsWizardSidepanelExperiment } from '@/experiments/evaluationsWizardSidepanel/useEvaluationsWizardSidepanelExperiment';
import { useEvaluationsLicense } from '../../composables/useEvaluationsLicense';
import { useAiRootNodes } from '../../composables/useAiRootNodes';
import { useWorkflowEvaluationState } from '../../composables/useWorkflowEvaluationState';

defineOptions({ name: 'EvaluationsCanvasInfoCard' });

const i18n = useI18n();
const telemetry = useTelemetry();
const workflowId = useInjectWorkflowId();
const focusPanelStore = useFocusPanelStore();

const { isFeatureEnabled } = useEvaluationsWizardSidepanelExperiment();
const { isLicensed } = useEvaluationsLicense();
const aiRootNodes = useAiRootNodes();
const { evaluationTriggerExists } = useWorkflowEvaluationState();

// Dismissal is per-workflow so setting up evaluations on one workflow doesn't
// hide the nudge everywhere.
const dismissed = useLocalStorage(
	`evaluations-canvas-info-card-dismissed-${workflowId.value}`,
	false,
);

const isVisible = computed(
	() =>
		isFeatureEnabled.value &&
		isLicensed.value &&
		aiRootNodes.value.length > 0 &&
		!evaluationTriggerExists.value &&
		!dismissed.value,
);

function onSetup() {
	telemetry.track('User opened evaluations wizard', {
		workflow_id: workflowId.value,
		source: 'canvas_info_card',
	});
	focusPanelStore.setSelectedTab('evaluations');
	focusPanelStore.openFocusPanel();
}

function onDismiss() {
	dismissed.value = true;
}
</script>

<template>
	<div v-if="isVisible" :class="$style.card" data-test-id="evaluations-canvas-info-card">
		<div :class="$style.header">
			<N8nIcon icon="flask-conical" :class="$style.icon" />
			<N8nText tag="span" size="small" :bold="true">
				{{ i18n.baseText('evaluations.canvasInfoCard.title') }}
			</N8nText>
			<button
				:class="$style.dismiss"
				:aria-label="i18n.baseText('evaluations.canvasInfoCard.dismiss')"
				data-test-id="evaluations-canvas-info-card-dismiss"
				@click="onDismiss"
			>
				<N8nIcon icon="circle-x" size="small" />
			</button>
		</div>
		<N8nText tag="p" size="small" color="text-base" :class="$style.description">
			{{ i18n.baseText('evaluations.canvasInfoCard.description') }}
		</N8nText>
		<N8nButton
			variant="outline"
			size="small"
			icon="arrow-right"
			data-test-id="evaluations-canvas-info-card-setup"
			@click="onSetup"
		>
			{{ i18n.baseText('evaluations.canvasInfoCard.setup') }}
		</N8nButton>
	</div>
</template>

<style lang="scss" module>
.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	max-width: 280px;
	padding: var(--spacing--xs);
	background: var(--color--background--light-3);
	border: 1px solid var(--color--foreground);
	border-radius: var(--radius);
	box-shadow: var(--box-shadow--light);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.icon {
	color: var(--color--primary);
}

.dismiss {
	margin-left: auto;
	border: none;
	background: transparent;
	cursor: pointer;
	color: var(--color--text--tint-1);
	padding: 0;
	display: inline-flex;

	&:hover {
		color: var(--color--text--shade-1);
	}
}

.description {
	margin: 0;
}
</style>
