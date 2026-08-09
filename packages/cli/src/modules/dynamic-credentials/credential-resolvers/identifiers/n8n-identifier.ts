import { Service } from '@n8n/di';
import type { ICredentialContext } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';

/**
 * Maps an n8n-issued identity carried by a credential context to the n8n user
 * it belongs to.
 *
 * The identity is the `n8n-auth` JWT captured at the controller boundary and
 * re-validated here, at point of use: `AuthService` re-checks the invalid-token
 * blocklist and the MFA gate, so a user who logged out mid-run no longer
 * resolves. Nothing request-bound (browser id, endpoint, method) is needed or
 * consulted.
 */
@Service()
export class N8NIdentifier {
	constructor(private readonly authService: AuthService) {}

	async resolve(
		credentialContext: ICredentialContext,
		_configuration: Record<string, unknown>,
	): Promise<string> {
		const cookie = stripBearerPrefix(credentialContext.identity);
		const user = await this.authService.authenticateUserByCookie(cookie);
		return user.id;
	}
}

/**
 * The OAuth authorize flow stores the same cookie as an `Authorization` header
 * value, so the identity may arrive with a `Bearer ` prefix.
 */
function stripBearerPrefix(identity: string): string {
	const match = /^Bearer\s+(.*)$/i.exec(identity);
	return match ? match[1] : identity;
}
