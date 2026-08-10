<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { createEventBus } from '@n8n/utils/event-bus';
import {
	N8nButton,
	N8nCallout,
	N8nLoading,
	N8nSelect,
	N8nOption,
	N8nText,
} from '@n8n/design-system';

import Modal from '@/app/components/Modal.vue';
import { useRootStore } from '@n8n/stores/useRootStore';
import * as evaluationApi from '../../evaluation.api';
import type {
	DatasetCandidateResponse,
	DatasetColumnMapping,
	DatasetFieldSource,
} from '../../evaluation.types';

defineOptions({ name: 'AddExecutionToDatasetModal' });

const props = defineProps<{
	modalName: string;
	data?: { executionId?: string; workflowId?: string };
}>();

const i18n = useI18n();
const toast = useToast();
const rootStore = useRootStore();
const modalBus = createEventBus();

const isLoading = ref(true);
const isSubmitting = ref(false);
const candidate = ref<DatasetCandidateResponse | null>(null);
// Per data-table-column mapping choices, encoded as `${source}:${field}` (or '').
const selections = ref<Record<string, string>>({});

const executionId = computed(() => props.data?.executionId ?? '');
const workflowId = computed(() => props.data?.workflowId ?? '');

const fieldOptions = computed(() => {
	if (!candidate.value) return [];
	return [
		...candidate.value.fields.inputs.map((field) => ({
			value: `input:${field.key}`,
			label: `${i18n.baseText('evaluations.addToDataset.source.input')} · ${field.key}`,
		})),
		...candidate.value.fields.outputs.map((field) => ({
			value: `output:${field.key}`,
			label: `${i18n.baseText('evaluations.addToDataset.source.output')} · ${field.key}`,
		})),
	];
});

const hasColumns = computed(() => (candidate.value?.columns.length ?? 0) > 0);

function encodeMapping(mapping: DatasetColumnMapping): string {
	return mapping ? `${mapping.source}:${mapping.field}` : '';
}

function decodeMapping(value: string): DatasetColumnMapping {
	if (!value) return null;
	const [source, ...rest] = value.split(':');
	return { source: source as DatasetFieldSource, field: rest.join(':') };
}

async function loadCandidate() {
	if (!executionId.value || !workflowId.value) {
		isLoading.value = false;
		return;
	}
	isLoading.value = true;
	try {
		const response = await evaluationApi.getDatasetCandidate(
			rootStore.restApiContext,
			workflowId.value,
			executionId.value,
		);
		candidate.value = response;
		selections.value = Object.fromEntries(
			response.columns.map((column) => [
				column.name,
				encodeMapping(response.suggestedMapping[column.name] ?? null),
			]),
		);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluations.addToDataset.error.candidate'));
		modalBus.emit('close');
	} finally {
		isLoading.value = false;
	}
}

async function onSubmit() {
	if (!candidate.value) return;
	isSubmitting.value = true;
	try {
		const mapping: Record<string, DatasetColumnMapping> = {};
		for (const [column, value] of Object.entries(selections.value)) {
			mapping[column] = decodeMapping(value);
		}
		await evaluationApi.addDatasetRow(
			rootStore.restApiContext,
			workflowId.value,
			candidate.value.dataTableId,
			{ executionId: executionId.value, mapping },
		);
		toast.showMessage({
			title: i18n.baseText('evaluations.addToDataset.success.title'),
			type: 'success',
		});
		modalBus.emit('close');
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluations.addToDataset.error.submit'));
	} finally {
		isSubmitting.value = false;
	}
}

function closeModal() {
	modalBus.emit('close');
}

onMounted(loadCandidate);
</script>

<template>
	<Modal
		max-width="600px"
		:title="i18n.baseText('evaluations.addToDataset.title')"
		:event-bus="modalBus"
		:name="props.modalName"
		:center="true"
		data-test-id="add-execution-to-dataset-modal"
	>
		<template #content>
			<div :class="$style.container">
				<N8nLoading v-if="isLoading" :rows="4" />
				<N8nCallout v-else-if="!hasColumns" theme="warning">
					{{ i18n.baseText('evaluations.addToDataset.noColumns') }}
				</N8nCallout>
				<template v-else>
					<N8nText color="text-base" size="small">
						{{ i18n.baseText('evaluations.addToDataset.mapping.title') }}
					</N8nText>
					<div v-for="column in candidate?.columns ?? []" :key="column.name" :class="$style.row">
						<N8nText tag="span" :bold="true" :class="$style.columnName">
							{{ column.name }}
						</N8nText>
						<N8nSelect
							v-model="selections[column.name]"
							:placeholder="i18n.baseText('evaluations.addToDataset.field.placeholder')"
							clearable
							size="small"
							:teleported="false"
							:class="$style.select"
							:data-test-id="`add-to-dataset-column-${column.name}`"
						>
							<N8nOption
								:value="''"
								:label="i18n.baseText('evaluations.addToDataset.leaveEmpty')"
							/>
							<N8nOption
								v-for="option in fieldOptions"
								:key="option.value"
								:value="option.value"
								:label="option.label"
							/>
						</N8nSelect>
					</div>
				</template>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton variant="subtle" :label="i18n.baseText('generic.cancel')" @click="closeModal" />
				<N8nButton
					:loading="isSubmitting"
					:disabled="isLoading || !hasColumns"
					:label="i18n.baseText('evaluations.addToDataset.submit')"
					data-test-id="add-to-dataset-submit"
					@click="onSubmit"
				/>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.row {
	display: flex;
	align-items: center;
	gap: var(--spacing--sm);
}

.columnName {
	flex: 0 0 40%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.select {
	flex: 1 1 auto;
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--xs);
}
</style>
