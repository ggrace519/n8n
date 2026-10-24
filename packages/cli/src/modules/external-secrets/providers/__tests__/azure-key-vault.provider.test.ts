import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPropertiesOfSecrets, getSecret, credentialCtor, clientCtor } = vi.hoisted(() => ({
	listPropertiesOfSecrets: vi.fn(),
	getSecret: vi.fn(),
	credentialCtor: vi.fn(),
	clientCtor: vi.fn(),
}));

vi.mock('@azure/identity', () => ({
	ClientSecretCredential: class {
		constructor(...args: unknown[]) {
			credentialCtor(...args);
		}
	},
}));

vi.mock('@azure/keyvault-secrets', () => ({
	SecretClient: class {
		constructor(...args: unknown[]) {
			clientCtor(...args);
		}
		listPropertiesOfSecrets = listPropertiesOfSecrets;
		getSecret = getSecret;
	},
}));

import { AzureKeyVaultProvider } from '../azure-key-vault.provider';

const settings = {
	vaultName: 'my-vault',
	tenantId: 'tenant',
	clientId: 'client',
	clientSecret: 'super-secret-value',
};

function pagedIterable(items: Array<{ name: string; enabled?: boolean }>) {
	return {
		async *[Symbol.asyncIterator]() {
			yield* items;
		},
		byPage: () => ({ next: async () => ({ done: false, value: items.slice(0, 1) }) }),
	};
}

async function makeProvider(overrides: Partial<typeof settings> = {}) {
	const provider = new AzureKeyVaultProvider();
	await provider.init({
		connected: true,
		connectedAt: null,
		settings: { ...settings, ...overrides },
	});
	return provider;
}

describe('AzureKeyVaultProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listPropertiesOfSecrets.mockReturnValue(
			pagedIterable([
				{ name: 'db-password' },
				{ name: 'disabled-one', enabled: false },
				{ name: 'api-key' },
			]),
		);
		getSecret.mockImplementation(async (name: string) => ({ name, value: `value-of-${name}` }));
	});

	it('exposes the settings fields with the client secret as a password', () => {
		const provider = new AzureKeyVaultProvider();
		expect(provider.properties.map((p) => p.name)).toEqual([
			'vaultName',
			'tenantId',
			'clientId',
			'clientSecret',
		]);
		expect(provider.properties[3].typeOptions?.password).toBe(true);
	});

	it('connects using the vault URL and client secret credential', async () => {
		const provider = await makeProvider();
		await provider.connect();
		expect(provider.state).toBe('connected');
		expect(credentialCtor).toHaveBeenCalledWith('tenant', 'client', 'super-secret-value');
		expect(clientCtor).toHaveBeenCalledWith('https://my-vault.vault.azure.net', expect.anything());
	});

	it('caches enabled secrets and keeps dashed names', async () => {
		const provider = await makeProvider();
		await provider.connect();
		await provider.update();
		expect(provider.getSecretNames()).toEqual(['db-password', 'api-key']);
		expect(provider.getSecret('db-password')).toBe('value-of-db-password');
		expect(provider.hasSecret('disabled-one')).toBe(false);
		expect(provider.hasSecret('toString')).toBe(false);
		expect(getSecret).not.toHaveBeenCalledWith('disabled-one');
	});

	it('moves to error state when listing fails', async () => {
		listPropertiesOfSecrets.mockReturnValue({
			byPage: () => ({ next: async () => await Promise.reject(new Error('Unauthorized')) }),
		});
		const provider = await makeProvider();
		await provider.connect();
		expect(provider.state).toBe('error');
		expect(provider.connectionError).toBe('Unauthorized');
		expect(await provider.test()).toEqual([false, 'Unauthorized']);
	});

	it('rejects incomplete or invalid settings without leaking the secret', async () => {
		const incomplete = await makeProvider({ tenantId: '' });
		const [ok, message] = await incomplete.test();
		expect(ok).toBe(false);
		expect(message).not.toContain('super-secret-value');

		const invalid = await makeProvider({ vaultName: 'evil.example.com/x' });
		await invalid.connect();
		expect(invalid.state).toBe('error');
		expect(clientCtor).not.toHaveBeenCalled();
	});

	it('test() succeeds with valid settings', async () => {
		const provider = await makeProvider();
		expect(await provider.test()).toEqual([true]);
	});
});
