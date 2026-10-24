import type { BooleanLicenseFeature } from '@n8n/constants';
import { mock } from 'vitest-mock-extended';

import type { License } from '@/license';

vi.mock('@/constants', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/constants')>()),
	inE2ETests: true,
}));

const { E2EController } = await import('../e2e.controller');

type Request = Parameters<InstanceType<typeof E2EController>['setFeature']>[0];

const featureRequest = (feature: BooleanLicenseFeature, enabled: boolean) =>
	mock<Request>({ body: { feature, enabled } });

/** Builds the controller over a License whose real answer is `shipped`. */
const setup = (shipped: (feature: BooleanLicenseFeature) => boolean) => {
	const license = mock<License>();
	license.isLicensed.mockImplementation(shipped);
	const args = Array.from({ length: 12 }, () => mock());
	const controller = new E2EController(license, ...(args as never[]));
	return { license, controller };
};

describe('E2EController feature overrides', () => {
	const shipsSharing = (feature: BooleanLicenseFeature) => feature === 'feat:sharing';

	it('falls through to the real license answer when no override is set', () => {
		const { license } = setup(shipsSharing);

		expect(license.isLicensed('feat:sharing')).toBe(true);
		expect(license.isLicensed('feat:aiAssistant')).toBe(false);
	});

	it('lets a test switch a shipped feature off and a gated feature on', () => {
		const { license, controller } = setup(shipsSharing);

		controller.setFeature(featureRequest('feat:sharing', false));
		controller.setFeature(featureRequest('feat:aiAssistant', true));

		expect(license.isLicensed('feat:sharing')).toBe(false);
		expect(license.isLicensed('feat:aiAssistant')).toBe(true);
	});
});
