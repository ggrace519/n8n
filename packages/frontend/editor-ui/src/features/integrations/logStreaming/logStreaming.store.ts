import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';

import { EnterpriseEditionFeature } from '@/app/constants';
import * as logStreamingApi from './logStreaming.api';
import type { MessageEventBusDestinationOptions } from './logStreaming.types';

export const useLogStreamingStore = defineStore('logStreaming', () => {
	const rootStore = useRootStore();
	const settingsStore = useSettingsStore();

	/** Configured destinations, keyed by their server-assigned id. */
	const items = ref<Record<string, MessageEventBusDestinationOptions>>({});

	const destinations = computed<MessageEventBusDestinationOptions[]>(() =>
		Object.values(items.value),
	);

	const hasDestinations = computed(() => destinations.value.length > 0);

	const isEnterpriseLogStreamingEnabled = computed(
		() => settingsStore.isEnterpriseFeatureEnabled[EnterpriseEditionFeature.LogStreaming],
	);

	/** Whether destinations are locked because they are managed via env vars. */
	const isManagedByEnv = computed(() => settingsStore.settings.logStreaming?.managedByEnv ?? false);

	function setItem(destination: MessageEventBusDestinationOptions) {
		if (!destination.id) return;
		items.value = { ...items.value, [destination.id]: destination };
	}

	function removeItem(id: string) {
		const next = { ...items.value };
		delete next[id];
		items.value = next;
	}

	function clear() {
		items.value = {};
	}

	async function fetchDestinations(): Promise<MessageEventBusDestinationOptions[]> {
		const data = await logStreamingApi.getDestinations(rootStore.restApiContext);
		const next: Record<string, MessageEventBusDestinationOptions> = {};
		for (const destination of data) {
			if (destination.id) next[destination.id] = destination;
		}
		items.value = next;
		return data;
	}

	async function saveDestination(
		destination: MessageEventBusDestinationOptions,
	): Promise<MessageEventBusDestinationOptions> {
		const saved = await logStreamingApi.saveDestination(rootStore.restApiContext, destination);
		setItem(saved);
		return saved;
	}

	async function deleteDestination(id: string): Promise<void> {
		await logStreamingApi.deleteDestination(rootStore.restApiContext, id);
		removeItem(id);
	}

	async function sendTestMessage(id: string): Promise<boolean> {
		return await logStreamingApi.sendTestMessage(rootStore.restApiContext, id);
	}

	return {
		items,
		destinations,
		hasDestinations,
		isEnterpriseLogStreamingEnabled,
		isManagedByEnv,
		fetchDestinations,
		saveDestination,
		deleteDestination,
		sendTestMessage,
		clear,
	};
});
