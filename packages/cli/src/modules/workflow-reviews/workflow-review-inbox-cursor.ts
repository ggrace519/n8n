import type { WorkflowReviewInboxCursor } from '@n8n/db';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';

type SerializedCursor = { c: string; i: string };

function isSerializedCursor(value: unknown): value is SerializedCursor {
	if (typeof value !== 'object' || value === null) return false;
	const { c, i } = value as Record<string, unknown>;
	return typeof c === 'string' && typeof i === 'string' && c.length > 0 && i.length > 0;
}

/**
 * Opaque base64url keyset cursor over `(createdAt, id)`. Opaque on purpose: the
 * pair is an implementation detail of the ordering, and clients that parse it
 * would freeze that ordering in place.
 */
export function encodeInboxCursor({ createdAt, id }: WorkflowReviewInboxCursor): string {
	const payload: SerializedCursor = { c: createdAt.toISOString(), i: id };
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeInboxCursor(cursor: string): WorkflowReviewInboxCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
	} catch {
		throw new BadRequestError('Invalid pagination cursor');
	}

	if (!isSerializedCursor(parsed)) {
		throw new BadRequestError('Invalid pagination cursor');
	}

	const createdAt = new Date(parsed.c);
	if (Number.isNaN(createdAt.getTime())) {
		throw new BadRequestError('Invalid pagination cursor');
	}

	return { createdAt, id: parsed.i };
}
