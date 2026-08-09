import type { EvaluationApiError, UpsertEvaluationConfigDto } from '@n8n/api-types';
import { EvaluationErrorCode } from '@n8n/api-types';
import type { EvaluationConfig, User, WorkflowEntity } from '@n8n/db';
import { EvaluationConfigRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { getChildNodes, UserError } from 'n8n-workflow';

/**
 * Validation/lookup failure for an evaluation config, carrying the typed
 * `EvaluationErrorCode` so callers (REST controller, instance-ai adapter) can
 * map it to an `EvaluationApiError`-shaped response.
 */
export class EvaluationConfigError extends UserError {
	constructor(
		readonly code: EvaluationErrorCode,
		message: string,
		readonly details?: EvaluationApiError['details'],
	) {
		super(message, { extra: details });
	}
}

/**
 * CRUD + save-time validation for workflow-scoped evaluation configs. Callers
 * pass an already-authorized workflow entity — this service does no RBAC.
 */
@Service()
export class EvaluationConfigService {
	constructor(private readonly evaluationConfigRepository: EvaluationConfigRepository) {}

	async list(workflowId: string): Promise<EvaluationConfig[]> {
		return await this.evaluationConfigRepository.findManyByWorkflowId(workflowId);
	}

	async get(workflowId: string, configId: string): Promise<EvaluationConfig | null> {
		return await this.evaluationConfigRepository.findOneInWorkflow(configId, workflowId);
	}

	async create(
		workflowId: string,
		workflow: WorkflowEntity,
		_user: User,
		dto: UpsertEvaluationConfigDto,
	): Promise<EvaluationConfig> {
		await this.validate(workflowId, workflow, dto);

		const config = this.evaluationConfigRepository.create({
			workflowId,
			name: dto.name,
			status: 'valid' as const,
			invalidReason: null,
			datasetSource: dto.datasetSource,
			datasetRef: dto.datasetRef,
			startNodeName: dto.startNodeName,
			endNodeName: dto.endNodeName,
			metrics: dto.metrics,
		});
		return await this.evaluationConfigRepository.save(config);
	}

	async update(
		workflowId: string,
		configId: string,
		workflow: WorkflowEntity,
		_user: User,
		dto: UpsertEvaluationConfigDto,
	): Promise<EvaluationConfig> {
		const config = await this.evaluationConfigRepository.findOneInWorkflow(configId, workflowId);
		if (!config) {
			throw new EvaluationConfigError(
				EvaluationErrorCode.CONFIG_NOT_FOUND,
				`Evaluation config ${configId} not found`,
			);
		}

		await this.validate(workflowId, workflow, dto, configId);

		Object.assign(config, {
			name: dto.name,
			status: 'valid' as const,
			invalidReason: null,
			datasetSource: dto.datasetSource,
			datasetRef: dto.datasetRef,
			startNodeName: dto.startNodeName,
			endNodeName: dto.endNodeName,
			metrics: dto.metrics,
		});
		return await this.evaluationConfigRepository.save(config);
	}

	async delete(workflowId: string, configId: string): Promise<void> {
		const config = await this.evaluationConfigRepository.findOneInWorkflow(configId, workflowId);
		if (!config) {
			throw new EvaluationConfigError(
				EvaluationErrorCode.CONFIG_NOT_FOUND,
				`Evaluation config ${configId} not found`,
			);
		}
		await this.evaluationConfigRepository.delete({ id: configId });
	}

	private async validate(
		workflowId: string,
		workflow: WorkflowEntity,
		dto: UpsertEvaluationConfigDto,
		excludeId?: string,
	): Promise<void> {
		if (await this.evaluationConfigRepository.existsByName(workflowId, dto.name, excludeId)) {
			// No dedicated code exists for a config-name conflict; CONFIG_INVALID is
			// the closest typed code.
			throw new EvaluationConfigError(
				EvaluationErrorCode.CONFIG_INVALID,
				`An evaluation config named '${dto.name}' already exists on this workflow`,
			);
		}

		const nodeNames = new Set(workflow.nodes.map((node) => node.name));
		if (!nodeNames.has(dto.startNodeName)) {
			throw new EvaluationConfigError(
				EvaluationErrorCode.START_NODE_NOT_FOUND,
				`Start node '${dto.startNodeName}' does not exist on the workflow`,
				{ nodeName: dto.startNodeName },
			);
		}
		if (!nodeNames.has(dto.endNodeName)) {
			throw new EvaluationConfigError(
				EvaluationErrorCode.END_NODE_NOT_FOUND,
				`End node '${dto.endNodeName}' does not exist on the workflow`,
				{ nodeName: dto.endNodeName },
			);
		}

		// A node is reachable from itself, so start === end is always valid.
		if (
			dto.startNodeName !== dto.endNodeName &&
			!getChildNodes(workflow.connections, dto.startNodeName).includes(dto.endNodeName)
		) {
			throw new EvaluationConfigError(
				EvaluationErrorCode.END_NODE_UNREACHABLE,
				`End node '${dto.endNodeName}' is not reachable from start node '${dto.startNodeName}'`,
				{ nodeName: dto.endNodeName },
			);
		}

		this.validateMetrics(dto.metrics);
	}

	private validateMetrics(metrics: UpsertEvaluationConfigDto['metrics']): void {
		const seenIds = new Set<string>();
		const seenNames = new Set<string>();
		for (const metric of metrics) {
			if (seenIds.has(metric.id)) {
				throw new EvaluationConfigError(
					EvaluationErrorCode.DUPLICATE_METRIC_ID,
					`Duplicate metric id '${metric.id}'`,
					{ metricId: metric.id },
				);
			}
			seenIds.add(metric.id);

			if (seenNames.has(metric.name)) {
				throw new EvaluationConfigError(
					EvaluationErrorCode.DUPLICATE_METRIC_NAME,
					`Duplicate metric name '${metric.name}'`,
					{ metricName: metric.name },
				);
			}
			seenNames.add(metric.name);

			// The zod schemas require non-empty strings, but a whitespace-only
			// mapping passes `min(1)` and would resolve to nothing at run time.
			if (!('inputs' in metric.config)) continue;
			for (const [field, value] of Object.entries(metric.config.inputs)) {
				if (typeof value === 'string' && value.trim() === '') {
					throw new EvaluationConfigError(
						EvaluationErrorCode.METRIC_INPUT_EMPTY,
						`Metric '${metric.name}' has an empty input mapping for '${field}'`,
						{ metricId: metric.id, metricName: metric.name, field },
					);
				}
			}
		}
	}
}
