import { PullWorkFolderRequestDto, PushWorkFolderRequestDto } from '@n8n/api-types';
import type { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Get,
	GlobalScope,
	Licensed,
	Param,
	Patch,
	Post,
	RestController,
} from '@n8n/decorators';
import { hasGlobalScope } from '@n8n/permissions';
import type { Response } from 'express';

import {
	getRepoType,
	isSourceControlLicensed,
	isValidGitBranchName,
} from './source-control-helper';
import { SourceControlPreferencesService } from './source-control-preferences.service';
import { SourceControlScopedService } from './source-control-scoped.service';
import type { SourceControlKeyGeneratorType } from './source-control.service';
import { SourceControlService } from './source-control.service';
import type { SourceControlPreferences } from './types/source-control-preferences';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { EventService } from '@/events/event.service';

type PreferencesRequestBody = Partial<
	Pick<
		SourceControlPreferences,
		| 'repositoryUrl'
		| 'branchName'
		| 'branchColor'
		| 'branchReadOnly'
		| 'keyGeneratorType'
		| 'initRepo'
	>
>;

@RestController('/source-control')
export class SourceControlController {
	constructor(
		private readonly sourceControlService: SourceControlService,
		private readonly sourceControlPreferencesService: SourceControlPreferencesService,
		private readonly sourceControlScopedService: SourceControlScopedService,
		private readonly eventService: EventService,
	) {}

	/**
	 * Readable by any authenticated user, redacted by source-control authority:
	 * managers get everything (including the public key), project-scoped
	 * pushers get safe branch metadata, everyone else only the read-only flag.
	 * Connection details (repository URL, credentials) never leave the manage
	 * tier.
	 */
	@Get('/preferences')
	async getPreferences(req: AuthenticatedRequest): Promise<Partial<SourceControlPreferences>> {
		const preferences = this.sourceControlPreferencesService.getPreferences();

		if (hasGlobalScope(req.user, 'sourceControl:manage')) {
			// Reads must stay side-effect-free on unlicensed instances: only a
			// licensed manager may trigger the lazy key-pair generation.
			if (isSourceControlLicensed()) {
				const publicKey = await this.sourceControlService.getPublicKey();
				return { ...preferences, publicKey };
			}
			const storedPublicKey = await this.sourceControlService.getStoredPublicKey();
			return { ...preferences, ...(storedPublicKey ? { publicKey: storedPublicKey } : {}) };
		}

		const projectIds = await this.sourceControlScopedService.getAuthorizedTeamProjectIds(req.user);
		if (projectIds === null || projectIds.length > 0) {
			return {
				connected: preferences.connected,
				branchName: preferences.branchName,
				branchColor: preferences.branchColor,
				branchReadOnly: preferences.branchReadOnly,
			};
		}

		return { branchReadOnly: preferences.branchReadOnly };
	}

	@Post('/preferences')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async setPreferences(req: AuthenticatedRequest): Promise<Partial<SourceControlPreferences>> {
		const body = this.parsePreferencesBody(req.body);

		await this.sourceControlPreferencesService.setPreferences({
			...(body.repositoryUrl !== undefined ? { repositoryUrl: body.repositoryUrl.trim() } : {}),
			...(body.branchName !== undefined ? { branchName: body.branchName } : {}),
			...(body.branchColor !== undefined ? { branchColor: body.branchColor } : {}),
			...(body.branchReadOnly !== undefined ? { branchReadOnly: body.branchReadOnly } : {}),
			...(body.keyGeneratorType !== undefined ? { keyGeneratorType: body.keyGeneratorType } : {}),
		});

		// Setup always needs key material; connecting only happens once a
		// repository URL is configured.
		const publicKey = await this.sourceControlService.getPublicKey();
		const repositoryUrl = this.sourceControlPreferencesService.getPreferences().repositoryUrl;
		if (repositoryUrl) {
			try {
				await this.sourceControlService.connect(req.user);
			} catch (error) {
				throw new BadRequestError(error instanceof Error ? error.message : String(error));
			}
		}

		this.emitSettingsUpdated();
		return { ...this.sourceControlPreferencesService.getPreferences(), publicKey };
	}

	@Patch('/preferences')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async updatePreferences(req: AuthenticatedRequest): Promise<Partial<SourceControlPreferences>> {
		const body = this.parsePreferencesBody(req.body);
		const current = this.sourceControlPreferencesService.getPreferences();

		if (body.branchName !== undefined && body.branchName !== current.branchName) {
			if (current.connected) {
				try {
					await this.sourceControlService.setBranch(body.branchName);
				} catch (error) {
					throw new BadRequestError(error instanceof Error ? error.message : String(error));
				}
			} else {
				await this.sourceControlPreferencesService.setPreferences({ branchName: body.branchName });
			}
		}

		await this.sourceControlPreferencesService.setPreferences({
			...(body.branchColor !== undefined ? { branchColor: body.branchColor } : {}),
			...(body.branchReadOnly !== undefined ? { branchReadOnly: body.branchReadOnly } : {}),
		});

		this.emitSettingsUpdated();
		const publicKey = await this.sourceControlService.getPublicKey();
		return { ...this.sourceControlPreferencesService.getPreferences(), publicKey };
	}

	@Post('/disconnect')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async disconnect(req: AuthenticatedRequest): Promise<Partial<SourceControlPreferences>> {
		const { keepKeyPair } = (req.body ?? {}) as { keepKeyPair?: boolean };
		const preferences = await this.sourceControlService.disconnect({ keepKeyPair });
		this.emitSettingsUpdated();
		return preferences;
	}

	@Get('/get-branches')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async getBranches(): Promise<{ branches: string[]; currentBranch: string }> {
		return await this.sourceControlService.getBranches();
	}

