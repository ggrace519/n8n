import type { AiBuilderChatRequestDto } from '@n8n/api-types';

// The wire payload as validated by the controller. `ChatPayload` is the
// server-side shape the builder consumes, which renames `text` -> `message`
// and drops transport-only fields, so derive from the DTO to stay in lockstep.
type BuilderRequestPayload = AiBuilderChatRequestDto['payload'];

/**
 * Input to a single builder turn. Assembled by the `/ai/build` controller from
 * the validated request DTO plus the current workflow `versionId`.
 */
export interface ChatPayload {
	/** Client-generated id of the user message. */
	id: BuilderRequestPayload['id'];
	/** The user's message text. */
	message: BuilderRequestPayload['text'];
	/** Editor context: the current workflow, execution data/schema, selections. */
	workflowContext: BuilderRequestPayload['workflowContext'];
	/** Per-request feature toggles. */
	featureFlags?: BuilderRequestPayload['featureFlags'];
	/** Current workflow version id, for restore/anchoring. */
	versionId?: BuilderRequestPayload['versionId'];
	/** `plan` for plan-first, `build` for direct generation. */
	mode?: BuilderRequestPayload['mode'];
	/** Opaque payload resuming an interrupted (e.g. plan-approval) turn. */
	resumeData?: BuilderRequestPayload['resumeData'];
}

/**
 * One streamed builder response chunk. The transport writes each chunk as a
 * separator-delimited JSON object; the message union is intentionally loose
 * here (the builder agent owns the concrete message shapes).
 */
export interface BuilderChatResponse {
	sessionId?: string;
	messages: unknown[];
}

/**
 * A stored builder session as returned by `/ai/sessions` (history replay).
 * Keyed on `workflowId` by the storage layer; `sessionId` is an informational
 * thread id surfaced to the client.
 */
export interface BuilderSessionSummary {
	sessionId: string;
	messages: unknown[];
	/** ISO timestamp of the last update. */
	lastUpdated: string;
	activeVersionCardId?: string | null;
	resumeAfterRestoreMessageId?: string | null;
}
