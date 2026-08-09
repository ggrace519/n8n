<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { I18nT } from 'vue-i18n';
import { useToast } from '@n8n/composables/useToast';
import { useLoadingService } from '@/app/composables/useLoadingService';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';
import { useSourceControlStore } from '@/features/integrations/sourceControl/sourceControl.store';
import { SSH_KEY_TYPES } from '@/features/integrations/sourceControl/sourceControl.constants';
import type { SshKeyType } from '@/features/integrations/sourceControl/sourceControl.types';
import CopyInput from '@/app/components/CopyInput.vue';
import {
	N8nButton,
	N8nCheckbox,
	N8nColorPicker,
	N8nEmptyState,
	N8nHeading,
	N8nInput,
	N8nInputLabel,
	N8nLink,
	N8nOption,
	N8nSelect,
	N8nText,
	N8nTooltip,
	useMessage,
} from '@n8n/design-system';

const i18n = useI18n();
const toast = useToast();
const loadingService = useLoadingService();
const documentTitle = useDocumentTitle();
const message = useMessage();
const pageRedirectionHelper = usePageRedirectionHelper();
const sourceControlStore = useSourceControlStore();

const branches = ref<string[]>([]);
const loadingBranches = ref(false);
const saving = ref(false);

const form = reactive({
	repositoryUrl: '',
	branchName: '',
	branchColor: sourceControlStore.preferences.branchColor,
	branchReadOnly: false,
	keyGeneratorType: (sourceControlStore.preferences.keyGeneratorType ?? 'ed25519') as SshKeyType,
});

const isEnabled = computed(() => sourceControlStore.isEnterpriseSourceControlEnabled);
const isConnected = computed(() => sourceControlStore.preferences.connected);
const publicKey = computed(() => sourceControlStore.preferences.publicKey ?? '');
const repoUrlValid = computed(() => form.repositoryUrl.trim().length > 0);

function syncFormFromStore() {
	const preferences = sourceControlStore.preferences;
	form.repositoryUrl = preferences.repositoryUrl;
	form.branchName = preferences.branchName;
	form.branchColor = preferences.branchColor;
	form.branchReadOnly = preferences.branchReadOnly;
	form.keyGeneratorType = preferences.keyGeneratorType ?? 'ed25519';
}

async function loadBranches() {
	loadingBranches.value = true;
	try {
		const result = await sourceControlStore.getBranches();
		branches.value = result.branches;
		if (result.currentBranch) {
			form.branchName = result.currentBranch;
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.refreshBranches.error'));
	} finally {
		loadingBranches.value = false;
	}
}

async function onConnect() {
	if (!repoUrlValid.value) return;
	saving.value = true;
	loadingService.startLoading(i18n.baseText('settings.sourceControl.loading.connecting'));
	try {
		await sourceControlStore.savePreferences({
			repositoryUrl: form.repositoryUrl.trim(),
			keyGeneratorType: form.keyGeneratorType,
		});
		syncFormFromStore();
		await loadBranches();
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.toast.connected.title'),
			message: i18n.baseText('settings.sourceControl.toast.connected.message'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.toast.connected.error'));
	} finally {
		saving.value = false;
		loadingService.stopLoading();
	}
}

async function onSave() {
	saving.value = true;
	try {
		await sourceControlStore.updatePreferences({
			branchName: form.branchName,
			branchColor: form.branchColor,
			branchReadOnly: form.branchReadOnly,
		});
		syncFormFromStore();
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.saved.title'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.saved.error'));
	} finally {
		saving.value = false;
	}
}

