import { z } from 'zod';

import { Z } from '../../zod-class';

/**
 * The public-API shape of a user. Deliberately narrow: it never exposes
 * credentials, personalization answers, or auth internals. The global role is a
 * plain slug string and is only present when the caller requested it.
 */
export const userPublicSchema = z.object({
	id: z.string(),
	email: z.string(),
	firstName: z.string().nullable(),
	lastName: z.string().nullable(),
	isPending: z.boolean(),
	mfaEnabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
	role: z.string().optional(),
});

export class UserPublicDto extends Z.class(userPublicSchema.shape) {}

export class UserListPublicDto extends Z.class({
	data: z.array(userPublicSchema),
	nextCursor: z.string().nullable(),
}) {}
