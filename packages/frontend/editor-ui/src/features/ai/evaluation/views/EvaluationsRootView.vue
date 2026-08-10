<script setup lang="ts">
defineOptions({ name: 'EvaluationsRootView' });

// Layout shell for the evaluation surface. The concrete screens (list, run
// detail, collection comparison) are rendered through the nested router-view.
defineProps<{
	workflowId?: string;
}>();
</script>

<template>
	<div :class="$style.container" data-test-id="evaluations-root-view">
		<RouterView />
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	height: 100%;
	width: 100%;
	overflow: auto;
	background: var(--color--background--light-2);
}
</style>
