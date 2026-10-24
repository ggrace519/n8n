import { GcpSecretsManagerProvider } from '../gcp-secrets-manager.provider';

const { listSecrets, listSecretsAsync, accessSecretVersion, ctor } = vi.hoisted(() => ({
	listSecrets: vi.fn(),
	listSecretsAsync: vi.fn(),
	accessSecretVersion: vi.fn(),
	ctor: vi.fn(),
}));

vi.mock('@google-cloud/secret-manager', () => {
	class SecretManagerServiceClient {
		constructor(opts: unknown) {
			ctor(opts);
		}
		listSecrets = listSecrets;
		listSecretsAsync = listSecretsAsync;
		accessSecretVersion = accessSecretVersion;
		close = vi.fn();
	}
	return { SecretManagerServiceClient };
});

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n';
const KEY = JSON.stringify({
	type: 'service_account',
	project_id: 'my-proj',
	client_email: 'sa@my-proj.iam.gserviceaccount.com',
	private_key: PRIVATE_KEY,
});

async function makeProvider(serviceAccountKey: string = KEY) {
	const provider = new GcpSecretsManagerProvider();
	await provider.init({ connected: true, connectedAt: null, settings: { serviceAccountKey } });
	return provider;
}

async function* iterate<T>(items: T[]) {
	for (const item of items) yield await Promise.resolve(item);
}

describe('GcpSecretsManagerProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('connects with the parsed service account key', async () => {
		listSecrets.mockResolvedValue([[]]);
		const provider = await makeProvider();
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(ctor).toHaveBeenCalledWith({
			projectId: 'my-proj',
			credentials: { client_email: 'sa@my-proj.iam.gserviceaccount.com', private_key: PRIVATE_KEY },
		});
		expect(listSecrets.mock.calls[0][0]).toEqual({ parent: 'projects/my-proj', pageSize: 1 });
	});

	it('enters error state without leaking the key', async () => {
		listSecrets.mockRejectedValue(new Error(`PERMISSION_DENIED ${PRIVATE_KEY}`));
		const provider = await makeProvider();
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(provider.connectionError).toContain('PERMISSION_DENIED');
		expect(provider.connectionError).not.toContain('abc123');
	});

	it('rejects invalid JSON without echoing it', async () => {
		const provider = await makeProvider('{"private_key": "abc123"');
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(provider.connectionError).toBe('Service account key is not valid JSON');
	});

	it('rejects a key missing required fields', async () => {
		const provider = await makeProvider(JSON.stringify({ project_id: 'p' }));
		const [ok, message] = await provider.test();
		expect(ok).toBe(false);
		expect(message).toContain('client_email');
	});

	it('lists every secret, reads latest versions and parses JSON', async () => {
		listSecretsAsync.mockReturnValue(
			iterate([
				{ name: 'projects/my-proj/secrets/api-key' },
				{ name: 'projects/my-proj/secrets/db' },
				{ name: 'projects/my-proj/secrets/no-version' },
				{ name: '' },
			]),
		);
		accessSecretVersion.mockImplementation(async ({ name }: { name: string }) => {
			if (name.includes('no-version')) throw new Error('NOT_FOUND');
			const data = name.includes('/db/')
				? Buffer.from(JSON.stringify({ user: 'admin' }))
				: new TextEncoder().encode('secret-123');
			return [{ payload: { data } }];
		});
		const provider = await makeProvider();
		await provider.update();

		expect(listSecretsAsync).toHaveBeenCalledWith({ parent: 'projects/my-proj' });
		expect(accessSecretVersion).toHaveBeenCalledWith({
			name: 'projects/my-proj/secrets/api-key/versions/latest',
		});
		expect(provider.getSecretNames().sort()).toEqual(['api-key', 'db']);
		expect(provider.getSecret('api-key')).toBe('secret-123');
		expect(provider.getSecret('db')).toEqual({ user: 'admin' });
		expect(provider.hasSecret('db')).toBe(true);
		expect(provider.hasSecret('no-version')).toBe(false);
	});

	it('test() returns [true] on success', async () => {
		listSecrets.mockResolvedValue([[]]);
		const provider = await makeProvider();
		expect(await provider.test()).toEqual([true]);
	});
});