	// Mutating GET preserved for backwards compatibility with existing clients.
	@Get('/reset-workfolder')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async resetWorkfolder(): Promise<void> {
		await this.sourceControlService.resetWorkfolder();
	}

	@Post('/generate-key-pair')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async generateKeyPair(
		req: AuthenticatedRequest,
	): Promise<{ publicKey: string; keyGeneratorType: SourceControlKeyGeneratorType }> {
		const { keyGeneratorType } = (req.body ?? {}) as { keyGeneratorType?: unknown };
		let type: SourceControlKeyGeneratorType | undefined;
		if (keyGeneratorType !== undefined) {
			if (keyGeneratorType !== 'rsa' && keyGeneratorType !== 'ed25519') {
				throw new BadRequestError('keyGeneratorType must be "rsa" or "ed25519"');
			}
			type = keyGeneratorType;
		}
		return await this.sourceControlService.generateAndSaveKeyPair(type ?? 'rsa');
	}

	@Post('/push-workfolder')
	@Licensed('feat:sourceControl')
	async pushWorkfolder(
		req: AuthenticatedRequest,
		_res: Response,
		@Body payload: PushWorkFolderRequestDto,
	) {
		// Authorization (global or project-level push, per-candidate ownership)
		// is enforced by the service.
		const result = await this.sourceControlService.pushWorkfolder(req.user, payload);
		return { files: result.statusResult, commit: result.commit };
	}

	@Post('/pull-workfolder')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:pull')
	async pullWorkfolder(
		req: AuthenticatedRequest,
		res: Response,
		@Body payload: PullWorkFolderRequestDto,
	) {
		const result = await this.sourceControlService.pullWorkfolder(req.user, payload);
		res.status(result.statusCode === 200 ? 200 : 409);
		return result.statusResult;
	}

	@Get('/get-status')
	@Licensed('feat:sourceControl')
	async getStatus(
		req: AuthenticatedRequest<
			{},
			{},
			{},
			{ direction?: string; preferLocalVersion?: string; verbose?: string }
		>,
	) {
		// Direction-dependent authorization: pull status needs global pull, push
		// status accepts global or project-level push authority. The service
		// re-checks with its resolved context, but the route must reject callers
		// without any source-control authority up front.
		const direction = req.query.direction === 'pull' ? 'pull' : 'push';
		if (direction === 'pull') {
			if (!hasGlobalScope(req.user, 'sourceControl:pull')) {
				throw new ForbiddenError('You do not have permission to pull from source control');
			}
		} else if (!(await this.sourceControlService.hasPushAuthority(req.user))) {
			throw new ForbiddenError('You do not have permission to push to source control');
		}

		return await this.sourceControlService.getStatus(req.user, {
			direction,
			preferLocalVersion: req.query.preferLocalVersion === 'true',
			verbose: req.query.verbose === 'true',
		});
	}

	@Get('/status')
	@Licensed('feat:sourceControl')
	@GlobalScope('sourceControl:manage')
	async status(req: AuthenticatedRequest) {
		return await this.sourceControlService.getStatus(req.user, {
			direction: 'push',
			preferLocalVersion: true,
			verbose: false,
		});
	}

	@Get('/remote-content/:type/:id')
	@Licensed('feat:sourceControl')
	async getRemoteContent(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('type') type: string,
		@Param('id') id: string,
	) {
		const { content } = await this.sourceControlService.getRemoteFileEntity({
			user: req.user,
			type,
			id,
		});
		// Echo the validated type back: the diff view keys off it, and the
		// service only accepts a type it recognises.
		return { content, type };
	}

	private parsePreferencesBody(body: unknown): PreferencesRequestBody {
		const raw = (body ?? {}) as Record<string, unknown>;
		const parsed: PreferencesRequestBody = {};

		if (raw.repositoryUrl !== undefined) {
			if (typeof raw.repositoryUrl !== 'string') {
				throw new BadRequestError('repositoryUrl must be a string');
			}
			parsed.repositoryUrl = raw.repositoryUrl;
		}
		if (raw.branchName !== undefined) {
			if (typeof raw.branchName !== 'string' || !isValidGitBranchName(raw.branchName)) {
				throw new BadRequestError('branchName must be a valid git branch name');
			}
			parsed.branchName = raw.branchName;
		}
		if (raw.branchColor !== undefined) {
			if (typeof raw.branchColor !== 'string') {
				throw new BadRequestError('branchColor must be a string');
			}
			parsed.branchColor = raw.branchColor;
		}
		if (raw.branchReadOnly !== undefined) {
			if (typeof raw.branchReadOnly !== 'boolean') {
				throw new BadRequestError('branchReadOnly must be a boolean');
			}
			parsed.branchReadOnly = raw.branchReadOnly;
		}
		if (raw.keyGeneratorType !== undefined) {
			if (raw.keyGeneratorType !== 'rsa' && raw.keyGeneratorType !== 'ed25519') {
				throw new BadRequestError('keyGeneratorType must be "rsa" or "ed25519"');
			}
			parsed.keyGeneratorType = raw.keyGeneratorType;
		}
		if (raw.initRepo !== undefined) {
			if (typeof raw.initRepo !== 'boolean') {
				throw new BadRequestError('initRepo must be a boolean');
			}
			parsed.initRepo = raw.initRepo;
		}

		return parsed;
	}

	private emitSettingsUpdated(): void {
		const preferences = this.sourceControlPreferencesService.getPreferences();
		this.eventService.emit('source-control-settings-updated', {
			branchName: preferences.branchName,
			readOnlyInstance: preferences.branchReadOnly,
			repoType: getRepoType(preferences.repositoryUrl),
			connected: preferences.connected,
			connectionType: preferences.repositoryUrl.startsWith('http') ? 'https' : 'ssh',
		});
	}
}
