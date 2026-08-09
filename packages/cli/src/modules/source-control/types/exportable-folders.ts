/** A folder as serialized inside the aggregate `folders.json` file. */
export interface ExportableFolder {
	id: string;
	name: string;
	homeProjectId: string;
	parentFolderId: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Shape of the aggregate `folders.json`. Scoped rewrites must preserve
 * entries owned by projects outside the caller's scope.
 */
export interface FolderExportFile {
	folders: ExportableFolder[];
}
