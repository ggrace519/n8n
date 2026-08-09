import type { IdentityProviderInstance } from 'samlify';
import type * as Samlify from 'samlify';
import type { FlowResult } from 'samlify/types/src/flow';

import { AuthError } from '@/errors/response-errors/auth.error';

import type { SamlLoginBinding } from './types';

/** Tolerance applied to every `NotBefore` / `NotOnOrAfter` comparison. */
export const SAML_CLOCK_SKEW_MS = 60_000;

const BEARER_CONFIRMATION_METHOD = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

const ASSERTION_START = /<([A-Za-z0-9_.-]+:)?Assertion[\s>]/;
const SIGNATURE_START = /<([A-Za-z0-9_.-]+:)?Signature[\s>]/;
const SIGNATURE_END = /<\/([A-Za-z0-9_.-]+:)?Signature\s*>/g;

type SamlifyModule = typeof Samlify;

/** Bearer confirmation data plus the conditions of the authenticated assertion. */
export type AssertionBinding = {
	assertionId?: string;
	audiences: string[];
	recipient?: string;
	subjectNotOnOrAfter?: string;
	subjectInResponseTo?: string;
	confirmationMethods: string[];
	conditionsNotBefore?: string;
	conditionsNotOnOrAfter?: string;
};

export type ResponseSignatureAnalysis = {
	/** Assertion fragment the signature verification authenticated, when any. */
	assertionXml?: string;
	/** True when a signature over the assertion itself verified on its own. */
	assertionSignatureVerified: boolean;
	/** True when the response element carries a signature. */
	responseSignaturePresent: boolean;
};

export type SamlResponseValidationInput = {
	samlify: SamlifyModule;
	idp: IdentityProviderInstance;
	flowResult: FlowResult;
	binding: SamlLoginBinding;
	/** Our service-provider entity ID; the assertion must be addressed to it. */
	expectedAudience: string;
	/** Our assertion consumer service URL. */
	expectedAcsUrl: string;
	wantAssertionsSigned: boolean;
	wantMessageSigned: boolean;
	now?: Date;
};

export type SamlResponseValidationResult = {
	/** `InResponseTo` taken from the authenticated assertion. */
	requestId: string;
	responseId?: string;
	assertionId?: string;
	/** Instant after which the response can no longer be valid. */
	validUntil: number;
};

