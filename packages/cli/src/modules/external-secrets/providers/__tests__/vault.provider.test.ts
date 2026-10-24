import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultProvider } from '../vault.provider';

type Route = { status: number; body?: unknown };
type Call = { method: string; path: string; headers: Record<string, string>; body?: string };

const BASE = 'https://vault.example.com';
let routes: Record<string, Route>;
let calls: Call[];

function respond(route: Route | undefined): Response {
	if (!route) return new Response(null, { status: 404 });
	return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
		status: route.status,
	});
}

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(String(input));
	const method = init?.method ?? 'GET';
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k] = String(v);
	calls.push({ method, path: url.pathname, headers, body: init?.body?.toString() });
	return respond(routes[`${method} ${url.pathname}`]);
});

const kvRoutes: Record<string, Route> = {
	'GET /v1/sys/mounts': {
		status: 200,
		body: {
			data: {
				'secret/': { type: 'kv', options: { version: '2' } },
				'legacy/': { type: 'kv', options: { version: '1' } },
				'sys/': { type: 'system' },
			},
		},
	},
	'LIST /v1/secret/metadata': { status: 200, body: { data: { keys: ['app/', 'top'] } } },
	'LIST /v1/secret/metadata/app': { status: 200, body: { data: { keys: ['db'] } } },
	'GET /v1/secret/data/app/db': { status: 200, body: { data: { data: { password: 'p1' } } } },
	'GET /v1/secret/data/top': { status: 200, body: { data: { data: { key: 'k1' } } } },
	'LIST /v1/legacy': { status: 200, body: { data: { keys: ['old'] } } },
	'GET /v1/legacy/old': { status: 200, body: { data: { value: 'v1' } } },
};

async function makeProvider(settings: Record<string, string>) {
	const provider = new VaultProvider();
	await provider.init({ connected: true, connectedAt: null, settings: { url: BASE, ...settings } });
	return provider;
}

describe('VaultProvider', () => {
	beforeEach(() => {
		calls = [];
		routes = { 'GET /v1/auth/token/lookup-self': { status: 200, body: { data: {} } }, ...kvRoutes };
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		fetchMock.mockClear();
	});

	it('connects with a token and sends the namespace header', async () => {
		const provider = await makeProvider({ authMethod: 'token', token: 'tok', namespace: 'team' });
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(calls[0].headers['X-Vault-Token']).toBe('tok');
		expect(calls[0].headers['X-Vault-Namespace']).toBe('team');
	});

	it('logs in with AppRole and uses the returned token', async () => {
		routes['POST /v1/auth/approle/login'] = { status: 200, body: { auth: { client_token: 'ar' } } };
		const provider = await makeProvider({ authMethod: 'appRole', roleId: 'r', secretId: 's' });
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(JSON.parse(calls[0].body ?? '')).toEqual({ role_id: 'r', secret_id: 's' });
		await provider.update();
		// update re-authenticates, then uses the login token
		expect(calls[1].path).toBe('/v1/auth/approle/login');
		expect(calls[2].headers['X-Vault-Token']).toBe('ar');
	});

	it('logs in with username and password', async () => {
		routes['POST /v1/auth/userpass/login/alice'] = {
			status: 200,
			body: { auth: { client_token: 'up' } },
		};
		const provider = await makeProvider({
			authMethod: 'usernameAndPassword',
			username: 'alice',
			password: 'pw',
		});
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(JSON.parse(calls[0].body ?? '')).toEqual({ password: 'pw' });
	});

	it('discovers KV v1 and v2 mounts and lists recursively into a nested cache', async () => {
		const provider = await makeProvider({ authMethod: 'token', token: 'tok' });
		await provider.connect();
		await provider.update();
		expect(provider.getSecretNames().sort()).toEqual([
			'legacy.old.value',
			'secret.app.db.password',
			'secret.top.key',
		]);
		expect(provider.getSecret('secret.app.db.password')).toBe('p1');
		expect(provider.getSecret('secret')).toEqual({
			app: { db: { password: 'p1' } },
			top: { key: 'k1' },
		});
		expect(provider.hasSecret('legacy.old.value')).toBe(true);
		expect(provider.hasSecret('secret.missing')).toBe(false);
		expect(provider.hasSecret('secret.constructor')).toBe(false);
	});

	it('moves to error state on a rejected login without leaking credentials', async () => {
		routes['POST /v1/auth/userpass/login/alice'] = {
			status: 400,
			body: { errors: ['bad pw hunter2'] },
		};
		const provider = await makeProvider({
			authMethod: 'usernameAndPassword',
			username: 'alice',
			password: 'hunter2',
		});
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(provider.connectionError).toBe('Vault request failed with status 400');
		const [ok, message] = await provider.test();
		expect(ok).toBe(false);
		expect(message).not.toContain('hunter2');
	});

	it('reports network failures without the token', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed tok-secret'));
		const provider = await makeProvider({ authMethod: 'token', token: 'tok-secret' });
		const [ok, message] = await provider.test();
		expect(ok).toBe(false);
		expect(message).not.toContain('tok-secret');
	});

	it('test() succeeds with a valid token', async () => {
		const provider = await makeProvider({ authMethod: 'token', token: 'tok' });
		expect(await provider.test()).toEqual([true]);
	});

	it('rejects non-http URLs', async () => {
		const provider = new VaultProvider();
		await provider.init({
			connected: true,
			connectedAt: null,
			settings: { url: 'file:///etc/passwd', token: 't' },
		});
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
