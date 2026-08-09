<script lang="ts" setup>
import { useI18n } from '@n8n/i18n';
import { VIEWS } from '@/app/constants';
import { I18nT } from 'vue-i18n';
import { RouterLink } from 'vue-router';

const i18n = useI18n();
</script>

<template>
	<I18nT keypath="settings.sourceControl.connection.error.message" tag="span" scope="global">
		<template #link>
			<RouterLink :to="{ name: VIEWS.SOURCE_CONTROL }" data-test-id="source-control-error-link">
				{{ i18n.baseText('settings.sourceControl.connection.error.link') }}
			</RouterLink>
		</template>
	</I18nT>
</template>