const fail = (reason: string): never => {
	throw new AuthError(`SAML login failed: ${reason}`);
};

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function readStringList(value: unknown): string[] {
	if (typeof value === 'string') return value === '' ? [] : [value];
	if (Array.isArray(value))
		return value.filter((entry): entry is string => typeof entry === 'string');
	return [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseInstant(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Remove the response-level `<Signature>` element. The assertion's own
 * signature covers only the assertion subtree, so dropping a sibling element
 * leaves that signature verifiable.
 *
 * Only the text before the first `<Assertion>` is searched, which relies on
 * `samlp:StatusResponseType` being an XSD `sequence` (Issuer, Signature,
 * Extensions, Status, Assertion) and on `SamlValidator.validateResponse`
 * running against that schema before any signature is verified. Were a
 * response-level signature allowed to follow the assertion, it would be
 * reported as absent here and the caller could mistake it for a verified
 * assertion signature — so keep the schema validation ahead of this.
 */
export function splitResponseSignature(xml: string): {
	responseSignaturePresent: boolean;
	withoutResponseSignature?: string;
} {
	const assertionMatch = ASSERTION_START.exec(xml);
	const head = xml.slice(0, assertionMatch?.index ?? xml.length);

	const signatureStart = SIGNATURE_START.exec(head);
	if (!signatureStart) return { responseSignaturePresent: false, withoutResponseSignature: xml };

	SIGNATURE_END.lastIndex = 0;
	let signatureEnd = -1;
	for (let match = SIGNATURE_END.exec(head); match !== null; match = SIGNATURE_END.exec(head)) {
		signatureEnd = match.index + match[0].length;
	}
	if (signatureEnd <= signatureStart.index) {
		// unterminated signature element: no stripped document can be produced
		return { responseSignaturePresent: true };
	}

	return {
		responseSignaturePresent: true,
		withoutResponseSignature: xml.slice(0, signatureStart.index) + xml.slice(signatureEnd),
	};
}

/**
 * Determine which signatures of a login response hold. samlify accepts a
 * response as soon as either the message or the assertion signature verifies,
 * so the assertion signature is re-checked on a document from which the
 * response-level signature has been removed.
 */
export function analyzeResponseSignatures(
	samlify: SamlifyModule,
	idp: IdentityProviderInstance,
	samlContent: string,
): ResponseSignatureAnalysis {
	const verifierOptions = {
		metadata: idp.entityMeta,
		signatureAlgorithm: idp.entitySetting.requestSignatureAlgorithm,
	};

	const verify = (xml: string): [boolean, string | null] => {
		try {
			return samlify.SamlLib.verifySignature(xml, verifierOptions);
		} catch {
			return [false, null];
		}
	};

	const [, authenticatedAssertion] = verify(samlContent);
	const { responseSignaturePresent, withoutResponseSignature } =
		splitResponseSignature(samlContent);

	let assertionSignatureVerified = false;
	let assertionXml = authenticatedAssertion ?? undefined;
	if (withoutResponseSignature !== undefined) {
		const [verified, assertionOnly] = verify(withoutResponseSignature);
		assertionSignatureVerified = verified;
		if (verified && assertionOnly) assertionXml = assertionOnly;
	}

	if (!assertionXml) {
		// no signature authenticated an assertion (redirect binding relies on the
		// detached message signature); fall back to the assertion element itself
		const extracted = samlify.Extractor.extract(samlContent, [
			{ key: 'assertion', localPath: ['~Response', 'Assertion'], attributes: [], context: true },
		]);
		assertionXml = readString(extracted.assertion);
	}

	return { assertionXml, assertionSignatureVerified, responseSignaturePresent };
}

/** Read the audience, bearer confirmation data and conditions of an assertion. */
export function extractAssertionBinding(
	samlify: SamlifyModule,
	assertionXml: string,
): AssertionBinding {
	const extracted = samlify.Extractor.extract(assertionXml, [
		{ key: 'assertion', localPath: ['Assertion'], attributes: ['ID'] },
		{
			key: 'audience',
			localPath: ['Assertion', 'Conditions', 'AudienceRestriction', 'Audience'],
			attributes: [],
		},
		{
			key: 'conditions',
			localPath: ['Assertion', 'Conditions'],
			attributes: ['NotBefore', 'NotOnOrAfter'],
		},
		{
			key: 'confirmationMethod',
			localPath: ['Assertion', 'Subject', 'SubjectConfirmation'],
			attributes: ['Method'],
		},
		{
			key: 'confirmationData',
			localPath: ['Assertion', 'Subject', 'SubjectConfirmation', 'SubjectConfirmationData'],
			attributes: ['Recipient', 'NotOnOrAfter', 'InResponseTo'],
		},
	]);

	const conditions = readRecord(extracted.conditions);
	const confirmationData = readRecord(extracted.confirmationData);

	return {
		assertionId: readString(readRecord(extracted.assertion)?.id),
		audiences: readStringList(extracted.audience),
		recipient: readString(confirmationData?.recipient),
		subjectNotOnOrAfter: readString(confirmationData?.notOnOrAfter),
		subjectInResponseTo: readString(confirmationData?.inResponseTo),
		confirmationMethods: readStringList(extracted.confirmationMethod),
		conditionsNotBefore: readString(conditions?.notBefore),
		conditionsNotOnOrAfter: readString(conditions?.notOnOrAfter),
	};
}

/**
 * Validate that an authenticated login response was issued for this service
 * provider and for a login this instance started. Every check is made against
 * the assertion the signature verification authenticated.
 *
 * Enforced:
 * - the configured signature requirements,
 * - exactly one bearer `SubjectConfirmation` with confirmation data,
 * - `Audience` equal to our entity ID,
 * - `Recipient` (and `Destination`, when present) equal to our ACS URL,
 * - `Conditions` and `SubjectConfirmationData` validity windows,
 * - `InResponseTo` present on both the response and the confirmation data,
 *   identical, and matching a request this instance issued.
 */
export function validateSamlLoginResponse(
	input: SamlResponseValidationInput,
): SamlResponseValidationResult {
	const {
		samlify,
		idp,
		flowResult,
		binding,
		expectedAudience,
		expectedAcsUrl,
		wantAssertionsSigned,
		wantMessageSigned,
	} = input;
	const now = (input.now ?? new Date()).getTime();

	const samlContent = readString(flowResult.samlContent);
	if (!samlContent) return fail('the response could not be read');

	const signatures = analyzeResponseSignatures(samlify, idp, samlContent);
	if (!signatures.assertionXml) return fail('the response contains no assertion');

	if (wantAssertionsSigned && !signatures.assertionSignatureVerified) {
		return fail('the assertion is not signed by the configured identity provider');
	}
	if (wantMessageSigned) {
		// The service-provider metadata only advertises the assertion
		// requirement, so a message signature is treated as satisfied by any
		// signature of the configured identity provider that covers the values
		// acted on: the response element itself, or the assertion (whose own
		// signature verified independently and carries the counterpart of every
		// response field checked below).
		const messageCovered =
			binding === 'redirect'
				? readString(flowResult.sigAlg) !== undefined
				: signatures.responseSignaturePresent || signatures.assertionSignatureVerified;
		if (!messageCovered) return fail('the response is not signed');
	}

	const assertion = extractAssertionBinding(samlify, signatures.assertionXml);
	const response = readRecord(flowResult.extract.response);

	if (assertion.confirmationMethods.length !== 1) {
		return fail('the assertion does not carry exactly one subject confirmation');
	}
	if (assertion.confirmationMethods[0] !== BEARER_CONFIRMATION_METHOD) {
		return fail('the assertion does not use bearer subject confirmation');
	}
	if (!assertion.recipient || !assertion.subjectNotOnOrAfter || !assertion.subjectInResponseTo) {
		return fail('the assertion is missing bearer subject confirmation data');
	}

	if (!assertion.audiences.includes(expectedAudience)) {
		return fail('the assertion is addressed to a different audience');
	}
	if (assertion.recipient !== expectedAcsUrl) {
		return fail('the assertion is addressed to a different recipient');
	}

	const destination = readString(response?.destination);
	if (destination !== undefined && destination !== expectedAcsUrl) {
		return fail('the response is addressed to a different destination');
	}

	const conditionsNotOnOrAfter = parseInstant(assertion.conditionsNotOnOrAfter);
	if (conditionsNotOnOrAfter === undefined) {
		return fail('the assertion does not declare a validity window');
	}
	if (now >= conditionsNotOnOrAfter + SAML_CLOCK_SKEW_MS) {
		return fail('the assertion validity window has passed');
	}
	const conditionsNotBefore = parseInstant(assertion.conditionsNotBefore);
	if (conditionsNotBefore !== undefined && now < conditionsNotBefore - SAML_CLOCK_SKEW_MS) {
		return fail('the assertion is not valid yet');
	}

	const subjectNotOnOrAfter = parseInstant(assertion.subjectNotOnOrAfter);
	if (subjectNotOnOrAfter === undefined) {
		return fail('the subject confirmation data does not declare a validity window');
	}
	if (now >= subjectNotOnOrAfter + SAML_CLOCK_SKEW_MS) {
		return fail('the subject confirmation validity window has passed');
	}

	const responseInResponseTo = readString(response?.inResponseTo);
	if (!responseInResponseTo) {
		return fail('the response does not refer to a login request');
	}
	if (responseInResponseTo !== assertion.subjectInResponseTo) {
		return fail('the response and the assertion refer to different login requests');
	}

	return {
		requestId: assertion.subjectInResponseTo,
		responseId: readString(response?.id),
		assertionId: assertion.assertionId,
		validUntil: Math.max(conditionsNotOnOrAfter, subjectNotOnOrAfter) + SAML_CLOCK_SKEW_MS,
	};
}
