import { createEventBus } from '@n8n/utils/event-bus';

/**
 * Cross-view event bus for source-control side effects. Emitted after a
 * successful pull so open views (workflows list, node editor, data tables) can
 * refresh their data without a full reload.
 */
export const sourceControlEventBus = createEventBus<{
	pull: undefined;
}>();
