<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ExecutionSummary } from 'n8n-workflow';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { getResourcePermissions } from '@n8n/permissions';
import { useInjectWorkflowId } from '@/app/composables/useInjectWorkflowId';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import { useExecutionsStore } from '../../executions.store';
import AnnotationTagsDropdown from '@/features/shared/tags/components/AnnotationTagsDropdown.vue';

import { N8nIcon, N8nTag, N8nText } from '@n8n/design-system';

const props = defineProps<{
	execution: ExecutionSummary;
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

const appliedTags = computed(() => props.execution.annotation?.tags ?? []);
const appliedTagIds = computed(() => appliedTags.value.map((tag) => tag.id));

const isEditing = ref(false);
// Local buffer for the dropdown so selection stays responsive while editing.
const selectedTagIds = ref<string[]>([...appliedTagIds.value]);

watch(appliedTagIds, (ids) => {
	if (!isEditing.value) {
		selectedTagIds.value = [...ids];
	}
});

function startEditing() {
	if (!workflowPermissions.value.update) return;
	selectedTagIds.value = [...appliedTagIds.value];
	isEditing.value = true;
}

async function saveTags() {
	// Nothing changed — skip the request.
	const current = [...appliedTagIds.value].sort();
	const next = [...selectedTagIds.value].sort();
	const unchanged =
		current.length === next.length && current.every((id, index) => id === next[index]);

	if (!unchanged) {
		try {
			await executionsStore.annotateExecution(props.execution.id, { tags: selectedTagIds.value });
		} catch (error) {
			showError(error, i18n.baseText('executionAnnotationView.tag.error'));
		}
	}

	isEditing.value = false;
}
</script>

<template>
	<div :class="$style.container" data-test-id="annotation-tags-container">
		<AnnotationTagsDropdown
			v-if="isEditing"
			v-model="selectedTagIds"
			:class="$style.dropdown"
			:placeholder="i18n.baseText('executionAnnotationView.chooseOrCreateATag')"
			:create-enabled="true"
			data-test-id="annotation-tags-dropdown"
			@esc="saveTags"
			@blur="saveTags"
		/>
		<template v-else>
			<N8nTag
				v-for="tag in appliedTags"
				:key="tag.id"
				:text="tag.name"
				:clickable="workflowPermissions.update"
				data-test-id="annotation-tag"
				@click="startEditing"
			/>
			<button
				v-if="workflowPermissions.update"
				type="button"
				:class="$style.addTag"
				data-test-id="new-annotation-tag-button"
				@click="startEditing"
			>
				<N8nIcon icon="circle-plus" size="xsmall" />
				<N8nText size="small" color="text-light">
					{{ i18n.baseText('executionAnnotationView.addTag') }}
				</N8nText>
			</button>
		</template>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--3xs);
	margin-top: var(--spacing--4xs);
}

.dropdown {
	min-width: 224px;
}

.addTag {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--5xs);
	padding: var(--spacing--5xs) var(--spacing--4xs);
	border: 1px dashed var(--color--foreground--shade-1);
	border-radius: var(--radius);
	background: transparent;
	cursor: pointer;
	color: var(--color--text--tint-1);

	&:hover {
		color: var(--color--primary);
		border-color: var(--color--primary);
	}
}
</style>
