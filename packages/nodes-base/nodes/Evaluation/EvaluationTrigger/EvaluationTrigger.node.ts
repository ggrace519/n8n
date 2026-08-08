import type {
	DataTableColumnJsType,
	DataTableFilter,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOutput,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { document, sheet } from '../../Google/Sheet/GoogleSheetsTrigger.node';
import * as methods from '../methods';
import { getGoogleSheet, getResults, getRowsLeft, getSheet } from '../utils/evaluationTriggerUtils';

/** Upper bound used to read a whole dataset in a single request. */
const MAX_ROWS = 1000;

type DataTableFilterEntry = DataTableFilter['filters'][number];

type DataTableFilterCondition = {
	keyName: string;
	condition: DataTableFilterEntry['condition'];
	keyValue?: DataTableColumnJsType;
};

/** The range options that make the Google Sheet helpers read from the header + first data row. */
const SHEET_RANGE_OPTIONS: IDataObject = {
	rangeDefinition: 'specifyRange',
	headerRow: 1,
	firstDataRow: 2,
};

function getUserFilters(this: IExecuteFunctions): DataTableFilterEntry[] {
	const conditions = this.getNodeParameter(
		'filters.conditions',
		0,
		[],
	) as DataTableFilterCondition[];

	return conditions.map((condition) => ({
		columnName: condition.keyName,
		condition: condition.condition,
		value: condition.keyValue ?? null,
	}));
}

function getBaseFilterType(this: IExecuteFunctions): 'and' | 'or' {
	const matchType = this.getNodeParameter('matchType', 0, 'anyCondition') as string;
	return matchType === 'allConditions' ? 'and' : 'or';
}

async function getDataTableProxy(this: IExecuteFunctions) {
	if (this.helpers.getDataTableProxy === undefined) {
		throw new NodeOperationError(
			this.getNode(),
			'Attempted to use Data table node but the module is disabled',
		);
	}
	const dataTableId = this.getNodeParameter('dataTableId', 0, undefined, {
		extractValue: true,
	}) as string;
	return await this.helpers.getDataTableProxy(dataTableId);
}

async function executeGoogleSheets(this: IExecuteFunctions): Promise<NodeOutput> {
	const googleSheet = getGoogleSheet.call(this);
	const sheetInfo = await getSheet.call(this, googleSheet);

	const limitRows = this.getNodeParameter('limitRows', 0, false) as boolean;
	const maxRows = this.getNodeParameter('maxRows', 0, MAX_ROWS) as number;

	let rows = await getResults.call(this, [], googleSheet, sheetInfo, SHEET_RANGE_OPTIONS);

	if (limitRows) {
		rows = rows.slice(0, maxRows);
	}

	if (rows.length === 0) {
		return [[]];
	}

	const previousRun = this.getInputData()[0]?.json ?? {};
	const prevRowNumber =
		typeof previousRun.row_number === 'number' ? previousRun.row_number : undefined;
	const prevRowsLeft =
		typeof previousRun._rowsLeft === 'number' ? previousRun._rowsLeft : undefined;

	let currentIndex: number;
	if (prevRowNumber === undefined || prevRowsLeft === 0) {
		currentIndex = 0;
	} else {
		const previousIndex = rows.findIndex((row) => row.json?.row_number === prevRowNumber);
		currentIndex = previousIndex === -1 ? 0 : previousIndex + 1;
		if (currentIndex >= rows.length) {
			currentIndex = 0;
		}
	}

	const current = rows[currentIndex];
	const currentRowNumber = current.json?.row_number as number;

	let rowsLeft: number;
	if (limitRows) {
		rowsLeft = rows.length - currentIndex - 1;
	} else {
		rowsLeft = await getRowsLeft.call(
			this,
			googleSheet,
			sheetInfo.title,
			`${sheetInfo.title}!${currentRowNumber}:${MAX_ROWS}`,
		);
	}

	return [
		[
			{
				json: {
					...current.json,
					_rowsLeft: rowsLeft,
				},
				pairedItem: { item: 0 },
			},
		],
	];
}

async function executeDataTable(this: IExecuteFunctions): Promise<NodeOutput> {
	const dataTableProxy = await getDataTableProxy.call(this);

	const userFilters = getUserFilters.call(this);

	const previousRun = this.getInputData()[0]?.json ?? {};
	const prevRowId = typeof previousRun.row_id === 'number' ? previousRun.row_id : undefined;
	const prevRowNumber =
		typeof previousRun.row_number === 'number' ? previousRun.row_number : undefined;

	let filter: { type: 'and' | 'or'; filters: DataTableFilterEntry[] };
	if (prevRowId !== undefined) {
		filter = {
			type: 'and',
			filters: [...userFilters, { columnName: 'id', condition: 'gt', value: prevRowId }],
		};
	} else {
		filter = {
			type: getBaseFilterType.call(this),
			filters: userFilters,
		};
	}

	const { data, count } = await dataTableProxy.getManyRowsAndCount({
		skip: 0,
		take: 1,
		filter,
	});

	if (!data.length) {
		return [[]];
	}

	const row = data[0];
	const rowNumber = prevRowNumber === undefined ? 0 : prevRowNumber + 1;

	return [
		[
			{
				json: {
					...row,
					row_id: row.id,
					row_number: rowNumber,
					_rowsLeft: count - 1,
				},
				pairedItem: { item: 0 },
			},
		],
	];
}

async function getRowsGoogleSheets(this: IExecuteFunctions): Promise<NodeOutput> {
	const googleSheet = getGoogleSheet.call(this);
	const sheetInfo = await getSheet.call(this, googleSheet);

	const limitRows = this.getNodeParameter('limitRows', 0, false) as boolean;
	const maxRows = this.getNodeParameter('maxRows', 0, MAX_ROWS) as number;

	let rows = await getResults.call(this, [], googleSheet, sheetInfo, SHEET_RANGE_OPTIONS);

	if (limitRows) {
		rows = rows.slice(0, maxRows);
	}

	return [rows];
}

async function getRowsDataTable(this: IExecuteFunctions): Promise<NodeOutput> {
	const dataTableProxy = await getDataTableProxy.call(this);

	const limitRows = this.getNodeParameter('limitRows', 0, false) as boolean;
	const maxRows = this.getNodeParameter('maxRows', 0, MAX_ROWS) as number;

	const { data } = await dataTableProxy.getManyRowsAndCount({
		skip: 0,
		take: limitRows ? maxRows : MAX_ROWS,
		filter: {
			type: getBaseFilterType.call(this),
			filters: getUserFilters.call(this),
		},
	});

	const rows: INodeExecutionData[] = data.map((row, index) => ({
		json: {
			...row,
			row_id: row.id,
			row_number: index,
		},
		pairedItem: { item: 0 },
	}));

	return [rows];
}

export class EvaluationTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Evaluation Trigger',
		name: 'evaluationTrigger',
		icon: 'fa:check-double',
		iconColor: 'light-green',
		group: ['trigger'],
		version: [4.6, 4.7],
		description: 'Run a test dataset through your workflow to check performance',
		eventTriggerDescription: '',
		defaults: {
			name: 'When fetching a dataset row',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
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
				displayName: 'Source',
				name: 'source',
				type: 'options',
				options: [
					{
						// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
						name: 'Data table',
						value: 'dataTable',
						description: 'Load the test dataset from a local Data table',
					},
					{
						name: 'Google Sheets',
						value: 'googleSheets',
						description: 'Load the test dataset from a Google Sheets document',
					},
				],
				default: 'dataTable',
				description: 'Where to read the test dataset from',
			},
			{
				...document,
				displayName: 'Document Containing Dataset',
				displayOptions: {
					hide: { source: ['dataTable'] },
				},
			},
			{
				...sheet,
				displayName: 'Sheet Containing Dataset',
				displayOptions: {
					hide: { source: ['dataTable'] },
				},
			},
			{
				// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
				displayName: 'Data table',
				name: 'dataTableId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'dataTableSearch',
							searchable: true,
							skipCredentialsCheckInRLC: true,
						},
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
					},
				],
				displayOptions: {
					show: { source: ['dataTable'] },
				},
			},
			{
				displayName: 'Filter',
				name: 'filtersUI',
				placeholder: 'Add Filter',
				type: 'fixedCollection',
				typeOptions: {
					multipleValueButtonText: 'Add Filter',
					multipleValues: true,
				},
				default: {},
				options: [
					{
						displayName: 'Filter',
						name: 'values',
						values: [
							{
								// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
								displayName: 'Column',
								name: 'lookupColumn',
								type: 'options',
								typeOptions: {
									loadOptionsDependsOn: ['sheetName.value'],
									loadOptionsMethod: 'getSheetHeaderRowWithGeneratedColumnNames',
								},
								default: '',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Value',
								name: 'lookupValue',
								type: 'string',
								default: '',
								hint: 'The column must have this value to be matched',
							},
						],
					},
				],
				displayOptions: {
					hide: { source: ['dataTable'] },
				},
			},
			{
				displayName: 'Combine Filters',
				name: 'combineFilters',
				type: 'options',
				options: [
					{
						name: 'AND',
						value: 'AND',
						description: 'Only rows matching all filters are chosen',
					},
					{
						name: 'OR',
						value: 'OR',
						description: 'Rows matching at least one filter are chosen',
					},
				],
				default: 'AND',
				displayOptions: {
					hide: { source: ['dataTable'] },
				},
			},
			{
				displayName: 'Must Match',
				name: 'matchType',
				type: 'options',
				options: [
					{
						name: 'Any Condition',
						value: 'anyCondition',
					},
					{
						name: 'All Conditions',
						value: 'allConditions',
					},
				],
				default: 'anyCondition',
				displayOptions: {
					show: { source: ['dataTable'] },
				},
			},
			{
				displayName: 'Conditions',
				name: 'filters',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				placeholder: 'Add Condition',
				options: [
					{
						displayName: 'Conditions',
						name: 'conditions',
						values: [
							{
								// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
								displayName: 'Column',
								name: 'keyName',
								type: 'options',
								description:
									'Choose from the list, or specify using an <a href="https://docs.n8n.io/code/expressions/">expression</a>. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
								typeOptions: {
									loadOptionsDependsOn: ['dataTableId.value'],
									loadOptionsMethod: 'getDataTableColumns',
								},
								default: 'id',
							},
							{
								// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
								displayName: 'Condition',

								name: 'condition',
								type: 'options',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
								typeOptions: {
									loadOptionsDependsOn: ['&keyName'],
									loadOptionsMethod: 'getConditionsForColumn',
								},
								default: 'eq',
							},
							{
								displayName: 'Value',
								name: 'keyValue',
								type: 'string',
								default: '',
								displayOptions: {
									hide: {
										condition: ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'],
									},
								},
							},
						],
					},
				],
				displayOptions: {
					show: { source: ['dataTable'] },
				},
			},
			{
				displayName: 'Limit Rows',
				name: 'limitRows',
				type: 'boolean',
				default: false,
				description: 'Whether to limit the number of rows to process',
			},
			{
				displayName: 'Max Rows to Process',
				name: 'maxRows',
				type: 'number',
				default: 10,
				description: 'Maximum number of rows to process',
				displayOptions: {
					show: {
						limitRows: [true],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [],
				displayOptions: {
					hide: { source: ['dataTable'] },
				},
			},
		],
	};

	methods = methods;

	customOperations = {
		dataset: {
			async getRows(this: IExecuteFunctions): Promise<NodeOutput> {
				const source = this.getNodeParameter('source', 0, 'googleSheets') as string;
				if (source === 'dataTable') {
					return await getRowsDataTable.call(this);
				}
				return await getRowsGoogleSheets.call(this);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<NodeOutput> {
		const source = this.getNodeParameter('source', 0, 'googleSheets') as string;
		if (source === 'dataTable') {
			return await executeDataTable.call(this);
		}
		return await executeGoogleSheets.call(this);
	}
}
