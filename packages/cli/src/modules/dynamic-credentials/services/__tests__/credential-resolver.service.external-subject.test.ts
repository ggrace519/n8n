import type { Logger } from '@n8n/backend-common';
import { mock } from 'vitest-mock-extended';
import type { Cipher } from 'n8n-core';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

import type { OAuthTokenVerifierProxy } from '@/services/oauth-token-verifier-proxy.service';

import type { N8NIdentifier } from '../../credential-resolvers/identifiers/n8n-identifier';
import {
	OAUTH2_RESOLVER_TYPE,
	OAUTH2_USERINFO_VALIDATION,
	type OAuth2UserinfoIdentifier,
} from '../../credential-resolvers/identifiers/oauth2-userinfo-identifier';
import type { DynamicCredentialEntryStorage } from '../../credential-resolvers/storage/dynamic-credential-entry-storage';
import type { DynamicCredentialUserEntryStorage } from '../../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import type { DynamicCredentialResolverRepository } from '../../database/repositories/credential-resolver.repository';
import { CredentialResolutionError } from '../../errors/credential-resolution.error';
import { CredentialResolverService } from '../credential-resolver.service';

const setup = (type: string, config: Record<string, unknown>) => {
	const cipher = mock<Cipher>();
	cipher.decryptV2.mockResolvedValue(JSON.stringify(config));
	const repository = mock<DynamicCredentialResolverRepository>();
	repository.findById.mockResolvedValue({ id: 'r1', type, config: 'encrypted' } as never);
	const identifier = mock<OAuth2UserinfoIdentifier>();
	identifier.resolve.mockResolvedValue('sub-123');

	const service = new CredentialResolverService(
		mock<Logger>(),
		cipher,
		mock<N8NIdentifier>(),
		identifier,
		mock<OAuthTokenVerifierProxy>(),
		repository,
		mock<DynamicCredentialUserEntryStorage>(),
		mock<DynamicCredentialEntryStorage>(),
	);
	return { service, identifier };
};

describe('CredentialResolverService.resolveExternalSubject', () => {
	it('identifies the subject through a resolver that can verify it', async () => {
		const { service, identifier } = setup(OAUTH2_RESOLVER_TYPE, {
			metadataUri: 'https://idp.example.com/.well-known/openid-configuration',
			validation: OAUTH2_USERINFO_VALIDATION,
		});

		await expect(service.resolveExternalSubject('r1', 'Bearer t', 'cred-1')).resolves.toBe(
			'sub-123',
		);
		expect(identifier.resolve).toHaveBeenCalledWith('Bearer t', expect.any(Object));
	});

	it('refuses a resolver type that cannot verify the identity instead of keying by the raw token', async () => {
		const { service, identifier } = setup('custom-resolver', { anything: true });

		await expect(service.resolveExternalSubject('r1', 'Bearer t', 'cred-1')).rejects.toThrow(
			CredentialResolutionError,
		);
		expect(identifier.resolve).not.toHaveBeenCalled();
	});

	it('refuses an oauth2 resolver configured without userinfo validation', async () => {
		const { service } = setup(OAUTH2_RESOLVER_TYPE, { metadataUri: 'https://idp.example.com/x' });

		await expect(service.resolveExternalSubject('r1', 'Bearer t', 'cred-1')).rejects.toThrow(
			CredentialResolutionError,
		);
	});
});

describe('CredentialResolverService identity sources', () => {
	const config = {
		metadataUri: 'https://idp.example.com/.well-known/openid-configuration',
		validation: OAUTH2_USERINFO_VALIDATION,
	};
	const metadata = {
		id: 'cred-1',
		name: 'c',
		type: 'oAuth2Api',
		isResolvable: true,
		resolverId: 'r1',
	};

	const contextWith = (source: string) => {
		const { service, identifier } = setup(OAUTH2_RESOLVER_TYPE, config);
		// readCredentialContext decrypts the execution context: hand back one with `source`.
		const cipher = (service as unknown as { cipher: Cipher }).cipher;
		vi.mocked(cipher.decryptV2).mockImplementation(async (value: string) =>
			value === 'ctx'
				? JSON.stringify({ version: 1, identity: 'Bearer session-jwt', metadata: { source } })
				: JSON.stringify(config),
		);
		return { service, identifier };
	};

	it('never sends an n8n session identity to a third-party resolver', async () => {
		const { service, identifier } = contextWith('manual-execution');

		await expect(
			service.resolveIfNeeded(
				metadata,
				{} as ICredentialDataDecryptedObject,
				{ credentials: 'ctx' } as never,
			),
		).rejects.toThrow(CredentialResolutionError);
		expect(identifier.resolve).not.toHaveBeenCalled();
	});

	it('never sends an n8n-issued OAuth token to a third-party resolver', async () => {
		const { service, identifier } = contextWith('n8n-oauth');

		await expect(
			service.resolveIfNeeded(
				metadata,
				{} as ICredentialDataDecryptedObject,
				{ credentials: 'ctx' } as never,
			),
		).rejects.toThrow(CredentialResolutionError);
		expect(identifier.resolve).not.toHaveBeenCalled();
	});
});

describe('CredentialResolverService.storeIfNeeded with an n8n-issued OAuth token', () => {
	it('verifies the bare token against its resource and stores under that n8n user', async () => {
		const cipher = mock<Cipher>();
		cipher.encryptV2.mockResolvedValue('encrypted-data');
		const verifier = mock<OAuthTokenVerifierProxy>();
		verifier.verifyOAuthAccessToken.mockResolvedValue({ user: { id: 'user-1' } } as never);
		const userEntryStorage = mock<DynamicCredentialUserEntryStorage>();
		const service = new CredentialResolverService(
			mock<Logger>(),
			cipher,
			mock<N8NIdentifier>(),
			mock<OAuth2UserinfoIdentifier>(),
			verifier,
			mock<DynamicCredentialResolverRepository>(),
			userEntryStorage,
			mock<DynamicCredentialEntryStorage>(),
		);

		// The connect callback hands the identity back in Authorization-header form.
		await service.storeIfNeeded(
			{ id: 'cred-1', name: 'c', type: 'oAuth2Api', isResolvable: true, resolverId: 'system-n8n' },
			{ access_token: 'provider-token' },
			{
				version: 1,
				identity: 'Bearer n8n-token',
				metadata: { source: 'n8n-oauth', resource: 'https://n8n.example.com/webhook/p' },
			},
		);

		expect(verifier.verifyOAuthAccessToken).toHaveBeenCalledWith(
			'n8n-token',
			'https://n8n.example.com/webhook/p',
		);
		expect(userEntryStorage.setCredentialData).toHaveBeenCalledWith(
			'cred-1',
			'user-1',
			'system-n8n',
			'encrypted-data',
			{},
		);
	});
});
