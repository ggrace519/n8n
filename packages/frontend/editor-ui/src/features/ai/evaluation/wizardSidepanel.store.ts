import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { STORES } from '@n8n/stores';
import type { IExecutionResponse } from '@/features/execution/executions/executions.types';

/**
 * Ordered steps of the evaluations setup wizard rendered in the focus panel's
 * Tests tab. The values are stable indices so callers can deep-link to a step.
 */
export const EVALUATIONS_WIZARD_STEPS = {
	CHOOSE_SYSTEM: 0,
	SETUP_CHECKS: 1,
	ADD_TEST_CASES: 2,
	RESULTS: 3,
} as const;

export type EvaluationsWizardStep =
	(typeof EVALUATIONS_WIZARD_STEPS)[keyof typeof EVALUATIONS_WIZARD_STEPS];

const FIRST_STEP: EvaluationsWizardStep = EVALUATIONS_WIZARD_STEPS.CHOOSE_SYSTEM;
const LAST_STEP: EvaluationsWizardStep = EVALUATIONS_WIZARD_STEPS.RESULTS;

/**
 * UI state for the evaluations setup wizard shown in the focus side panel.
 *
 * It also carries a "pending seed execution": an execution handed off from the
 * executions page to seed a new test case. The handoff is held here (rather than
 * emitted on the event bus) so it survives the route change to the editor, where
 * the Tests panel that consumes it is mounted.
 */
export const useEvaluationsWizardSidepanelStore = defineStore(
	STORES.EVALUATIONS_WIZARD_SIDEPANEL,
	() => {
		const isOpen = ref(false);
		const currentStep = ref<EvaluationsWizardStep>(FIRST_STEP);
		const pendingSeedExecution = ref<IExecutionResponse | null>(null);

		const canGoBack = computed(() => currentStep.value > FIRST_STEP);
		const canGoNext = computed(() => currentStep.value < LAST_STEP);

		function clampStep(step: number): EvaluationsWizardStep {
			if (step <= FIRST_STEP) return FIRST_STEP;
			if (step >= LAST_STEP) return LAST_STEP;
			return step as EvaluationsWizardStep;
		}

		function open(step: number = FIRST_STEP) {
			currentStep.value = clampStep(step);
			isOpen.value = true;
		}

		function close() {
			isOpen.value = false;
		}

		function goToStep(step: number) {
			currentStep.value = clampStep(step);
		}

		function next() {
			if (canGoNext.value) currentStep.value = clampStep(currentStep.value + 1);
		}

		function back() {
			if (canGoBack.value) currentStep.value = clampStep(currentStep.value - 1);
		}

		function setPendingSeedExecution(execution: IExecutionResponse | null) {
			pendingSeedExecution.value = execution;
		}

		/** Reads and clears the pending seed execution so it is consumed once. */
		function consumePendingSeedExecution(): IExecutionResponse | null {
			const execution = pendingSeedExecution.value;
			pendingSeedExecution.value = null;
			return execution;
		}

		function reset() {
			isOpen.value = false;
			currentStep.value = FIRST_STEP;
			pendingSeedExecution.value = null;
		}

		return {
			isOpen,
			currentStep,
			pendingSeedExecution,
			canGoBack,
			canGoNext,
			open,
			close,
			goToStep,
			next,
			back,
			setPendingSeedExecution,
			consumePendingSeedExecution,
			reset,
		};
	},
);
