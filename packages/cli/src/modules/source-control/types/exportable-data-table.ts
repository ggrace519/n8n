import type { StructuredResourceOwner } from './resource-owner';

export interface ExportableDataTableColumn {
	id: string;
	name: string;
	type: string;
	index: number;
}

/**
 * A data table as serialized to `datatables/<id>.json`. Only the schema is
 * exported (columns sorted ascending by `index`) — never row data.
 */
export interface ExportableDataTable {
	id: string;
	name: string;
	columns: ExportableDataTableColumn[];
	ownedBy: StructuredResourceOwner | null;
	createdAt: string;
	updatedAt: string;
}
