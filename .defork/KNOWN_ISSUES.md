# Known issues — de-fork loop

Defects discovered during the rebuild that are **not** themselves rebuild items.
GitHub issues are disabled on this fork, so this file is the tracker; each entry
carries symptom / root cause / impact / candidate fix, and should be deleted
here and referenced from the fixing commit when resolved.

Rebuild work itself lives in `feature_list.json`, not here.

---

## KI-1 — `node-rsa` 2.0.0 override is incompatible with samlify's signing path

**Symptom.** Outbound signed SAML `AuthnRequest`s (redirect binding, opt-in via
`N8N_ENV_FEAT_SIGNED_SAML_REQUESTS`) produce a signature an identity provider
rejects. Inbound verification is unaffected — samlify verifies XML signatures
through `xml-crypto`, not `node-rsa`.

**Root cause.** Root `package.json` pins the override `"node-rsa": "2.0.0"`
while `samlify@2.13.0` declares `^1.1.1`. Two v2 changes break
`constructMessageSignature`:

1. `sign()` does not return a `Buffer` on Node. Verified against the installed
   build: `return type: Uint8Array | isBuffer: false`, and `.toString('base64')`
   is not valid base64 (a `Uint8Array` stringifies to a comma-separated decimal
   list). node-rsa's own `MIGRATION.md` claims "Return types on Node: `Buffer`
   (unchanged)" — inaccurate for this build, which is why reading the docs
   would not have caught it.
2. The default `signingScheme` changed from PKCS#1 v1.5 to `pss`. SAML redirect
   binding advertises `SigAlg=...rsa-sha256` (PKCS#1 v1.5), so even with (1)
   fixed the signature would be semantically wrong unless the scheme is pinned.

**Impact.** A broken opt-in feature, not a weakened one — the failure is
fail-closed (the IdP rejects it). Other `node-rsa` consumers in the workspace
have not been surveyed.

**Candidate fix.** Scope or drop the repo-wide override so samlify resolves a v1
line; or pin `signingScheme: 'pkcs1-sha256'` and normalise the result to a
`Buffer` at samlify's signing site via a patch; or sign the redirect binding
with `node:crypto` in our own code path.

Found: 2026-08-09 (E5). Unfixed — crosses a repo-wide dependency override.

---

## KI-2 — public API allows a non-owner to delete a tag

**Symptom.** `test/integration/public-api/tags.test.ts` →
`DELETE /tags/:id > non-owner should not delete tag` expects **403**, receives
**200**; the tag is deleted.

**Root cause.** Not yet investigated — the route's authorization does not apply
the owner/scope check the spec pins.

**Impact.** A member-scoped API key can delete tags it should not. Pre-existing;
surfaced only once the public-api router became loadable again (E9).

**Candidate fix.** Investigate at the A10 sweep with the whole public-api suite
runnable.

Found: 2026-08-09 (surfaced by E9). Unfixed.

---

## KI-3 — provisioning instance-settings loader writes a different settings key than its spec pins

**Symptom.** `src/instance-settings-loader/__tests__/sso/provisioning.instance-settings-loader.test.ts`
fails 3/7: the loader writes settings key `sso.provisioning.config` while the
spec expects `features.provisioning`.

**Root cause.** Key naming diverged between the loader and its spec; which side
is authoritative is undetermined until the provisioning module is rebuilt.

**Impact.** Provisioning configuration may not be read back from the key it is
written to. Pre-existing, unrelated to log-streaming/SSO work.

**Candidate fix.** Resolve as part of **E11-provisioning**, which owns the
module and can settle the authoritative key.

Found: 2026-08-09 (surfaced by E9). Unfixed — belongs to E11.

---

## KI-4 — SSO logins are refused while provisioning policy is configured

**Symptom.** With `scopesProvisionInstanceRole`, `scopesProvisionProjectRoles`,
`scopesUseExpressionMapping`, a `defaultInstanceRole`, or any `RoleMappingRule`
row present, both SAML and OIDC logins are denied (`ForbiddenError` /
`AuthError`) before any user lookup or mutation.

**Root cause.** Deliberate, not a defect in the SSO rebuild: the role-mapping
**evaluation engine did not survive the purge**. The `RoleMappingRule` entity,
its repository and migration, and the provisioning DTOs (including
`defaultInstanceRole` and `BLOCK_ACCESS_ASSIGNMENT`) all survive, but nothing
evaluates them — and `saml.api.test.ts:978` pins denial **before** account
mutation. Admitting a login with default roles while a `block:access` policy is
configured would fail open, so both protocols fail closed instead. SAML and OIDC
agents reached this decision independently and agree.

**Impact.** Instances that configure provisioning cannot use SSO until the
engine is rebuilt. Instances without provisioning are unaffected.

**Fix.** **E11-provisioning** must deliver: ordered rule fetch, expression
evaluation against `{$claims, $oidc:{idToken,userInfo} | $saml, $provider}`,
`block:access`, `defaultInstanceRole`, project-role reconciliation, and the
provisioning events — then hook it into `handleSamlLogin` /
`resolveSignInUser` ahead of account mutation, and remove these deny branches.

Found: 2026-08-09 (E5/E6). Intentional until E11.

---

## KI-5 — `saml.api.test.ts` cannot run

**Symptom.** `test/integration/saml/saml.api.test.ts` collects 0 tests; it
imports `@/modules/provisioning.ee/provisioning.service.ee`.

**Root cause.** The purged provisioning service. A path repoint is not enough —
the spec drives an `init()` and a private `provisioningConfig` slot the
surviving `ProvisioningService` does not have.

**Impact.** The authoritative ACS / permission-matrix / signing spec for SAML is
unverified. Its pins are currently satisfied by construction plus targeted unit
tests (84 in `src/modules/sso-saml/__tests__`), not by the spec itself.

**Fix.** Re-run it as an acceptance gate of **E11-provisioning**; treat any
failure as E11 or E5 work depending on what it pins.

Found: 2026-08-09 (E5). Blocked on E11.