async function onDisconnect() {
	const confirmed = await message.confirm(
		i18n.baseText('settings.sourceControl.modals.disconnect.message'),
		i18n.baseText('settings.sourceControl.modals.disconnect.title'),
		{
			confirmButtonText: i18n.baseText('settings.sourceControl.modals.disconnect.confirm'),
			cancelButtonText: i18n.baseText('settings.sourceControl.modals.disconnect.cancel'),
		},
	);
	if (confirmed !== 'confirm') return;

	loadingService.startLoading();
	try {
		await sourceControlStore.disconnect(true);
		branches.value = [];
		syncFormFromStore();
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.toast.disconnected.title'),
			message: i18n.baseText('settings.sourceControl.toast.disconnected.message'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.toast.disconnected.error'));
	} finally {
		loadingService.stopLoading();
	}
}

async function onRefreshSshKey() {
	const confirmed = await message.confirm(
		i18n.baseText('settings.sourceControl.modals.refreshSshKey.message'),
		i18n.baseText('settings.sourceControl.modals.refreshSshKey.title'),
		{
			confirmButtonText: i18n.baseText('settings.sourceControl.modals.refreshSshKey.confirm'),
			cancelButtonText: i18n.baseText('settings.sourceControl.modals.refreshSshKey.cancel'),
		},
	);
	if (confirmed !== 'confirm') return;

	loadingService.startLoading();
	try {
		await sourceControlStore.generateKeyPair(form.keyGeneratorType);
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.refreshSshKey.successful.title'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.sourceControl.refreshSshKey.error.title'));
	} finally {
		loadingService.stopLoading();
	}
}

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('source-control', 'upgrade-source-control');
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.sourceControl.title'));
	if (!isEnabled.value) return;

	loadingService.startLoading();
	try {
		await sourceControlStore.getPreferences();
		syncFormFromStore();
		if (isConnected.value) {
			await loadBranches();
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	} finally {
		loadingService.stopLoading();
	}
});
</script>

