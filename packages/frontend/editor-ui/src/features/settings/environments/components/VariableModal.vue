<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';

import Modal from '@/app/components/Modal.vue';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import {
	N8nButton,
	N8nIcon,
	N8nInput,
	N8nInputLabel,
	N8nOption,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import type { IconOrEmoji } from '@n8n/design-system';

import { useEnvironmentsStore } from '../environments.store';
import {
	NEW_VARIABLE_KEY_REGEX,
	VARIABLE_KEY_MAX_LENGTH,
	VARIABLE_MODAL_KEY,
	VARIABLE_VALUE_MAX_LENGTH,
} from '../environments.constants';
import type { EnvironmentVariable } from '../environments.types';

const props = withDefaults(
	defineProps<{
		mode?: 'new' | 'edit';
		variable?: EnvironmentVariable;
		projectId?: string;
	}>(),
	{
		mode: 'new',
		variable: undefined,
		projectId: undefined,
	},
);

const i18n = useI18n();
const { showError, showMessage } = useToast();
const uiStore = useUIStore();
const environmentsStore = useEnvironmentsStore();
const projectsStore = useProjectsStore();

const GLOBAL_SCOPE = 'global';

const key = ref(props.variable?.key ?? '');
const value = ref(props.variable?.value ?? '');
const scope = ref<string>(props.variable?.project?.id ?? props.projectId ?? GLOBAL_SCOPE);
const isSaving = ref(false);

const isEditMode = computed(() => props.mode === 'edit');

const title = computed(() =>
	isEditMode.value
		? i18n.baseText('variables.modal.title.edit')
		: i18n.baseText('variables.modal.title.create'),
);

const scopeOptions = computed<Array<{ value: string; label: string; icon: IconOrEmoji }>>(() => {
	const options: Array<{ value: string; label: string; icon: IconOrEmoji }> = [
		{
			value: GLOBAL_SCOPE,
			label: i18n.baseText('variables.modal.scope.global'),
			icon: { type: 'icon', value: 'database' },
		},
	];

	options.push(
		...projectsStore.availableProjects
			.filter((project) => project.type !== 'personal')
			.map((project) => ({
				value: project.id,
				label: project.name ?? project.id,
				icon: (project.icon ?? { type: 'icon' as const, value: 'layer-group' }) as IconOrEmoji,
			})),
	);

	return options;
});

const keyError = computed<string | null>(() => {
	if (!key.value) return null;
	if (/^\d/.test(key.value)) {
		return i18n.baseText('variables.editing.key.error.regex-no-start-with-number');
	}
	if (!NEW_VARIABLE_KEY_REGEX.test(key.value)) {
		return i18n.baseText('variables.editing.key.error.regex');
	}
	return null;
});

/**
 * When a project-scoped variable reuses a key that exists globally it shadows
 * the global one — surface that as an informational warning, not an error.
 */
const globalKeyExistsWarning = computed<string | null>(() => {
	if (scope.value === GLOBAL_SCOPE || !key.value) return null;
	const globalExists = environmentsStore.variables.some((v) => !v.project && v.key === key.value);
	return globalExists ? i18n.baseText('variables.modal.warning.globalKeyExists') : null;
});

const isValid = computed(() => Boolean(key.value) && !keyError.value);

function closeModal() {
	uiStore.closeModal(VARIABLE_MODAL_KEY);
}

async function onSave() {
	if (!isValid.value || isSaving.value) return;

	isSaving.value = true;
	const projectId = scope.value === GLOBAL_SCOPE ? undefined : scope.value;

	try {
		if (isEditMode.value && props.variable) {
			await environmentsStore.updateVariable({
				id: props.variable.id,
				key: key.value,
				value: value.value,
				projectId: projectId ?? null,
			});
		} else {
			await environmentsStore.createVariable({
				key: key.value,
				value: value.value,
				projectId,
			});
		}
		showMessage({
			title: i18n.baseText('saveButton.saved'),
			type: 'success',
		});
		closeModal();
	} catch (error) {
		showError(error, i18n.baseText('variables.errors.save'));
	} finally {
		isSaving.value = false;
	}
}
</script>

<template>
	<Modal
		:name="VARIABLE_MODAL_KEY"
		:title="title"
		:center="true"
		width="480px"
		data-test-id="variable-modal"
	>
		<template #content>
			<div :class="$style.content">
				<div>
					<N8nInputLabel :label="i18n.baseText('variables.modal.key.label')" :bold="false">
						<N8nInput
							v-model="key"
							:maxlength="VARIABLE_KEY_MAX_LENGTH"
							:placeholder="i18n.baseText('variables.editing.key.placeholder')"
							:state="keyError ? 'error' : 'default'"
							data-test-id="variable-modal-key-input"
						/>
					</N8nInputLabel>
					<N8nText v-if="keyError" :class="$style.error" color="danger" size="small">
						{{ keyError }}
					</N8nText>
				</div>

				<div>
					<N8nInputLabel :label="i18n.baseText('variables.modal.value.label')" :bold="false">
						<N8nInput
							v-model="value"
							type="textarea"
							:maxlength="VARIABLE_VALUE_MAX_LENGTH"
							:placeholder="i18n.baseText('variables.editing.value.placeholder')"
							data-test-id="variable-modal-value-input"
						/>
					</N8nInputLabel>
				</div>

				<div>
					<N8nInputLabel :label="i18n.baseText('variables.modal.scope.label')" :bold="false">
						<N8nSelect
							v-model="scope"
							size="large"
							:teleported="false"
							data-test-id="variable-modal-scope-select"
						>
							<N8nOption
								v-for="option in scopeOptions"
								:key="option.value"
								:value="option.value"
								:label="option.label"
							>
								<div :class="$style.optionContent">
									<N8nText v-if="option.icon.type === 'emoji'" :class="$style.emoji">
										{{ option.icon.value }}
									</N8nText>
									<N8nIcon v-else-if="option.icon.value" :icon="option.icon.value" />
									<span>{{ option.label }}</span>
								</div>
							</N8nOption>
						</N8nSelect>
					</N8nInputLabel>
					<N8nText v-if="globalKeyExistsWarning" :class="$style.warning" size="small">
						{{ globalKeyExistsWarning }}
					</N8nText>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton variant="subtle" data-test-id="variable-modal-cancel-button" @click="closeModal">
					{{ i18n.baseText('variables.modal.button.cancel') }}
				</N8nButton>
				<N8nButton
					variant="solid"
					:loading="isSaving"
					:disabled="!isValid"
					data-test-id="variable-modal-save-button"
					@click="onSave"
				>
					{{ i18n.baseText('variables.modal.button.save') }}
				</N8nButton>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.error {
	display: block;
	margin-top: var(--spacing--3xs);
}

.warning {
	display: block;
	margin-top: var(--spacing--3xs);
	color: var(--color--warning);
}

.optionContent {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.emoji {
	font-size: var(--font-size--sm);
	line-height: 1;
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
