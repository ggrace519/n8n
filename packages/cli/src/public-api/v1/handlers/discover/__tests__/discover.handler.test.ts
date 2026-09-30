import type { AuthenticatedRequest } from '@n8n/db';
import type { ApiKeyScope } from '@n8n/permissions';
import type { Response } from 'express';

import { UnauthenticatedError } from '@/errors/response-errors/unauthenticated.error';

import * as discoverService from '../discover.service';

// Loaded dynamically (handler routes are arrays of middleware + handler) and
// typed loosely so the suite can invoke individual entries by index.
let handler: Record<string, Array<(...args: unknown[]) => unknown>>;

beforeAll(async () => {
	handler = (await import('../discover.handler.js')) as unknown as typeof handler;
});

const requestWith = (
	apiKeyScopes: ApiKeyScope[] | undefined,
	query: Record<string, string> = {},
): AuthenticatedRequest =>
	({
		query,
		...(apiKeyScopes && { tokenGrant: { apiKeyScopes } }),
	}) as unknown as AuthenticatedRequest;

const emptyDiscoverResponse = (scopes: ApiKeyScope[]) => ({
	scopes,
	resources: {},
	filters: {},
	specUrl: '/api/v1/openapi.yml',
});

describe('Discover Handler', () => {
	let mockResponse: Partial<Response>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockResponse = { json: vi.fn().mockReturnThis() };
	});

	it('should throw UnauthenticatedError when the request carries no token grant', async () => {
		const handlerFn = handler.getDiscover[0];

		await expect(handlerFn(requestWith(undefined), mockResponse)).rejects.toMatchObject({
			message: 'Unauthorized',
			httpStatusCode: 401,
		});
		await expect(handlerFn(requestWith(undefined), mockResponse)).rejects.toBeInstanceOf(
			UnauthenticatedError,
		);
	});

	it("should describe the caller's effective scopes, not the stored key's", async () => {
		const scopes: ApiKeyScope[] = ['tag:list', 'tag:create'];
		vi.spyOn(discoverService, 'buildDiscoverResponse').mockResolvedValue(
			emptyDiscoverResponse(scopes),
		);

		await handler.getDiscover[0](requestWith(scopes), mockResponse);

		expect(discoverService.buildDiscoverResponse).toHaveBeenCalledWith(scopes, {
			includeSchemas: false,
			resource: undefined,
			operation: undefined,
		});
		expect(mockResponse.json).toHaveBeenCalledWith({ data: emptyDiscoverResponse(scopes) });
	});

	it('should pass includeSchemas true when query include is schemas', async () => {
		const scopes: ApiKeyScope[] = ['tag:list'];
		vi.spyOn(discoverService, 'buildDiscoverResponse').mockResolvedValue(
			emptyDiscoverResponse(scopes),
		);

		await handler.getDiscover[0](requestWith(scopes, { include: 'schemas' }), mockResponse);

		expect(discoverService.buildDiscoverResponse).toHaveBeenCalledWith(scopes, {
			includeSchemas: true,
			resource: undefined,
			operation: undefined,
		});
	});

	it('should pass resource and operation query params to service', async () => {
		const scopes: ApiKeyScope[] = ['workflow:create'];
		vi.spyOn(discoverService, 'buildDiscoverResponse').mockResolvedValue(
			emptyDiscoverResponse(scopes),
		);

		await handler.getDiscover[0](
			requestWith(scopes, { resource: 'workflow', operation: 'create' }),
			mockResponse,
		);

		expect(discoverService.buildDiscoverResponse).toHaveBeenCalledWith(scopes, {
			includeSchemas: false,
			resource: 'workflow',
			operation: 'create',
		});
	});
});
