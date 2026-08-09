<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useLoadingService } from '@/app/composables/useLoadingService';
import type { EventBus } from '@n8n/utils/event-bus';
import type { SourceControlledFile } from '@n8n/api-types';
import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useSourceControlStore } from '@/features/integrations/sourceControl/sourceControl.store';
import { SOURCE_CONTROL_PUSH_MODAL_KEY } from '@/features/integrations/sourceControl/sourceControl.constants';
import {
	N8nButton,
	N8nCheckbox,
	N8nHeading,
	N8nInput,
	N8nLink,
	N8nNotice,
	N8nText,
} from '@n8n/design-system';

const props = defineProps<{
	modalName: string;
	data: {
		eventBus?: EventBus;
	};
}>();

const i18n = useI18n();
const toast = useToast();
const loadingService = useLoadingService();
const uiStore = useUIStore();
const sourceControlStore = useSourceControlStore();

const loading = ref(true);
const submitting = ref(false);
const commitMessage = ref('');
const files = ref<SourceControlledFile[]>([]);
const selectedFiles = ref<Set<string>>(new Set());

const hasChanges = computed(() => files.value.length > 0);
const canSubmit = computed(
	() => selectedFiles.value.size > 0 && commitMessage.value.trim().length > 0 && !submitting.value,
);

function fileKey(file: SourceControlledFile): string {
	return `${file.type}:${file.id}`;
}

function isSelected(file: SourceControlledFile): boolean {
	return selectedFiles.value.has(fileKey(file));
}

function toggleFile(file: SourceControlledFile, value: boolean) {
	const key = fileKey(file);
	const next = new Set(selectedFiles.value);
	if (value) {
		next.add(key);
	} else {
		next.delete(key);
	}
	selectedFiles.value = next;
}

function close() {
	uiStore.closeModal(SOURCE_CONTROL_PUSH_MODAL_KEY);
}

async function loadStatus() {
	loading.value = true;
	try {
		const status = await sourceControlStore.getAggregatedStatus({
			direction: 'push',
			preferLocalVersion: true,
			verbose: false,
		});
		files.value = status.filter((file) => file.status !== 'ignored');
		selectedFiles.value = new Set(files.value.map(fileKey));
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
		close();
	} finally {
		loading.value = false;
	}
}

async function commitAndPush() {
	const fileNames = files.value.filter(isSelected);
	if (fileNames.length === 0) return;

	submitting.value = true;
	loadingService.startLoading(i18n.baseText('settings.sourceControl.loading.push'));
	try {
		await sourceControlStore.pushWorkfolder({
			commitMessage: commitMessage.value.trim(),
			fileNames,
		});
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.modals.push.success.title'),
			message: i18n.baseText('settings.sourceControl.modals.push.success.description', {
				adjustToNumber: fileNames.length,
			}),
			type: 'success',
		});
		close();
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	} finally {
		submitting.value = false;
		loadingService.stopLoading();
	}
}

onMounted(loadStatus);
</script>

<template>
	<Modal
		width="812px"
		:name="props.modalName"
		:loading="loading"
		data-test-id="source-control-push-modal"
	>
		<template #header>
			<N8nHeading tag="h1" size="xlarge">
				{{ i18n.baseText('settings.sourceControl.modals.push.title') }}
			</N8nHeading>
		</template>
		<template #content>
			<div :class="$style.container">
				<N8nText>
					{{ i18n.baseText('settings.sourceControl.modals.push.description') }}
					<N8nLink
						:to="i18n.baseText('settings.sourceControl.docs.using.pushPull.url')"
						size="small"
						:new-window="true"
					>
						{{ i18n.baseText('settings.sourceControl.modals.push.description.learnMore') }}
					</N8nLink>
				</N8nText>

				<N8nNotice
					v-if="!hasChanges"
					:class="$style.spaced"
					data-test-id="source-control-push-modal-empty"
				>
					{{ i18n.baseText('settings.sourceControl.modals.push.everythingIsUpToDate') }}
				</N8nNotice>

				<template v-else>
					<N8nText tag="h3" size="medium" bold :class="$style.spaced">
						{{ i18n.baseText('settings.sourceControl.modals.push.filesToCommit') }}
					</N8nText>
					<ul :class="$style.fileList" data-test-id="source-control-push-modal-file-list">
						<li v-for="file in files" :key="fileKey(file)" :class="$style.fileItem">
							<N8nCheckbox
								:label="file.name || file.file"
								:model-value="isSelected(file)"
								@update:model-value="(value: boolean) => toggleFile(file, value)"
							/>
							<N8nText size="small" color="text-light" :class="$style.fileStatus">
								{{ file.status }}
							</N8nText>
						</li>
					</ul>

					<N8nInput
						v-model="commitMessage"
						type="textarea"
						:rows="3"
						:class="$style.spaced"
						:placeholder="
							i18n.baseText('settings.sourceControl.modals.push.commitMessage.placeholder')
						"
						data-test-id="source-control-push-modal-commit"
					/>
				</template>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					variant="ghost"
					:label="i18n.baseText('settings.sourceControl.modals.push.buttons.cancel')"
					data-test-id="source-control-push-modal-cancel"
					@click="close"
				/>
				<N8nButton
					:disabled="!canSubmit"
					:loading="submitting"
					:label="i18n.baseText('settings.sourceControl.modals.push.buttons.save')"
					data-test-id="source-control-push-modal-submit"
					@click="commitAndPush"
				/>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
}

.spaced {
	margin-top: var(--spacing--m);
}

.fileList {
	list-style: none;
	margin: var(--spacing--xs) 0 0;
	padding: 0;
	max-height: 320px;
	overflow-y: auto;
}

.fileItem {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
	padding: var(--spacing--3xs) 0;
}

.fileStatus {
	text-transform: capitalize;
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--xs);
}
</style>
