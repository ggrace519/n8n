import { ListDataTableQueryDto } from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Get, Query, RestController } from '@n8n/decorators';

import { DataTableAggregateService } from './data-table-aggregate.service';
import { DataTableService } from './data-table.service';

@RestController('/data-tables-global')
export class DataTableAggregateController {
	constructor(
		private readonly dataTableAggregateService: DataTableAggregateService,
		private readonly dataTableService: DataTableService,
	) {}

	// No global scope: members list the tables of projects whose role grants
	// dataTable:listProject; the service scopes results to the caller.
	@Get('/')
	async listDataTables(
		req: AuthenticatedRequest,
		_res: Response,
		@Query payload: ListDataTableQueryDto,
	) {
		return await this.dataTableAggregateService.getManyAndCount(req.user, payload);
	}

	@Get('/limits')
	async getDataTablesSize(req: AuthenticatedRequest) {
		return await this.dataTableService.getDataTablesSize(req.user);
	}
}
