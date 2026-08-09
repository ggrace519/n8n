import { Service } from '@n8n/di';

import type { ExecutionRequest } from './execution.types';
import { ExecutionService } from './execution.service';

/**
 * Sharing-licensed execution reads. The community `ExecutionService.findOne`
 * is already access-scoped by the caller-supplied accessible workflow IDs
 * (which, with sharing enabled, include shared workflows via the role-based
 * finder), so the licensed path shares its implementation; this seam exists
 * so sharing-specific read behavior has a home if it ever diverges.
 */
@Service()
export class EnterpriseExecutionsService {
	constructor(private readonly executionService: ExecutionService) {}

	async findOne(
		req: ExecutionRequest.GetOne,
		sharedWorkflowIds: string[],
	): ReturnType<ExecutionService['findOne']> {
		return await this.executionService.findOne(req, sharedWorkflowIds);
	}
}
