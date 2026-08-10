<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AnnotationVote, ExecutionSummary } from 'n8n-workflow';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { getResourcePermissions } from '@n8n/permissions';
import { useInjectWorkflowId } from '@/app/composables/useInjectWorkflowId';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import { useExecutionsStore } from '../../executions.store';

import { N8nIconButton, N8nInput, N8nPopover, N8nText } from '@n8n/design-system';

type ExecutionAnnotation = {
	vote: AnnotationVote | null;
	tags: Array<{ id: string; name: string }>;
	note?: string;
};

const props = defineProps<{
	execution: ExecutionSummary & { annotation?: ExecutionAnnotation };
}>();

const i18n = useI18n();
const { showError } = useToast();
const executionsStore = useExecutionsStore();
const workflowsListStore = useWorkflowsListStore();
const workflowId = useInjectWorkflowId();

const workflowPermissions = computed(
	() =>
		getResourcePermissions(workflowsListStore.getWorkflowById(workflowId.value)?.scopes).workflow,
);

const savedNote = computed(() => props.execution.annotation?.note ?? '');
const note = ref(savedNote.value);

// Keep the editable buffer in sync when the underlying execution changes.
watch(savedNote, (value) => {
	note.value = value;
});

const hasNote = computed(() => savedNote.value.trim().length > 0);

async function saveNote() {
	if (note.value === savedNote.value) return;

	try {
		await executionsStore.annotateExecution(props.execution.id, { note: note.value });
	} catch (error) {
		showError(error, i18n.baseText('executionAnnotationView.note.error'));
	}
}

function onOpenChange(open: boolean) {
	if (!open) {
		void saveNote();
	}
}
</script>

<template>
	<N8nPopover side="bottom" align="end" width="320px" @update:open="onOpenChange">
		<template #trigger>
			<N8nIconButton
				variant="subtle"
				size="medium"
				icon="message-square"
				:active="hasNote"
				:title="i18n.baseText('executionAnnotationView.note.title')"
				:aria-label="i18n.baseText('executionAnnotationView.note.title')"
				data-test-id="execution-annotation-note-button"
			/>
		</template>
		<template #content>
			<div :class="$style.content">
				<N8nText size="small" color="text-dark" bold>
					{{ i18n.baseText('executionAnnotationView.note.title') }}
				</N8nText>
				<N8nInput
					v-model="note"
					type="textarea"
					:rows="4"
					:disabled="!workflowPermissions.update"
					:placeholder="i18n.baseText('executionAnnotationView.note.placeholder')"
					data-test-id="execution-annotation-note-input"
					@blur="saveNote"
				/>
			</div>
		</template>
	</N8nPopover>
</template>

<style module lang="scss">
.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--2xs);
}
</style>
