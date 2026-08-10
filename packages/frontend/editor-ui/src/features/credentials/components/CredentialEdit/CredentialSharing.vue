<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from '@n8n/i18n';
import type { EventBus } from '@n8n/utils/event-bus';
import type { PermissionsRecord } from '@n8n/permissions';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { N8nInfoTip } from '@n8n/design-system';

import ProjectSharing from '@/features/collaboration/projects/components/ProjectSharing.vue';
import {
	ProjectTypes,
	type ProjectSharingData,
} from '@/features/collaboration/projects/projects.types';
import { useRemoteProjectSearch } from '@/features/collaboration/projects/projects.utils';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import { hasPermission } from '@/app/utils/rbac/permissions';
import type { ICredentialsResponse } from '@/features/credentials/credentials.types';

const props = defineProps<{
	credential: ICredentialsResponse | null;
	credentialData: ICredentialDataDecryptedObject;
	credentialId: string | null;
	credentialPermissions: PermissionsRecord['credential'];
	isSharedGlobally: boolean;
	modalBus: EventBus;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: ProjectSharingData[]];
	'update:shareWithAllUsers': [value: boolean];
}>();

const i18n = useI18n();
const credentialsStore = useCredentialsStore();
const searchFn = useRemoteProjectSearch();

function isProjectSharingData(value: unknown): value is ProjectSharingData {
	return typeof value === 'object' && value !== null && 'id' in value;
}

function isProjectSharingDataArray(value: unknown): value is ProjectSharingData[] {
	return Array.isArray(value) && value.every(isProjectSharingData);
}

const homeProject = computed<ProjectSharingData | undefined>(() => {
	if (props.credential?.homeProject) {
		return props.credential.homeProject;
	}
	return isProjectSharingData(props.credentialData.homeProject)
		? props.credentialData.homeProject
		: undefined;
});

const initialSharedWith = computed<ProjectSharingData[]>(() => {
	if (isProjectSharingDataArray(props.credentialData.sharedWithProjects)) {
		return props.credentialData.sharedWithProjects;
	}
	return props.credential?.sharedWithProjects ?? [];
});

const sharedWith = ref<ProjectSharingData[]>([...initialSharedWith.value]);

const isReadOnly = computed(() => !props.credentialPermissions.share);

const isHomeProjectPersonal = computed(() => homeProject.value?.type === ProjectTypes.Personal);

const canShareGlobally = computed(() =>
	hasPermission(['rbac'], { rbac: { scope: 'credential:shareGlobally' } }),
);

const credentialOwnerName = computed(() =>
	credentialsStore.getCredentialOwnerName(props.credential ?? undefined),
);

// Whoever can change sharing sees the owner-facing info; sharees see the
// read-only note that names who is allowed to change access.
const infoText = computed(() => {
	if (isHomeProjectPersonal.value && !isReadOnly.value) {
		return i18n.baseText('credentialEdit.credentialSharing.info.personalSpaceRestricted');
	}
	if (!isReadOnly.value) {
		return i18n.baseText('credentialEdit.credentialSharing.info.owner');
	}
	if (isHomeProjectPersonal.value) {
		return i18n.baseText('credentialEdit.credentialSharing.info.sharee.personal', {
			interpolate: { credentialOwnerName: credentialOwnerName.value },
		});
	}
	return i18n.baseText('credentialEdit.credentialSharing.info.sharee.team');
});

watch(
	sharedWith,
	(value) => {
		emit('update:modelValue', value);
	},
	{ deep: true },
);

function onShareWithAllUsers(value: boolean) {
	emit('update:shareWithAllUsers', value);
}
</script>

<template>
	<div :class="$style.container" data-test-id="credential-sharing">
		<ProjectSharing
			v-if="!isHomeProjectPersonal"
			v-model="sharedWith"
			:home-project="homeProject"
			:search-fn="searchFn"
			:readonly="isReadOnly"
			:static="isReadOnly"
			:can-share-globally="canShareGlobally"
			:is-shared-globally="isSharedGlobally"
			:placeholder="i18n.baseText('projects.sharing.select.placeholder.project')"
			:empty-options-text="i18n.baseText('projects.sharing.noMatchingProjects')"
			@update:share-with-all-users="onShareWithAllUsers"
		/>
		<N8nInfoTip :bold="false">{{ infoText }}</N8nInfoTip>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
</style>
