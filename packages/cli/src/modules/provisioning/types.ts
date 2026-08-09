/** Provider-neutral inputs the provisioning policy is evaluated against. */
export interface ProvisioningEvaluationInput {
	provider: 'saml' | 'oidc';
	/** Raw, untrusted claim document exposed to rule expressions as `$claims`. */
	claims: Record<string, unknown>;
	providerContext:
		| {
				provider: 'saml';
				rawAttributes: Record<string, unknown>;
		  }
		| {
				provider: 'oidc';
				idToken: Record<string, unknown>;
				userInfo: Record<string, unknown>;
		  };
	/** Roles asserted directly by the IdP, used when claim provisioning is on. */
	directClaims?: {
		instanceRole?: string;
		projectRoles?: string[];
	};
}

export interface ResolvedInstanceRole {
	roleSlug: string;
	/** Rule that produced the role; `null` when it came from the default condition or a claim. */
	matchedRuleId: string | null;
	expression: string | null;
	/** True when the role came from the default condition rather than a match. */
	isFallback: boolean;
}

export interface ResolvedProjectRole {
	projectId: string;
	roleSlug: string;
	matchedRuleId: string;
	expression: string;
}

export type ProvisioningDenialReason = 'block-access' | 'evaluation-failed';

export type ProvisioningDecision =
	| { outcome: 'deny'; reason: ProvisioningDenialReason }
	| {
			outcome: 'allow';
			provider: 'saml' | 'oidc';
			/** Absent means "leave the account's instance role alone". */
			instanceRole?: ResolvedInstanceRole;
			projectRoles: ResolvedProjectRole[];
			/**
			 * Projects the policy governs. Reconciliation only ever adds to or
			 * removes from this surface, so memberships granted outside
			 * provisioning survive a login. Which of them are actually revoked
			 * depends on the account and is decided when the decision is applied.
			 */
			managedProjectIds: string[];
	  };

export interface ProvisioningApplicationResult {
	instanceRoleChanged: boolean;
	projectsAdded: number;
	projectsRemoved: number;
}

/** Data exposed to a rule expression. Nothing else crosses into the isolate. */
export interface ProvisioningExpressionContext {
	$claims: Record<string, unknown>;
	$provider: 'saml' | 'oidc';
	$oidc?: {
		idToken: Record<string, unknown>;
		userInfo: Record<string, unknown>;
	};
}
