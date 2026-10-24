import { AwsSecretsManagerProvider } from '../aws-secrets-manager.provider';

const { send, ctor } = vi.hoisted(() => ({ send: vi.fn(), ctor: vi.fn() }));

vi.mock('@aws-sdk/client-secrets-manager', () => {
	class Command {
		constructor(readonly input: Record<string, unknown>) {}
	}
	class ListSecretsCommand extends Command {
		kind = 'list';
	}
	class GetSecretValueCommand extends Command {
		kind = 'get';
	}
	class SecretsManagerClient {
		constructor(config: unknown) {
			ctor(config);
		}
		send = send;
		destroy = vi.fn();
	}
	return { SecretsManagerClient, ListSecretsCommand, GetSecretValueCommand };
});

const SECRET_KEY = 'super-secret-access-key';
const settings = {
	region: 'us-east-1',
	authMethod: 'iamUser',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: SECRET_KEY,
};

async function makeProvider(overrides: Record<string, unknown> = {}) {
	const provider = new AwsSecretsManagerProvider();
	await provider.init({
		connected: true,
		connectedAt: null,
		settings: { ...settings, ...overrides },
	});
	return provider;
}

type Cmd = { kind: string; input: Record<string, unknown> };

describe('AwsSecretsManagerProvider', () => {
	beforeEach(() => {
		send.mockReset();
		ctor.mockReset();
	});

	it('connects and passes static credentials for iamUser', async () => {
		send.mockResolvedValue({ SecretList: [] });
		const provider = await makeProvider();
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(ctor).toHaveBeenCalledWith({
			region: 'us-east-1',
			credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET_KEY },
		});
	});

	it('uses the default credential chain for autoDetect', async () => {
		send.mockResolvedValue({ SecretList: [] });
		const provider = await makeProvider({ authMethod: 'autoDetect', accessKeyId: '' });
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(ctor).toHaveBeenCalledWith({ region: 'us-east-1' });
	});

	it('enters error state without leaking credentials', async () => {
		send.mockRejectedValue(new Error(`denied for ${SECRET_KEY}`));
		const provider = await makeProvider();
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(provider.connectionError).toContain('Could not connect');
		expect(provider.connectionError).not.toContain(SECRET_KEY);
	});

	it('errors when access keys are missing', async () => {
		const provider = await makeProvider({ secretAccessKey: '' });
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(send).not.toHaveBeenCalled();
	});

	it('paginates and parses JSON object values', async () => {
		send.mockImplementation(async (cmd: Cmd) => {
			if (cmd.kind === 'list') {
				return cmd.input.NextToken
					? { SecretList: [{ Name: 'db' }, { Name: 'gone', DeletedDate: new Date() }] }
					: { SecretList: [{ Name: 'api-key' }, { Name: 'binary' }], NextToken: 't1' };
			}
			const values: Record<string, unknown> = {
				'api-key': { SecretString: 'secret-123' },
				db: { SecretString: JSON.stringify({ username: 'admin', password: 'hunter2' }) },
				binary: { SecretBinary: new Uint8Array([1]) },
			};
			return values[String(cmd.input.SecretId)];
		});
		const provider = await makeProvider();
		await provider.update();

		expect(provider.getSecretNames().sort()).toEqual(['api-key', 'db']);
		expect(provider.getSecret('api-key')).toBe('secret-123');
		expect(provider.getSecret('db')).toEqual({ username: 'admin', password: 'hunter2' });
		expect(provider.hasSecret('db')).toBe(true);
		expect(provider.hasSecret('gone')).toBe(false);
		expect(provider.hasSecret('toString')).toBe(false);
	});

	it('keeps JSON scalars as strings', async () => {
		send.mockImplementation(async (cmd: Cmd) =>
			cmd.kind === 'list' ? { SecretList: [{ Name: 'n' }] } : { SecretString: '42' },
		);
		const provider = await makeProvider();
		await provider.update();
		expect(provider.getSecret('n')).toBe('42');
	});

	it('test() reports success and failure', async () => {
		const provider = await makeProvider();
		send.mockResolvedValueOnce({ SecretList: [] });
		expect(await provider.test()).toEqual([true]);
		send.mockRejectedValueOnce(new Error(`bad ${SECRET_KEY}`));
		const [ok, message] = await provider.test();
		expect(ok).toBe(false);
		expect(message).not.toContain(SECRET_KEY);
	});
});
