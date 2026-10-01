import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import type { LdapConfig } from '@n8n/constants';
import { LDAP_DEFAULT_CONFIGURATION, LDAP_FEATURE_NAME } from '@n8n/constants';
import type { Settings, SettingsRepository } from '@n8n/db';
import type { InstanceSettings } from 'n8n-core';
import { Cipher, CipherAes256CBC, CipherAes256GCM, EncryptionKeyProxy } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import type { EventService } from '@/events/event.service';

import { LdapService } from '../ldap.service';

vi.mock('@/sso/sso-helpers', () => ({
	assertAuthenticationMethodCanBeEnabled: vi.fn(),
	getCurrentAuthenticationMethod: vi.fn(() => 'email'),
	setCurrentAuthenticationMethod: vi.fn(),
}));

describe('LdapService bind password', () => {
	const cipher = new Cipher(
		mock<InstanceSettings>({ encryptionKey: 'test-encryption-key' }),
		new CipherAes256GCM(),
		new CipherAes256CBC(),
		new EncryptionKeyProxy(),
	);
	const settingsRepository = mock<SettingsRepository>();
	const logger = mock<Logger>();
	logger.scoped.mockReturnValue(logger);

	const createService = () =>
		new LdapService(
			logger,
			settingsRepository,
			mock<GlobalConfig>({ sso: { ldap: { loginEnabled: false, loginLabel: '' } } }),
			cipher,
			mock<EventService>(),
		);

	const storedRow = (config: Partial<LdapConfig>) =>
		mock<Settings>({ value: JSON.stringify({ ...LDAP_DEFAULT_CONFIGURATION, ...config }) });

	const lastStoredConfig = (): LdapConfig =>
		JSON.parse(settingsRepository.upsertByKey.mock.calls.at(-1)![1]) as LdapConfig;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('is encrypted at rest and held decrypted in memory', async () => {
		const service = createService();

		const updated = await service.updateConfig({
			...LDAP_DEFAULT_CONFIGURATION,
			bindingAdminPassword: 'secretPassword123',
		});

		expect(updated.bindingAdminPassword).toBe('secretPassword123');
		const stored = lastStoredConfig().bindingAdminPassword;
		expect(settingsRepository.upsertByKey.mock.calls.at(-1)![0]).toBe(LDAP_FEATURE_NAME);
		expect(stored).not.toBe('secretPassword123');
		expect(cipher.decrypt(stored)).toBe('secretPassword123');
	});

	test('decrypts the stored password on load', async () => {
		settingsRepository.findByKey.mockResolvedValue(
			storedRow({ bindingAdminPassword: cipher.encrypt('secretPassword123') }),
		);

		const config = await createService().loadConfig();

		expect(config.bindingAdminPassword).toBe('secretPassword123');
	});

	test('keeps a legacy plaintext password, including one too short to be ciphertext', async () => {
		// Decrypting short plaintext yields '' rather than an error.
		settingsRepository.findByKey.mockResolvedValue(storedRow({ bindingAdminPassword: 'short' }));

		const config = await createService().loadConfig();

		expect(config.bindingAdminPassword).toBe('short');
	});

	test('re-saving the loaded config does not double-encrypt the password', async () => {
		settingsRepository.findByKey.mockResolvedValue(
			storedRow({ bindingAdminPassword: cipher.encrypt('secretPassword123') }),
		);
		const service = createService();

		await service.updateConfig(await service.loadConfig());

		expect(cipher.decrypt(lastStoredConfig().bindingAdminPassword)).toBe('secretPassword123');
	});

	test('loads an undecryptable password as unset instead of failing', async () => {
		// E.g. a row encrypted under another encryption key. A wrong-key decrypt
		// usually throws, but not always, so the failure is simulated.
		settingsRepository.findByKey.mockResolvedValue(
			storedRow({ bindingAdminPassword: cipher.encrypt('secretPassword123') }),
		);
		vi.spyOn(cipher, 'decrypt').mockImplementationOnce(() => {
			throw new Error('bad decrypt');
		});

		const config = await createService().loadConfig();

		expect(config.bindingAdminPassword).toBe('');
		expect(logger.warn).toHaveBeenCalled();
	});

	test('stores an empty password as empty', async () => {
		await createService().updateConfig({ ...LDAP_DEFAULT_CONFIGURATION, bindingAdminPassword: '' });

		expect(lastStoredConfig().bindingAdminPassword).toBe('');
	});
});
