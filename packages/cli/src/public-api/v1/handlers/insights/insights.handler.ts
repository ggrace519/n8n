import { InsightsDateFilterDto } from '@n8n/api-types';
import { Container } from '@n8n/di';
import { hasGlobalScope } from '@n8n/permissions';
import { DateTime } from 'luxon';
import { UserError } from 'n8n-workflow';
import { z } from 'zod';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { InsightsService } from '@/modules/insights/insights.service';
import type { InsightsRequest } from '@/public-api/types';
import { ProjectService } from '@/services/project.service';

import type { PublicAPIEndpoint } from '../../shared/handler.types';
import { publicApiScope } from '../../shared/middlewares/global.middleware';

const handleError = (error: unknown) => {
	if (error instanceof UserError) {
		throw new ForbiddenError(error.message);
	}

	throw error;
};

const dateFilterValidationSchema = z
	.object({
		startDate: z.coerce.date().optional(),
		endDate: z.coerce.date().optional(),
	})
	.refine(
		(data) => {
			if (data.startDate && data.endDate) {
				return data.startDate <= data.endDate;
			}

			return true;
		},
		{
			message: 'endDate must be the same as or after startDate',
			path: ['endDate'],
		},
	);

type InsightsHandlers = {
	getInsightsSummary: PublicAPIEndpoint<InsightsRequest.GetSummary>;
};

const insightsHandlers: InsightsHandlers = {
	getInsightsSummary: [
		publicApiScope('insights:read'),
		async (req, res) => {
			const query = InsightsDateFilterDto.safeParse(req.query);
			if (!query.success) {
				throw new BadRequestError(query.error.errors.map(({ message }) => message).join('; '));
			}

			const validation = dateFilterValidationSchema.safeParse(query.data);
			if (!validation.success) {
				throw new BadRequestError(validation.error.errors.map(({ message }) => message).join('; '));
			}

			// The key gate only checks the key's scope. Instance-wide insights need
			// `insights:list` globally (as the REST route does); anyone else may read
			// only a project whose role grants it.
			if (!hasGlobalScope(req.user, 'insights:list')) {
				const { projectId } = query.data;
				if (!projectId) {
					throw new ForbiddenError('Pass a projectId to read the insights of one of your projects');
				}
				const project = await Container.get(ProjectService).getProjectWithScope(
					req.user,
					projectId,
					['insights:list'],
				);
				if (!project) {
					throw new NotFoundError(`Could not find project with ID: ${projectId}`);
				}
			}

			const endDate = query.data.endDate ?? new Date();
			const startDate = query.data.startDate ?? DateTime.now().minus({ days: 7 }).toJSDate();

			try {
				Container.get(InsightsService).validateDateFiltersLicense({ startDate, endDate });
			} catch (error) {
				return handleError(error);
			}

			const summary = await Container.get(InsightsService).getInsightsSummary({
				startDate,
				endDate,
				projectId: query.data.projectId,
			});

			return res.json(summary);
		},
	],
};

export = insightsHandlers;
