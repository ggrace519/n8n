import { z } from 'zod';

import { Z } from '../../zod-class';
import { publicApiPaginationSchema } from '../pagination/pagination.dto';

export class UsersListQueryDto extends Z.class({
	...publicApiPaginationSchema,
	cursor: z.string().optional(),
	// Query flags arrive as strings; coerce `?includeRole=true` to a boolean.
	includeRole: z
		.string()
		.optional()
		.transform((value) => value === 'true'),
}) {}
