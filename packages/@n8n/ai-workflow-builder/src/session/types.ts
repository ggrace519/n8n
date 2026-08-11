import type { BaseMessage } from '@langchain/core/messages';

/**
 * A single chat message in a builder conversation. Backed by LangChain's
 * `BaseMessage`, whose instances expose a `_getType()` discriminator — the
 * property `isLangchainMessagesArray` checks for.
 */
export type LangchainMessage = BaseMessage;

/**
 * A persisted builder session, keyed (by the storage implementation) on the
 * builder thread id. Mirrors the columns the session repository reads/writes.
 */
export interface StoredSession {
	/** Ordered conversation history. */
	messages: LangchainMessage[];
	/** Rolling summary of older, compacted turns. */
	previousSummary?: string;
	/** Last write time; set by the storage layer, present on read. */
	updatedAt: Date;
	/** Version card the session is currently anchored to, if any. */
	activeVersionCardId?: string | null;
	/** Message to resume from after a workflow-version restore, if any. */
	resumeAfterRestoreMessageId?: string | null;
}

/**
 * Persistence contract for builder sessions. Implemented by the CLI's
 * `WorkflowBuilderSessionRepository`; consumed by the builder service.
 */
export interface ISessionStorage {
	getSession(threadId: string): Promise<StoredSession | null>;
	saveSession(threadId: string, data: StoredSession): Promise<void>;
	deleteSession(threadId: string): Promise<void>;
}
