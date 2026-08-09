import type { EvaluationMetric } from '@n8n/api-types';
import { LLM_JUDGE_PROVIDERS } from '@n8n/api-types';
import type { EvaluationConfig } from '@n8n/db';
import { Service } from '@n8n/di';
import type {
	IConnections,
	IDataObject,
	INode,
	IWorkflowBase,
	NodeParameterValueType,
} from 'n8n-workflow';
import {
	EVALUATION_NODE_TYPE,
	EVALUATION_TRIGGER_NODE_TYPE,
	UserError,
	deepCopy,
} from 'n8n-workflow';
import { nanoid } from 'nanoid';

/**
 * Injected nodes are namespaced under this prefix; a workflow already using it
 * would collide with (or spoof) compiled nodes, so config validation rejects
 * such workflows up front (`RESERVED_PREFIX_IN_USE`).
 */
export const RESERVED_EVAL_NODE_PREFIX = '__eval/';

/** Non-RL chat-model nodes whose model parameter is named `modelName`. */
const MODEL_NAME_PARAM_PROVIDERS = new Set([
	'@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
	'@n8n/n8n-nodes-langchain.lmChatGoogleVertex',
]);

/**
 * Compiles an evaluation config onto a workflow: injects an Evaluation
 * Trigger reading the config's dataset, routes it into the config's start
 * node, and appends one Set Metrics Evaluation node per metric after the end
 * node (LLM-judge metrics also get their chat-model node wired via
 * `ai_languageModel`). The saved workflow is never modified — the compiled
 * copy exists only for the duration of a test run.
 */
@Service()
export class WorkflowCompilerService {
	compile(workflow: IWorkflowBase, config: EvaluationConfig): IWorkflowBase {
		const compiled = deepCopy(workflow);

		const reserved = compiled.nodes.find((node) => node.name.startsWith(RESERVED_EVAL_NODE_PREFIX));
		if (reserved) {
			throw new UserError(
				`Workflow node "${reserved.name}" uses the reserved evaluation prefix "${RESERVED_EVAL_NODE_PREFIX}"`,
			);
		}

		const startNode = compiled.nodes.find((node) => node.name === config.startNodeName);
		if (!startNode) {
			throw new UserError(`Start node "${config.startNodeName}" no longer exists on the workflow`);
		}
		const endNode = compiled.nodes.find((node) => node.name === config.endNodeName);
		if (!endNode) {
			throw new UserError(`End node "${config.endNodeName}" no longer exists on the workflow`);
		}

		// Any triggers already on the canvas are disabled so the injected
		// evaluation trigger is unambiguously the entry point.
		for (const node of compiled.nodes) {
			if (node.type === EVALUATION_TRIGGER_NODE_TYPE) node.disabled = true;
		}

		const triggerName = `${RESERVED_EVAL_NODE_PREFIX}trigger`;
		const trigger = this.buildTriggerNode(triggerName, config, this.nextPosition(startNode, -1));
		compiled.nodes.push(trigger);
		this.connect(compiled.connections, triggerName, config.startNodeName);

		let previous = config.endNodeName;
		config.metrics.forEach((metric, index) => {
			const metricNodeName = `${RESERVED_EVAL_NODE_PREFIX}metric/${metric.name}`;
			const metricNode = this.buildMetricNode(
				metricNodeName,
				metric,
				this.nextPosition(endNode, index + 1),
			);
			compiled.nodes.push(metricNode);
			this.connect(compiled.connections, previous, metricNodeName);
			previous = metricNodeName;

			if (metric.type === 'llm_judge') {
				const modelNodeName = `${RESERVED_EVAL_NODE_PREFIX}judge-model/${metric.name}`;
				compiled.nodes.push(
					this.buildJudgeModelNode(
						modelNodeName,
						metric,
						this.nextPosition(endNode, index + 1, 200),
					),
				);
				this.connect(compiled.connections, modelNodeName, metricNodeName, 'ai_languageModel');
			}
		});

		return compiled;
	}

