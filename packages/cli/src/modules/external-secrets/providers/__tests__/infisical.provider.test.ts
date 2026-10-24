import { InfisicalProvider } from '../infisical.provider';

const SECRET = 'super-secret-client-secret';
const settings = {
	connected: true,
	connectedAt: null,
	settings: {
		siteURL: 'https://infisical.example.com/',
		clientId: 'client-id',
		clientSecret: SECRET,
		projectId: 'proj-1',
		environment: 'prod',
		secretPath: '/app',
	},
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('InfisicalProvider', () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});
	afterEach(() => vi.unstubAllGlobals());

	const loginOk = (expiresIn = 3600) => json({ accessToken: 'tok-1', expiresIn });
	const secretsOk = () =>
		json({ secrets: [{ secretKey: 'DB_PASS', secretValue: 'pw' }, { secretKey: 'EMPTY' }] });

	it('logs in, lists secrets and caches them', async () => {
		fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(secretsOk());
		const provider = new InfisicalProvider();
		await provider.init(settings);
		await provider.connect();

		expect(provider.state).toBe('connected');
		expect(provider.getSecretNames()).toEqual(['DB_PASS', 'EMPTY']);
		expect(provider.getSecret('DB_PASS')).toBe('pw');
		expect(provider.hasSecret('DB_PASS')).toBe(true);
		expect(provider.hasSecret('nope')).toBe(false);

		const [loginUrl, loginInit] = fetchMock.mock.calls[0];
		expect(loginUrl).toBe('https://infisical.example.com/api/v1/auth/universal-auth/login');
		expect(loginInit?.method).toBe('POST');
		const listUrl = new URL(String(fetchMock.mock.calls[1][0]));
		expect(listUrl.pathname).toBe('/api/v3/secrets/raw');
		expect(listUrl.searchParams.get('workspaceId')).toBe('proj-1');
		expect(listUrl.searchParams.get('environment')).toBe('prod');
		expect(listUrl.searchParams.get('secretPath')).toBe('/app');
		expect(fetchMock.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer tok-1' });
	});

	it('reuses a valid token and re-logs in once it expires', async () => {
		fetchMock
			.mockResolvedValueOnce(loginOk(3600))
			.mockResolvedValueOnce(secretsOk())
			.mockResolvedValueOnce(secretsOk());
		const provider = new InfisicalProvider();
		await provider.init(settings);
		await provider.connect();
		await provider.update();
		expect(fetchMock).toHaveBeenCalledTimes(3);

		vi.useFakeTimers({ now: Date.now() + 2 * 3600 * 1000 });
		try {
			fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(secretsOk());
			await provider.update();
			expect(String(fetchMock.mock.calls[3][0])).toContain('/universal-auth/login');
		} finally {
			vi.useRealTimers();
		}
	});

	it('sets state to error on login failure without leaking the secret', async () => {
		fetchMock.mockResolvedValueOnce(json({ message: `bad ${SECRET}` }, 401));
		const provider = new InfisicalProvider();
		await provider.init(settings);
		await provider.connect();

		expect(provider.state).toBe('error');
		expect(provider.connectionError).toContain('401');
		expect(provider.connectionError).not.toContain(SECRET);
	});

	it('rejects non-http(s) URLs before any request', async () => {
		const provider = new InfisicalProvider();
		await provider.init({
			...settings,
			settings: { ...settings.settings, siteURL: 'file:///etc' },
		});
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('test() reports success and failure', async () => {
		const provider = new InfisicalProvider();
		await provider.init(settings);

		fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(secretsOk());
		expect(await provider.test()).toEqual([true]);

		fetchMock.mockRejectedValueOnce(new Error(`network ${SECRET}`));
		const [ok, message] = await provider.test();
		expect(ok).toBe(false);
		expect(message).not.toContain(SECRET);
	});
});
