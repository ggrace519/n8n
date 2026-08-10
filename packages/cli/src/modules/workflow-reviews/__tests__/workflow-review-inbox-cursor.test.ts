import { BadRequestError } from '@/errors/response-errors/bad-request.error';

import { decodeInboxCursor, encodeInboxCursor } from '../workflow-review-inbox-cursor';

describe('workflow review inbox cursor', () => {
	it('round-trips a keyset position', () => {
		const position = { createdAt: new Date('2026-02-03T04:05:06.789Z'), id: 'abc123' };

		const decoded = decodeInboxCursor(encodeInboxCursor(position));

		expect(decoded.id).toBe('abc123');
		expect(decoded.createdAt.toISOString()).toBe('2026-02-03T04:05:06.789Z');
	});

	it('encodes to url-safe base64 within the DTO length limit', () => {
		const cursor = encodeInboxCursor({ createdAt: new Date(), id: 'x'.repeat(36) });

		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(cursor.length).toBeLessThanOrEqual(256);
	});

	it.each([
		['not base64 json', 'not-a-cursor'],
		['valid base64 that is not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
		['JSON without the required fields', Buffer.from('{"a":1}', 'utf8').toString('base64url')],
		[
			'an unparseable timestamp',
			Buffer.from('{"c":"nonsense","i":"id"}', 'utf8').toString('base64url'),
		],
	])('rejects %s', (_label, cursor) => {
		expect(() => decodeInboxCursor(cursor)).toThrow(BadRequestError);
	});
});
