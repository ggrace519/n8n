import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { WorkerStatus } from '@n8n/api-types';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';

import { EnterpriseEditionFeature } from '@/app/constants';
import * as orchestrationApi from './orchestration.api';
import { WORKER_STALE_TIMEOUT, WORKER_STATUS_POLL_INTERVAL } from './orchestration.constants';

export const useOrchestrationStore = defineStore('orchestration', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	/** Latest reported status per worker, keyed by the worker's `senderId`. */
	const workers = ref<Record<string, WorkerStatus>>({});
	/** Epoch millis of the last status we ingested for each worker. */
	const workersLastUpdated = ref<Record<string, number>>({});

	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let pruneTimer: ReturnType<typeof setInterval> | undefined;

	const isWorkerViewLicensed = computed(
		() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.WorkerView],
	);

	/** Workers in a stable order so the list does not reshuffle between polls. */
	const sortedWorkers = computed<WorkerStatus[]>(() =>
		Object.values(workers.value).sort((a, b) => a.senderId.localeCompare(b.senderId)),
	);

	const hasWorkers = computed(() => sortedWorkers.value.length > 0);

	function getWorkerLastUpdated(senderId: string): number {
		return workersLastUpdated.value[senderId] ?? 0;
	}

	/**
	 * Ingest a status reply pushed from a worker. Called by the push handler for
	 * `sendWorkerStatusMessage`; the store only listens, it never awaits a body.
	 */
	function updateWorkerStatus(status: WorkerStatus) {
		workers.value = { ...workers.value, [status.senderId]: status };
		workersLastUpdated.value = { ...workersLastUpdated.value, [status.senderId]: Date.now() };
	}

	/** Trigger the fire-and-forget request; replies arrive over the push channel. */
	async function getWorkerStatus() {
		await orchestrationApi.getWorkerStatus(rootStore.restApiContext);
	}

	/** Drop workers that have stopped reporting within the stale window. */
	function removeStaleWorkers() {
		const now = Date.now();
		const nextWorkers: Record<string, WorkerStatus> = {};
		const nextUpdated: Record<string, number> = {};
		for (const [senderId, worker] of Object.entries(workers.value)) {
			if (now - getWorkerLastUpdated(senderId) <= WORKER_STALE_TIMEOUT) {
				nextWorkers[senderId] = worker;
				nextUpdated[senderId] = workersLastUpdated.value[senderId];
			}
		}
		workers.value = nextWorkers;
		workersLastUpdated.value = nextUpdated;
	}

	function reset() {
		workers.value = {};
		workersLastUpdated.value = {};
	}

	/** Begin polling for worker status and pruning stale entries. Idempotent. */
	function startWorkerStatusPolling() {
		if (pollTimer) return;
		void getWorkerStatus();
		pollTimer = setInterval(() => {
			void getWorkerStatus();
		}, WORKER_STATUS_POLL_INTERVAL);
		pruneTimer = setInterval(removeStaleWorkers, WORKER_STATUS_POLL_INTERVAL);
	}

	function stopWorkerStatusPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (pruneTimer) {
			clearInterval(pruneTimer);
			pruneTimer = undefined;
		}
	}

	return {
		workers,
		workersLastUpdated,
		sortedWorkers,
		hasWorkers,
		isWorkerViewLicensed,
		getWorkerLastUpdated,
		updateWorkerStatus,
		getWorkerStatus,
		removeStaleWorkers,
		startWorkerStatusPolling,
		stopWorkerStatusPolling,
		reset,
	};
});
