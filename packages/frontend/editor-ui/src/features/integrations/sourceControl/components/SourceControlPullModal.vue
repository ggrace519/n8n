<script lang="ts" setup>
import { ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useLoadingService } from '@/app/composables/useLoadingService';
import type { EventBus } from '@n8n/utils/event-bus';
import type { SourceControlledFile } from '@n8n/api-types';
import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useSourceControlStore } from '@/features/integrations/sourceControl/sourceControl.store';
import { sourceControlEventBus } from '@/features/integrations/sourceControl/sourceControl.eventBus';
import {
	SOURCE_CONTROL_PULL_MODAL_KEY,
	SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
} from '@/features/integrations/sourceControl/sourceControl.constants';
import type { PullWorkfolderPayload } from '@/features/integrations/sourceControl/sourceControl.api';
import {
	N8nButton,
	N8nHeading,
	N8nLink,
	N8nRadioButtons,
	N8nText,
	useMessage,
} from '@n8n/design-system';

type AutoPublishMode = NonNullable<PullWorkfolderPayload['autoPublish']>;

const props = defineProps<{
	modalName: string;
	data: {
		eventBus?: EventBus;
	};
}>();

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const loadingService = useLoadingService();
const uiStore = useUIStore();
const sourceControlStore = useSourceControlStore();

const submitting = ref(false);
const autoPublish = ref<AutoPublishMode>('none');

const autoPublishOptions: Array<{ label: string; value: AutoPublishMode }> = [
	{
		label: i18n.baseText('settings.sourceControl.modals.pull.autoPublish.options.off'),
		value: 'none',
	},
	{
		label: i18n.baseText('settings.sourceControl.modals.pull.autoPublish.options.on'),
		value: 'all',
	},
	{
		label: i18n.baseText('settings.sourceControl.modals.pull.autoPublish.options.published'),
		value: 'published',
	},
];

function close() {
	uiStore.closeModal(SOURCE_CONTROL_PULL_MODAL_KEY);
}

function isConflictError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'httpStatusCode' in error &&
		(error as { httpStatusCode?: number }).httpStatusCode === 409
	);
}

function openResultModal(files: SourceControlledFile[]) {
	uiStore.openModalWithData({
		name: SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
		data: { files },
	});
}

async function runPull(force: boolean) {
	const files = await sourceControlStore.pullWorkfolder({
		force,
		autoPublish: autoPublish.value,
	});
	sourceControlEventBus.emit('pull', undefined);
	close();
	if (autoPublish.value !== 'none') {
		openResultModal(files);
	} else {
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.pull.success.title'),
			message: i18n.baseText('settings.sourceControl.pull.success.description', {
				adjustToNumber: files.length,
			}),
			type: 'success',
		});
	}
}

async function pull() {
	submitting.value = true;
	loadingService.startLoading(i18n.baseText('settings.sourceControl.loading.pull'));
	try {
		await runPull(false);
	} catch (error) {
		if (isConflictError(error)) {
			loadingService.stopLoading();
			const confirmed = await message.confirm(
				i18n.baseText('settings.sourceControl.modals.pull.description'),
				i18n.baseText('settings.sourceControl.modals.pull.title'),
				{
					confirmButtonText: i18n.baseText('settings.sourceControl.modals.pull.buttons.pull'),
					cancelButtonText: i18n.baseText('settings.sourceControl.modals.pull.buttons.cancel'),
				},
			);
			if (confirmed === 'confirm') {
				loadingService.startLoading(i18n.baseText('settings.sourceControl.loading.pull'));
				try {
					await runPull(true);
				} catch (forceError) {
					toast.showError(forceError, i18n.baseText('error'));
				}
			}
		} else {
			toast.showError(error, i18n.baseText('error'));
		}
	} finally {
		submitting.value = false;
		loadingService.stopLoading();
	}
}
</script>

<template>
	<Modal width="600px" :name="props.modalName" data-test-id="source-control-pull-modal">
		<template #header>
			<N8nHeading tag="h1" size="xlarge">
				{{ i18n.baseText('settings.sourceControl.modals.pull.title') }}
			</N8nHeading>
		</template>
		<template #content>
			<div :class="$style.container">
				<N8nText>
					{{ i18n.baseText('settings.sourceControl.modals.pull.description') }}
					<N8nLink
						:to="i18n.baseText('settings.sourceControl.docs.using.pushPull.url')"
						size="small"
						:new-window="true"
					>
						{{ i18n.baseText('settings.sourceControl.modals.pull.description.learnMore') }}
					</N8nLink>
				</N8nText>

				<div :class="$style.autoPublish">
					<N8nText tag="h3" size="medium" bold>
						{{ i18n.baseText('settings.sourceControl.modals.pull.autoPublish.title') }}
					</N8nText>
					<N8nRadioButtons
						v-model="autoPublish"
						:options="autoPublishOptions"
						data-test-id="source-control-pull-modal-auto-publish"
					/>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					variant="ghost"
					:label="i18n.baseText('settings.sourceControl.modals.pull.buttons.cancel')"
					data-test-id="source-control-pull-modal-cancel"
					@click="close"
				/>
				<N8nButton
					:loading="submitting"
					:label="i18n.baseText('settings.sourceControl.modals.pull.buttons.pull')"
					data-test-id="source-control-pull-modal-submit"
					@click="pull"
				/>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--m);
}

.autoPublish {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--xs);
}
</style>
