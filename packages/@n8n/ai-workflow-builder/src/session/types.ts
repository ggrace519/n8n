import type { BaseMessage } from '@langchain/core/messages';

/**
 * A single turn in a builder conversation, in LangChain's in-memory form.
 *
 * Persisted through LangChain's `mapChatMessagesToStoredMessages` rather than
 * stored directly, so the DB column holds plain serializable objects.
 */
export type LangchainMessage = BaseMessage;

/**
 * One builder conversation as the storage layer hands it back.
 *
 * This is the *server-side* shape. It is deliberately not the `/ai/sessions`
 * response body, which is keyed differently and carries UI message objects
 * instead of LangChain ones — the service maps between the two. Collapsing them
 * would drag UI concerns into the persistence contract.
 */
export interface StoredSession {
	messages: LangchainMessage[];
	/** Rolling summary of turns dropped from the window, if compaction has run. */
	previousSummary?: string;
	updatedAt: Date;
	/** Version card the user restored to; null when no restore has happened. */
	activeVersionCardId?: string | null;
	/** First user message sent after a restore; null until one arrives. */
	resumeAfterRestoreMessageId?: string | null;
}

/**
 * Persistence contract for builder conversations.
 *
 * `threadId` is `workflow-{workflowId}-user-{userId}`, with a `-code` suffix for
 * the code-builder variant — sessions are keyed by workflow and user, never by
 * an opaque session id.
 */
export interface ISessionStorage {
	getSession(threadId: string): Promise<StoredSession | null>;
	saveSession(threadId: string, data: StoredSession): Promise<void>;
	deleteSession(threadId: string): Promise<void>;
}