	private buildTriggerNode(
		name: string,
		config: EvaluationConfig,
		position: [number, number],
	): INode {
		const parameters: IDataObject =
			config.datasetSource === 'data_table'
				? {
						source: 'dataTable',
						dataTableId: {
							__rl: true,
							mode: 'id',
							value: 'dataTableId' in config.datasetRef ? config.datasetRef.dataTableId : '',
						},
					}
				: {
						source: 'googleSheets',
						documentId: {
							__rl: true,
							mode: 'id',
							value: 'spreadsheetId' in config.datasetRef ? config.datasetRef.spreadsheetId : '',
						},
						sheetName: {
							__rl: true,
							mode: 'name',
							value: 'sheetName' in config.datasetRef ? config.datasetRef.sheetName : '',
						},
					};

		const node: INode = {
			id: nanoid(),
			name,
			type: EVALUATION_TRIGGER_NODE_TYPE,
			typeVersion: 4.7,
			position,
			parameters: parameters as INode['parameters'],
		};
		if (config.datasetSource === 'google_sheets' && 'credentialId' in config.datasetRef) {
			node.credentials = {
				googleSheetsOAuth2Api: { id: config.datasetRef.credentialId, name: 'Google Sheets' },
			};
		}
		return node;
	}

	private buildMetricNode(
		name: string,
		metric: EvaluationMetric,
		position: [number, number],
	): INode {
		let parameters: IDataObject;
		switch (metric.type) {
			case 'llm_judge': {
				const { config } = metric;
				parameters = {
					operation: 'setMetrics',
					metric: config.preset,
					actualAnswer: config.inputs.actualAnswer,
					...(config.inputs.expectedAnswer ? { expectedAnswer: config.inputs.expectedAnswer } : {}),
					...(config.inputs.userQuery ? { userQuery: config.inputs.userQuery } : {}),
					// Omitted prompt falls back to the node's canned per-preset prompt.
					...(config.prompt ? { prompt: config.prompt } : {}),
					options: { metricName: metric.name },
				};
				break;
			}
			case 'string_similarity':
			case 'categorization':
				parameters = {
					operation: 'setMetrics',
					metric: metric.type === 'string_similarity' ? 'stringSimilarity' : 'categorization',
					actualAnswer: metric.config.inputs.actualAnswer,
					expectedAnswer: metric.config.inputs.expectedAnswer,
					options: { metricName: metric.name },
				};
				break;
			case 'tools_used':
				parameters = {
					operation: 'setMetrics',
					metric: 'toolsUsed',
					expectedTools: metric.config.inputs.expectedTools,
					intermediateSteps: metric.config.inputs.intermediateSteps,
					options: { metricName: metric.name },
				};
				break;
			case 'expression':
				parameters = {
					operation: 'setMetrics',
					metric: 'customMetrics',
					metrics: {
						assignments: [
							{
								id: metric.id,
								name: metric.name,
								value: metric.config.expression,
								type: metric.config.outputType === 'boolean' ? 'boolean' : 'number',
							},
						],
					},
				};
				break;
		}

		return {
			id: nanoid(),
			name,
			type: EVALUATION_NODE_TYPE,
			typeVersion: 4.7,
			position,
			parameters: parameters as INode['parameters'],
		};
	}

	private buildJudgeModelNode(
		name: string,
		metric: Extract<EvaluationMetric, { type: 'llm_judge' }>,
		position: [number, number],
	): INode {
		const { provider, credentialId, model } = metric.config;
		// The model parameter's name/shape varies by provider node; the common
		// cases are mapped, the rest take a plain `model` string.
		// All nodes are emitted at typeVersion 1, where `model` is a plain
		// string (later versions moved some to resource locators).
		let modelParameters: Record<string, NodeParameterValueType>;
		if (MODEL_NAME_PARAM_PROVIDERS.has(provider)) {
			modelParameters = { modelName: model };
		} else {
			modelParameters = { model };
		}

		// One credential type per provider is the canonical mapping; when a
		// provider lists several (Azure), the credential id decides at runtime —
		// attach it under every listed type so whichever the node wants resolves.
		const credentialTypes = this.credentialTypesForProvider(provider);
		const credentials: INode['credentials'] = {};
		for (const type of credentialTypes) {
			credentials[type] = { id: credentialId, name: 'LLM judge credential' };
		}

		return {
			id: nanoid(),
			name,
			type: provider,
			typeVersion: 1,
			position,
			parameters: modelParameters as INode['parameters'],
			credentials,
		};
	}

	private credentialTypesForProvider(provider: string): string[] {
		const entry = LLM_JUDGE_PROVIDERS.find((p) => p.nodeType === provider);
		return entry ? entry.credentialTypes.map((c) => c.name) : [];
	}

	private connect(
		connections: IConnections,
		from: string,
		to: string,
		type: 'main' | 'ai_languageModel' = 'main',
	) {
		const byType = (connections[from] ??= {});
		const outputs = (byType[type] ??= [[]]);
		(outputs[0] ??= []).push({ node: to, type, index: 0 });
	}

	private nextPosition(anchor: INode, step: number, yOffset = 0): [number, number] {
		return [anchor.position[0] + step * 220, anchor.position[1] + yOffset];
	}
}
