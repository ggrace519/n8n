import 'reflect-metadata';

describe('CredentialCheckService wiring', () => {
	it('resolves every constructor dependency when the authorization service loads first', async () => {
		// The controller imports the authorization service before the check service is
		// ever loaded; an import cycle between them leaves a dependency undefined.
		const { DynamicCredentialAuthorizationService } = await import(
			'../dynamic-credential-authorization.service.js'
		);
		const { CredentialCheckService } = await import('../credential-check.service.js');

		const paramTypes: unknown[] = Reflect.getMetadata('design:paramtypes', CredentialCheckService);

		expect(paramTypes).not.toContain(undefined);
		expect(paramTypes).toContain(DynamicCredentialAuthorizationService);
	});
});
