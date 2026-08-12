import {
	RoleChangeRequestDto,
	UserListPublicDto,
	UserPublicDto,
	UsersListQueryDto,
} from '@n8n/api-types';
import { LICENSE_FEATURES } from '@n8n/constants';
import type { AuthenticatedRequest, User } from '@n8n/db';
import {
	ApiDescription,
	ApiErrorResponse,
	ApiKeyScope,
	ApiResponse,
	ApiSummary,
	ApiTags,
	Body,
	Delete,
	Get,
	Licensed,
	Param,
	Patch,
	Post,
	PublicApiController,
	Query,
} from '@n8n/decorators';
import { Container } from '@n8n/di';
import type { Response } from 'express';

import { UsersController } from '@/controllers/users.controller';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { decodeCursor, encodeNextCursor } from '@/public-api/v1/shared/services/pagination.service';
import type { UserRequest } from '@/requests';
import { UserService } from '@/services/user.service';

type CreateUsersRequest = AuthenticatedRequest<{}, {}, Array<{ email: string; role?: string }>>;
type InviteResult = Awaited<ReturnType<UserService['inviteUsers']>>['usersInvited'];

/**
 * Public-API projection of a user. Never leaks credentials, personalization
 * answers, or auth internals; the global role is a plain slug string, present
 * only when the caller asked for it.
 */
function toPublicUser(user: User, includeRole: boolean): UserPublicDto {
	return {
		id: user.id,
		email: user.email,
		firstName: user.firstName,
		lastName: user.lastName,
		isPending: user.isPending,
		mfaEnabled: user.mfaEnabled,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
		...(includeRole ? { role: user.role?.slug } : {}),
	};
}

@PublicApiController('/users')
export class UsersPublicController {
	constructor(private readonly userService: UserService) {}

	@Get('/')
	@ApiKeyScope('user:list')
	@ApiSummary('Retrieve all users')
	@ApiDescription('Retrieve all users from your instance. Only available for the instance owner.')
	@ApiTags(['User'])
	@ApiResponse(200, UserListPublicDto)
	async getUsers(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query: UsersListQueryDto,
	): Promise<UserListPublicDto> {
		let { offset, limit } = query;

		if (query.cursor) {
			try {
				const decoded = decodeCursor(query.cursor);
				if (!('offset' in decoded)) {
					throw new BadRequestError('An invalid cursor was provided');
				}
				offset = decoded.offset;
				limit = decoded.limit;
			} catch (error) {
				if (error instanceof BadRequestError) throw error;
				throw new BadRequestError('An invalid cursor was provided');
			}
		}

		const { users, count } = await this.userService.listForPublicApi({
			skip: offset,
			take: limit,
		});

		return {
			data: users.map((user) => toPublicUser(user, query.includeRole)),
			nextCursor: encodeNextCursor({ offset, limit, numberOfTotalRecords: count }),
		};
	}

	@Get('/:id')
	@ApiKeyScope('user:read')
	@ApiSummary('Get user by ID/Email')
	@ApiDescription('Retrieve a user from your instance. Only available for the instance owner.')
	@ApiTags(['User'])
	@ApiResponse(200, UserPublicDto)
	@ApiErrorResponse(404)
	async getUser(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') id: string,
		@Query query: UsersListQueryDto,
	): Promise<UserPublicDto> {
		const user = await this.userService.findForPublicApi(id);

		if (!user) {
			throw new NotFoundError('Could not find user');
		}

		return toPublicUser(user, query.includeRole);
	}

	@Post('/')
	@ApiKeyScope('user:create')
	@ApiSummary('Create multiple users')
	@ApiDescription('Create one or more users.')
	@ApiTags(['User'])
	@ApiResponse(201)
	@ApiErrorResponse(400)
	async createUser(req: CreateUsersRequest, _res: Response): Promise<InviteResult> {
		// `inviteUsers` validates that every role exists (400 otherwise) and returns
		// the per-invitee result shape the public API contract requires.
		const invitations = req.body.map(({ email, role }) => ({
			email,
			role: role ?? 'global:member',
		}));

		const { usersInvited } = await this.userService.inviteUsers(req.user, invitations);

		return usersInvited;
	}

	@Delete('/:id')
	@ApiKeyScope('user:delete')
	@ApiSummary('Delete a user')
	@ApiDescription('Delete a user from your instance.')
	@ApiTags(['User'])
	@ApiResponse(204)
	@ApiErrorResponse(404)
	async deleteUser(req: UserRequest.Delete, _res: Response): Promise<void> {
		// Reuse the internal controller's deletion (owner guard, resource cleanup,
		// events) rather than duplicate it here.
		await Container.get(UsersController).deleteUser(req);
	}

	@Patch('/:id/role')
	@ApiKeyScope('user:changeRole')
	@Licensed(LICENSE_FEATURES.ADVANCED_PERMISSIONS)
	@ApiSummary("Change a user's global role")
	@ApiDescription("Change a user's global role.")
	@ApiTags(['User'])
	@ApiResponse(204)
	@ApiErrorResponse(400)
	@ApiErrorResponse(404)
	async changeRole(
		req: AuthenticatedRequest,
		res: Response,
		@Param('id') id: string,
		@Body payload: RoleChangeRequestDto,
	): Promise<void> {
		await Container.get(UsersController).changeGlobalRole(req, res, payload, id);
	}
}
