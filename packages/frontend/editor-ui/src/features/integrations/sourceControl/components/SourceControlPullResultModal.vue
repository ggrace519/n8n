<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import type { SourceControlledFile } from '@n8n/api-types';
import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { SOURCE_CONTROL_PULL_RESULT_MODAL_KEY } from '@/features/integrations/sourceControl/sourceControl.constants';
import { N8nButton, N8nHeading, N8nTabs, N8nText } from '@n8n/design-system';

const props = defineProps<{
	modalName: string;
	data: {
		files: SourceControlledFile[];
	};
}>();

const i18n = useI18n();
const uiStore = useUIStore();

type ResultTab = 'published' | 'failed';
const activeTab = ref<ResultTab>('published');

const workflows = computed(() =>
	(props.data.files ?? []).filter((file) => file.type === 'workflow'),
);

const publishedWorkflows = computed(() => workflows.value.filter((file) => !file.publishingError));
const failedWorkflows = computed(() => workflows.value.filter((file) => file.publishingError));

const visibleWorkflows = computed(() =>
	activeTab.value === 'published' ? publishedWorkflows.value : failedWorkflows.value,
);

const tabOptions = computed(() => [
	{
		label: `${i18n.baseText('settings.sourceControl.modals.pullResult.tabs.published')} (${publishedWorkflows.value.length})`,
		value: 'published' as const,
	},
	{
		label: `${i18n.baseText('settings.sourceControl.modals.pullResult.tabs.failed')} (${failedWorkflows.value.length})`,
		value: 'failed' as const,
	},
]);

function close() {
	uiStore.closeModal(SOURCE_CONTROL_PULL_RESULT_MODAL_KEY);
}
</script>

<template>
	<Modal width="640px" :name="props.modalName" data-test-id="source-control-pull-result-modal">
		<template #header>
			<N8nHeading tag="h1" size="xlarge">
				{{ i18n.baseText('settings.sourceControl.modals.pullResult.title') }}
			</N8nHeading>
		</template>
		<template #content>
			<div :class="$style.container">
				<N8nTabs v-model="activeTab" :options="tabOptions" />

				<N8nText size="small" color="text-light">
					{{
						i18n.baseText('settings.sourceControl.modals.pullResult.itemCount', {
							adjustToNumber: visibleWorkflows.length,
							interpolate: { count: visibleWorkflows.length },
						})
					}}
				</N8nText>

				<div v-if="visibleWorkflows.length === 0" :class="$style.empty">
					<N8nText color="text-light">
						{{ i18n.baseText('settings.sourceControl.modals.pullResult.noWorkflows') }}
					</N8nText>
				</div>
				<ul v-else :class="$style.list" data-test-id="source-control-pull-result-list">
					<li v-for="file in visibleWorkflows" :key="file.id" :class="$style.item">
						<N8nText>{{ file.name || file.file }}</N8nText>
						<N8nText v-if="file.publishingError" size="small" color="danger" :class="$style.error">
							{{ file.publishingError }}
						</N8nText>
					</li>
				</ul>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					:label="i18n.baseText('settings.sourceControl.modals.pullResult.buttons.close')"
					data-test-id="source-control-pull-result-modal-close"
					@click="close"
				/>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.list {
	list-style: none;
	margin: 0;
	padding: 0;
	max-height: 360px;
	overflow-y: auto;
}

.item {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	padding: var(--spacing--2xs) 0;
	border-bottom: var(--border);
}

.error {
	word-break: break-word;
}

.empty {
	padding: var(--spacing--l) 0;
	text-align: center;
}

.footer {
	display: flex;
	justify-content: flex-end;
}
</style>
