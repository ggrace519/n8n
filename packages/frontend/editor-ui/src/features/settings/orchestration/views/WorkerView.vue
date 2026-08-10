<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { N8nEmptyState, N8nHeading, N8nText } from '@n8n/design-system';

import { useOrchestrationStore } from '@/features/settings/orchestration/orchestration.store';
import WorkerCard from '@/features/settings/orchestration/components/WorkerCard.vue';

const i18n = useI18n();
const documentTitle = useDocumentTitle();
const pageRedirectionHelper = usePageRedirectionHelper();
const orchestrationStore = useOrchestrationStore();

const isLicensed = computed(() => orchestrationStore.isWorkerViewLicensed);
const workers = computed(() => orchestrationStore.sortedWorkers);
const hasWorkers = computed(() => orchestrationStore.hasWorkers);

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('worker-view', 'upgrade-worker-view');
}

onMounted(() => {
	documentTitle.set(i18n.baseText('workerList.pageTitle'));
	if (!isLicensed.value) return;
	orchestrationStore.startWorkerStatusPolling();
});

onBeforeUnmount(() => {
	orchestrationStore.stopWorkerStatusPolling();
	orchestrationStore.reset();
});
</script>

<template>
	<div :class="$style.container" data-test-id="worker-view">
		<N8nHeading tag="h1" size="2xlarge">
			{{ i18n.baseText('workerList.pageTitle') }}
		</N8nHeading>

		<N8nEmptyState
			v-if="!isLicensed"
			:description="i18n.baseText('workerList.actionBox.description')"
			:button-text="i18n.baseText('workerList.actionBox.buttonText')"
			data-test-id="worker-view-unlicensed"
			@click:button="goToUpgrade"
		>
			<template #heading>
				<span>{{ i18n.baseText('workerList.actionBox.title') }}</span>
			</template>
		</N8nEmptyState>

		<template v-else>
			<N8nText
				v-if="!hasWorkers"
				color="text-light"
				:class="$style.empty"
				data-test-id="worker-view-empty"
			>
				{{ i18n.baseText('workerList.empty') }}
			</N8nText>

			<div v-else :class="$style.list" data-test-id="worker-view-list">
				<WorkerCard
					v-for="worker in workers"
					:key="worker.senderId"
					:worker="worker"
					:last-updated="orchestrationStore.getWorkerLastUpdated(worker.senderId)"
				/>
			</div>
		</template>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--l);
	padding-bottom: var(--spacing--2xl);
}

.empty {
	padding: var(--spacing--l);
	border: var(--border);
	border-radius: var(--radius--md);
	background-color: var(--background--surface);
	text-align: center;
}

.list {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--s);
}
</style>
