import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError, metricRequiresModelConnection } from 'n8n-workflow';

import {
	setInputsProperties,
	setOutputProperties,
	setMetricsProperties,
	setCheckIfEvaluatingProperties,
	sourcePicker,
} from './Description.node';
import * as methods from '../methods';
import {
	checkIfEvaluating,
	getInputConnectionTypes,
	getOutputConnectionTypes,
	setInputs,
	setMetrics,
	setOutputs,
} from '../utils/evaluationUtils';

export class Evaluation implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Evaluation',
		name: 'evaluation',
		icon: 'fa:check-double',
		iconColor: 'light-green',
		group: ['transform'],
		version: [4.6, 4.7],
		description: 'Runs an evaluation',
		subtitle: '={{ $parameter["operation"] }}',
		defaults: {
			name: 'Evaluation',
		},
		// The inputs/outputs are computed dynamically: setMetrics with an AI-based
		// metric exposes an extra ai_languageModel input, and checkIfEvaluating
		// splits the output into an evaluation and a normal branch.
		inputs: `={{((${getInputConnectionTypes})($parameter, ${metricRequiresModelConnection}))}}`,
		outputs: `={{((${getOutputConnectionTypes})($parameter))}}`,
		credentials: [
			{
				name: 'googleApi',
				required: true,
				displayOptions: {
					show: {
						source: ['googleSheets'],
					},
				},
				testedBy: 'googleApiCredentialTest',
			},
			{
				name: 'googleSheetsOAuth2Api',
				required: true,
				displayOptions: {
					show: {
						source: ['googleSheets'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,

				options: [
					{
						name: 'Set Inputs',
						value: 'setInputs',
						action: 'Set inputs',
						description: 'Add columns from your dataset to the evaluation results',
					},
					{
						name: 'Set Outputs',
						value: 'setOutputs',
						action: 'Set outputs',
						description: 'Write the results of the workflow back to your dataset',
					},
					{
						name: 'Set Metrics',
						value: 'setMetrics',
						action: 'Set metrics',
						description: 'Calculate the quality of an execution',
					},
					{
						name: 'Check If Evaluating',
						value: 'checkIfEvaluating',
						action: 'Check if evaluating',
						description:
							'Branch depending on whether the execution started from an evaluation trigger',
					},
				],
				default: 'setOutputs',
			},
			{
				...sourcePicker,
				displayOptions: {
					show: {
						operation: ['setOutputs'],
					},
				},
			},
			...setInputsProperties,
			...setOutputProperties,
			...setMetricsProperties,
			...setCheckIfEvaluatingProperties,
		],
	};

	methods = methods;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0);

		switch (operation) {
			case 'setInputs':
				return setInputs.call(this);
			case 'setOutputs':
				return await setOutputs.call(this);
			case 'setMetrics':
				return await setMetrics.call(this);
			case 'checkIfEvaluating':
				return await checkIfEvaluating.call(this);
			default:
				throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}"`);
		}
	}
}
