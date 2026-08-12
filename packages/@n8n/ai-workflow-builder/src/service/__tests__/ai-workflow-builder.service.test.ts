import { HumanMessage } from '@langchain/core/messages';
import type { INodeTypeDescription, IUser, Logger } from 'n8n-workflow';

import type { ISessionStorage, StoredSession } from '../../session/types';
import { AiWorkflowBuilderService, buildThreadId } from '../ai-workflow-builder.service';
import { AiBuilderUnavailableError } from '../errors';
import { createPassthroughSsrfGuard } from '../ssrf-guard';

const USER = { id: 'user-1' } as IUser;

const createService = (session: StoredSession | null = null) => {
	const storage: ISessionStorage = {
		getSession: vi.fn().mockResolvedValue(session),
		saveSession: vi.fn().mockResolvedValue(undefined),
		deleteSession: vi.fn().mockResolvedValue(undefined),
	};

	const service = new AiWorkflowBuilderService(
		[],
		storage,
		undefined,
		{ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
		'instance-1',
		'https://n8n.example',
		'2.34.0',
		vi.fn(),
		vi.fn(),
		[],
		() => async () => await Promise.resolve({ results: [] }),
		createPassthroughSsrfGuard(),
		vi.fn(),
	);

	return { service, storage };
};

const sessionWith = (messages = [new HumanMessage('hi')]): StoredSession => ({
	messages,
	updatedAt: new Date('2026-08-11T00:00:00Z'),
});

describe('buildThreadId', () => {
	it('matches the format the session repository parses', () => {
		expect(buildThreadId('wf-1', 'user-1')).toBe('workflow-wf-1-user-user-1');
	});

	it('marks the code-builder variant with a suffix', () => {
		expect(buildThreadId('wf-1', 'user-1', true)).toBe('workflow-wf-1-user-user-1-code');
	});
});

describe('AiWorkflowBuilderService', () => {
	describe('updateNodeTypes', () => {
		it('swaps the catalogue in place', () => {
			const { service } = createService();
			const nodeTypes = [{ name: 'n8n-nodes-base.set' }] as INodeTypeDescription[];

			service.updateNodeTypes(nodeTypes);

			expect(service).toHaveProperty('nodeTypes', nodeTypes);
		});
	});

	/**
	 * The agent is absent from this build. These assertions are the contract that
	 * it fails *loudly*: an empty-but-successful reply here would be
	 * indistinguishable from the agent genuinely having nothing to say, and would
	 * let a future change reintroduce a silent stub without a test noticing.
	 */
	describe('unavailable operations', () => {
		it('chat throws instead of yielding an empty stream', async () => {
			const { service } = createService();

			const iterate = async () => {
				const chunks = [];
				for await (const chunk of service.chat(
					{ id: '1', message: 'build me a workflow', workflowContext: {} },
					USER,
				)) {
					chunks.push(chunk);
				}
				return chunks;
			};

			await expect(iterate()).rejects.toThrow(AiBuilderUnavailableError);
		});

		it('chat fails on iteration, so the failure lands inside the response stream', () => {
			const { service } = createService();

			// Calling it must not throw synchronously: the controller has already
			// sent headers by the time it starts iterating, and only an error raised
			// during iteration gets rendered into the stream.
			expect(() =>
				service.chat({ id: '1', message: 'hi', workflowContext: {} }, USER),
			).not.toThrow();
		});

		it('getBuilderInstanceCredits throws instead of reporting zero credits', async () => {
			const { service } = createService();

			await expect(service.getBuilderInstanceCredits(USER)).rejects.toThrow(
				AiBuilderUnavailableError,
			);
		});

		it('explains itself and names the operation', async () => {
			const { service } = createService();
			let message = '';
			try {
				await service.getBuilderInstanceCredits(USER);
			} catch (error) {
				message = (error as Error).message;
			}

			expect(message).toContain('not available in this build');
			expect(message).toContain('getBuilderInstanceCredits');
		});
	});

	describe('getSessions', () => {
		it('reports no sessions when storage is empty', async () => {
			const { service } = createService(null);

			await expect(service.getSessions('wf-1', USER)).resolves.toEqual({ sessions: [] });
		});

		it('reports no sessions without a workflow id, without hitting storage', async () => {
			const { service, storage } = createService(sessionWith());

			await expect(service.getSessions(undefined, USER)).resolves.toEqual({ sessions: [] });
			expect(storage.getSession).not.toHaveBeenCalled();
		});

		it('looks the session up by workflow and user', async () => {
			const { service, storage } = createService(null);

			await service.getSessions('wf-1', USER);

			expect(storage.getSession).toHaveBeenCalledWith('workflow-wf-1-user-user-1');
		});

		it('distinguishes the code-builder session', async () => {
			const { service, storage } = createService(null);

			await service.getSessions('wf-1', USER, true);

			expect(storage.getSession).toHaveBeenCalledWith('workflow-wf-1-user-user-1-code');
		});

		/**
		 * A conversation carried over from an instance that ran the agent cannot be
		 * rendered without it — the stored turns are in the agent's own encoding.
		 * Returning `[]` would tell the user their history is gone.
		 */
		it('throws rather than hiding a conversation it cannot render', async () => {
			const { service } = createService(sessionWith());

			await expect(service.getSessions('wf-1', USER)).rejects.toThrow(AiBuilderUnavailableError);
		});

		it('treats a stored session with no turns as no session', async () => {
			const { service } = createService(sessionWith([]));

			await expect(service.getSessions('wf-1', USER)).resolves.toEqual({ sessions: [] });
		});
	});

	describe('clearSession', () => {
		it('deletes the conversation', async () => {
			const { service, storage } = createService(sessionWith());

			await service.clearSession('wf-1', USER);

			expect(storage.deleteSession).toHaveBeenCalledWith('workflow-wf-1-user-user-1');
		});
	});

	describe('truncateMessagesAfter', () => {
		it('reports nothing truncated when there is no conversation', async () => {
			const { service } = createService(null);

			await expect(service.truncateMessagesAfter('wf-1', USER, 'msg-1')).resolves.toBe(false);
		});

		it('throws when a conversation exists, rather than silently keeping it whole', async () => {
			const { service } = createService(sessionWith());

			await expect(service.truncateMessagesAfter('wf-1', USER, 'msg-1')).rejects.toThrow(
				AiBuilderUnavailableError,
			);
		});
	});
});

describe('createPassthroughSsrfGuard', () => {
	it('allows any URL', async () => {
		await expect(
			createPassthroughSsrfGuard().validateUrl('http://169.254.169.254/'),
		).resolves.toEqual({ ok: true, result: undefined });
	});

	it('allows any redirect', () => {
		expect(() =>
			createPassthroughSsrfGuard().validateRedirectSync('http://localhost/'),
		).not.toThrow();
	});

	it('hands back a usable lookup function', () => {
		expect(typeof createPassthroughSsrfGuard().createSecureLookup()).toBe('function');
	});
});
