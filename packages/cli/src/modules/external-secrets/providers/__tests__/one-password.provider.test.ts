import { OnePasswordProvider } from '../one-password.provider';

const TOKEN = 'connect-token-value';
const client = {
	listVaults: vi.fn(),
	listItems: vi.fn(),
	getItemById: vi.fn(),
};

vi.mock('@1password/connect', () => ({
	OnePasswordConnect: vi.fn(() => client),
}));

const settings = {
	connected: true,
	connectedAt: null,
	settings: { serverUrl: 'http://op-connect:8080', accessToken: TOKEN },
};

describe('OnePasswordProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		client.listVaults.mockResolvedValue([{ id: 'v1', name: 'Prod' }, { id: 'v2' }]);
		client.listItems.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);
		client.getItemById.mockImplementation(async (_vault: string, id: string) =>
			id === 'i1'
				? {
						title: 'Database',
						fields: [
							{ label: 'password', value: 'pw' },
							{ label: 'username', value: 'admin' },
							{ label: 'notes' },
						],
					}
				: { title: 'Empty', fields: [{ label: 'x', value: '' }] },
		);
	});

	it('connects and caches vault/item/field secrets with dotted names', async () => {
		const provider = new OnePasswordProvider();
		await provider.init(settings);
		await provider.connect();

		expect(provider.state).toBe('connected');
		expect(provider.getSecretNames()).toEqual(['Prod.Database.password', 'Prod.Database.username']);
		expect(provider.getSecret('Prod')).toEqual({
			Database: { password: 'pw', username: 'admin' },
		});
		expect(provider.hasSecret('Prod')).toBe(true);
		expect(provider.hasSecret('Other')).toBe(false);
	});

	it('sets state to error when listing vaults fails, without leaking the token', async () => {
		client.listVaults.mockRejectedValue(
			Object.assign(new Error(`denied ${TOKEN}`), { status: 401 }),
		);
		const provider = new OnePasswordProvider();
		await provider.init(settings);
		await provider.connect();

		expect(provider.state).toBe('error');
		expect(provider.connectionError).toContain('401');
		expect(provider.connectionError).not.toContain(TOKEN);
	});

	it('rejects invalid server URLs', async () => {
		const provider = new OnePasswordProvider();
		await provider.init({ ...settings, settings: { ...settings.settings, serverUrl: 'ftp://x' } });
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(client.listVaults).not.toHaveBeenCalled();
	});

	it('test() reports success and failure', async () => {
		const provider = new OnePasswordProvider();
		await provider.init(settings);
		expect(await provider.test()).toEqual([true]);

		client.listVaults.mockRejectedValue(new Error(`boom ${TOKEN}`));
		const [ok, message] = await provider.test();
		expect(ok).toBe(false);
		expect(message).not.toContain(TOKEN);
	});

	it('disconnect clears the cache', async () => {
		const provider = new OnePasswordProvider();
		await provider.init(settings);
		await provider.connect();
		await provider.disconnect();
		expect(provider.getSecretNames()).toEqual([]);
	});
});
