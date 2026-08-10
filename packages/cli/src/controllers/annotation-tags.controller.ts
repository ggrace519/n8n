import { CreateOrUpdateTagRequestDto, RetrieveTagQueryDto } from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	GlobalScope,
	Param,
	Patch,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import { Response } from 'express';

import { AnnotationTagService } from '@/services/annotation-tag.service';

@RestController('/annotation-tags')
export class AnnotationTagsController {
	constructor(private readonly annotationTagService: AnnotationTagService) {}

	@Get('/')
	@GlobalScope('annotationTag:list')
	async getAll(_req: AuthenticatedRequest, _res: Response, @Query query: RetrieveTagQueryDto) {
		return await this.annotationTagService.getAll({ withUsageCount: query.withUsageCount });
	}

	@Post('/')
	@GlobalScope('annotationTag:create')
	async createTag(
		_req: AuthenticatedRequest,
		_res: Response,
		@Body payload: CreateOrUpdateTagRequestDto,
	) {
		const tag = this.annotationTagService.toEntity({ name: payload.name });

		return await this.annotationTagService.save(tag);
	}

	@Patch('/:id')
	@GlobalScope('annotationTag:update')
	async updateTag(
		_req: AuthenticatedRequest,
		_res: Response,
		@Param('id') tagId: string,
		@Body payload: CreateOrUpdateTagRequestDto,
	) {
		const tag = this.annotationTagService.toEntity({ id: tagId, name: payload.name });

		return await this.annotationTagService.save(tag);
	}

	@Delete('/:id')
	@GlobalScope('annotationTag:delete')
	async deleteTag(_req: AuthenticatedRequest, _res: Response, @Param('id') tagId: string) {
		await this.annotationTagService.delete(tagId);

		return true;
	}
}