<template>
	<div class="pb-3xl">
		<N8nHeading size="2xlarge" tag="h1">
			{{ i18n.baseText('settings.sourceControl.title') }}
		</N8nHeading>

		<N8nText tag="p" :class="$style.description">
			<I18nT keypath="settings.sourceControl.description" tag="span" scope="global">
				<template #link>
					<N8nLink :to="i18n.baseText('settings.sourceControl.docs.url')" :new-window="true">
						{{ i18n.baseText('settings.sourceControl.description.link') }}
					</N8nLink>
				</template>
			</I18nT>
		</N8nText>

		<N8nEmptyState
			v-if="!isEnabled"
			:description="i18n.baseText('settings.sourceControl.actionBox.description')"
			:button-text="i18n.baseText('settings.sourceControl.actionBox.buttonText')"
			data-test-id="source-control-content-unlicensed"
			@click:button="goToUpgrade"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.sourceControl.actionBox.title') }}</span>
			</template>
		</N8nEmptyState>

		<div v-else :class="$style.content" data-test-id="source-control-content-licensed">
			<!-- Git configuration -->
			<section :class="$style.section">
				<N8nHeading size="large" tag="h2" :class="$style.sectionTitle">
					{{ i18n.baseText('settings.sourceControl.gitConfig') }}
				</N8nHeading>

				<N8nInputLabel
					:label="i18n.baseText('settings.sourceControl.sshKey')"
					:class="$style.field"
				>
					<div :class="$style.sshKeyRow">
						<N8nSelect
							v-model="form.keyGeneratorType"
							:disabled="isConnected"
							size="medium"
							:class="$style.keyType"
							data-test-id="source-control-ssh-key-type-select"
						>
							<N8nOption
								v-for="keyType in SSH_KEY_TYPES"
								:key="keyType"
								:value="keyType"
								:label="keyType"
							/>
						</N8nSelect>
						<CopyInput
							:value="publicKey"
							:copy-button-text="i18n.baseText('generic.copy')"
							:class="$style.sshKeyValue"
							data-test-id="source-control-ssh-key"
						/>
						<N8nButton
							variant="outline"
							:label="i18n.baseText('settings.sourceControl.refreshSshKey')"
							data-test-id="source-control-refresh-ssh-key-button"
							@click="onRefreshSshKey"
						/>
					</div>
					<N8nText size="small" color="text-light">
						<I18nT keypath="settings.sourceControl.sshKeyDescription" tag="span" scope="global">
							<template #link>
								<N8nLink
									:to="i18n.baseText('settings.sourceControl.docs.setup.ssh.url')"
									size="small"
									:new-window="true"
								>
									{{ i18n.baseText('settings.sourceControl.sshKeyDescriptionLink') }}
								</N8nLink>
							</template>
						</I18nT>
					</N8nText>
				</N8nInputLabel>

				<N8nInputLabel
					:label="i18n.baseText('settings.sourceControl.repoUrl')"
					:class="$style.field"
				>
					<div :class="$style.repoRow">
						<N8nInput
							v-model="form.repositoryUrl"
							:disabled="isConnected"
							:placeholder="i18n.baseText('settings.sourceControl.repoUrlPlaceholder')"
							data-test-id="source-control-repo-url-input"
						/>
						<N8nButton
							v-if="!isConnected"
							:disabled="!repoUrlValid || saving"
							:loading="saving"
							:label="i18n.baseText('settings.sourceControl.button.connect')"
							data-test-id="source-control-connect-button"
							@click="onConnect"
						/>
					</div>
				</N8nInputLabel>
			</section>

			<!-- Instance settings (only when connected) -->
			<section v-if="isConnected" :class="$style.section">
				<N8nHeading size="large" tag="h2" :class="$style.sectionTitle">
					{{ i18n.baseText('settings.sourceControl.instanceSettings') }}
				</N8nHeading>

				<N8nInputLabel
					:label="i18n.baseText('settings.sourceControl.branches')"
					:class="$style.field"
				>
					<div :class="$style.branchRow">
						<N8nSelect
							v-model="form.branchName"
							:loading="loadingBranches"
							size="medium"
							:class="$style.branchSelect"
							data-test-id="source-control-branch-select"
						>
							<N8nOption v-for="branch in branches" :key="branch" :value="branch" :label="branch" />
						</N8nSelect>
						<N8nTooltip :content="i18n.baseText('settings.sourceControl.refreshBranches.tooltip')">
							<N8nButton
								variant="outline"
								icon="refresh-cw"
								icon-only
								:loading="loadingBranches"
								data-test-id="source-control-refresh-branches-button"
								:aria-label="i18n.baseText('settings.sourceControl.refreshBranches.tooltip')"
								@click="loadBranches"
							/>
						</N8nTooltip>
					</div>
				</N8nInputLabel>

				<N8nInputLabel :label="i18n.baseText('settings.sourceControl.color')" :class="$style.field">
					<N8nColorPicker
						v-model="form.branchColor"
						:show-input="false"
						data-test-id="source-control-branch-color"
					/>
				</N8nInputLabel>

				<div :class="$style.field">
					<N8nCheckbox v-model="form.branchReadOnly" data-test-id="source-control-branch-read-only">
						<I18nT keypath="settings.sourceControl.protected" tag="span" scope="global">
							<template #bold>
								<strong>{{ i18n.baseText('settings.sourceControl.protected.bold') }}</strong>
							</template>
						</I18nT>
					</N8nCheckbox>
				</div>

				<div :class="$style.actions">
					<N8nButton
						variant="ghost"
						:label="i18n.baseText('settings.sourceControl.button.disconnect')"
						data-test-id="source-control-disconnect-button"
						@click="onDisconnect"
					/>
					<N8nButton
						:loading="saving"
						:label="i18n.baseText('settings.sourceControl.button.save')"
						data-test-id="source-control-save-settings-button"
						@click="onSave"
					/>
				</div>
			</section>
		</div>
	</div>
</template>

<style lang="scss" module>
.description {
	margin: var(--spacing--2xs) 0 var(--spacing--xl);
	color: var(--color--text--shade-1);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xl);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--m);
}

.sectionTitle {
	margin-bottom: var(--spacing--2xs);
}

.field {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.sshKeyRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.keyType {
	max-width: 120px;
}

.sshKeyValue {
	flex: 1;
	min-width: 0;
}

.repoRow,
.branchRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.repoRow > :first-child,
.branchSelect {
	flex: 1;
	min-width: 0;
}

.actions {
	display: flex;
	justify-content: space-between;
	gap: var(--spacing--xs);
	margin-top: var(--spacing--s);
}
</style>
