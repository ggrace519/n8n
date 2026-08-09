# Clean-room source-control backend contract inventory

Baseline: local commit `07d9cd0a47cfebcfa196c55c42341bb0f4bc9bb2`, clean worktree, `master` one commit ahead of refreshed `origin/master`. No enterprise source or history was inspected.

Evidence strength used below:

- **Hard pin**: surviving integration specs, DTO schemas, handler code, consumers.
- **Secondary pin**: surviving frontend mocks, i18n, skipped Playwright flows, changelog entries.
- **Open**: no surviving source fixes the behavior.

## 1. Module file map

These are every surviving backend `source-control.ee/*` reference and the exports required by consumers.

| Rebuild path | Required exports / registration |
|---|---|
| `source-control.ee/constants.ts` | `SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER`, `SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER`, `SOURCE_CONTROL_FOLDERS_EXPORT_FILE`, `SOURCE_CONTROL_TAGS_EXPORT_FILE`, `SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER` |
| `source-control.ee/source-control-context.factory.ts` | `SourceControlContextFactory`, including `createContext(user)` |
| `source-control.ee/source-control-export.service.ee.ts` | `SourceControlExportService` |
| `source-control.ee/source-control-git.service.ee.ts` | `SourceControlGitService` |
| `source-control.ee/source-control-helper.ee.ts` | `getTrackingInformationFromPullResult`, `isSourceControlLicensed` |
| `source-control.ee/source-control-import.service.ee.ts` | `SourceControlImportService` |
| `source-control.ee/source-control-scoped.service.ts` | `SourceControlScopedService` |
| `source-control.ee/source-control-status.service.ee.ts` | `SourceControlStatusService` |
| `source-control.ee/source-control.service.ee.ts` | `SourceControlService` |
| `source-control.ee/source-control.controller.ee.ts` | Side-effect REST controller registration; integration setup imports the emitted `.js` file |
| `source-control.ee/source-control.module.ts` | Side-effect module registration under name `source-control`, with `instanceTypes: ['main']` |
| `source-control.ee/types/exportable-credential.ts` | `ExportableCredential` |
| `source-control.ee/types/exportable-data-table.ts` | `ExportableDataTable` |
| `source-control.ee/types/exportable-folders.ts` | `ExportableFolder` |
| `source-control.ee/types/exportable-workflow.ts` | `ExportableWorkflow` |
| `source-control.ee/types/resource-owner.ts` | `RemoteResourceOwner` |

The module metadata behavior is directly pinned by [main-only-modules.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/__tests__/main-only-modules.test.ts:6).

The CLI ESLint allowlist still names context, export, import, scoped, and status services as historical TypeORM consumers. This is file-map evidence, not permission to reproduce ORM imports in new business logic; current repository rules require repository boundaries.

## 2. `SourceControlService` contract

### Observable public methods

```ts
getStatus(
  user: User,
  options: {
    direction: 'push' | 'pull';
    preferLocalVersion: boolean;
    verbose: boolean;
  },
): Promise<SourceControlledFile[]>;
```

Hard pins from [source-control.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/environments/source-control.service.test.ts:654):

- Query-string booleans are parsed before delegation; project-admin API coverage proves `true`/`false` strings become booleans.
- For `direction: 'push'`:

  - Local-only resource → `status: 'created'`.
  - Remote-only resource → `status: 'deleted'`.
  - Same ID but meaningful content/ownership/version difference → `status: 'modified'`.
  - Equal resources are omitted.
  - Credential `isGlobal: undefined` and `false` are equal.
  - `false ↔ true` and `undefined → true` are modifications.
  - Returned resource types include `workflow`, `credential`, `folders`, `tags`, `project`, and `datatable`.

- Global admin can see all personal and team-project workflow changes, all team credentials, folders, and data tables.
- Global member and `global:chatUser` receive `ForbiddenError`.
- A project admin:

  - Sees resources from projects where they have `project:admin`.
  - Does not see their personal-project workflows.
  - Does not see resources from projects where they only have an editor/member role.
  - Does not see an otherwise in-scope remote workflow whose local ownership has moved out of scope.
  - Sees an out-of-scope remote resource whose local ownership moved into scope as a local creation.
  - Sees remote-only in-scope data tables as deletions.
  - Never sees remote-only or local resources owned by an inaccessible project.

`direction: 'pull'` resource comparison is not exercised by the 1,608-line service spec.

```ts
pushWorkfolder(
  user: User,
  payload: PushWorkFolderRequestDto,
): Promise<{
  statusResult: SourceControlledFile[];
  // Other fields, including commit metadata, are not directly pinned here.
}>;
```

Hard pins from [source-control.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/environments/source-control.service.test.ts:1023):

- Runs a status calculation, exports selected changes, stages/deletes as appropriate, commits, then invokes `gitService.push()`.
- `fileNames: []` means “push all current changes,” not “push nothing.”
- A read-only branch rejects before authorization with `BadRequestError`; no message is pinned.
- Global admin may push everything.
- Project admin may push only in-scope resources.
- Supplying one out-of-scope workflow or credential causes `ForbiddenError`.
- Global members are denied both full and single-resource pushes.
- A project-scoped push must merge aggregate files:

  - `tags.json`: preserve out-of-scope mappings, replace/add in-scope mappings, include all tag definitions.
  - `folders.json`: preserve out-of-scope folders, replace/add all in-scope folders.

- Project files are synthesized alongside selected resources:

  - Global push covering two team projects writes two non-deleted `project` files.
  - Project-admin push writes one.

- Deleted status entries do not produce JSON writes.
- Global fixture push writes eight workflow files, two credential files, two project files, four data-table files, `folders.json`, and `tags.json`.
- Project-admin fixture push writes two workflows, one credential, one project, two data tables, `folders.json`, and `tags.json`.

The UI-level push response is structurally pinned as:

```ts
{
  files: SourceControlledFile[];
  commit: GitCommitInfo | null;
}
```

The surviving evidence does not show whether the service returns that shape directly or the controller maps `statusResult` to `files`.

```ts
pullWorkfolder(
  user: User,
  payload: PullWorkFolderRequestDto,
): Promise<{
  statusCode: number; // observed 200 or 409
  statusResult: SourceControlledFile[];
}>;
```

Hard pins:

- `200` means import completed.
- `409` means conflicts were returned without applying an ordinary pull.
- `force` defaults false and is the override mechanism.
- Public API maps all non-200 service results to HTTP 409.
- Exceptions propagate to the public handler, which returns the exception message as plain text with HTTP 400.

```ts
getBranches(): Promise<{
  branches: string[];
  currentBranch: string;
}>;
```

Pinned by access-control stubbing and frontend mocks. Example: `branches: ['main', 'release']`, `currentBranch: 'main'`.

```ts
sanityCheck(): Promise<void>;
```

Required before git/content operations. Tests stub it whenever they need authorization to run without touching git. Its exact checks and errors are open.

`getRemoteFileEntity` is named in the access-control spec’s explanatory comment. The `/remote-content/:type/:id` route must use its context-aware authorization, but the exact signature and return type are not present.

### Status scope subtleties

- Global admins and owners are treated as instance-wide.
- A project admin’s scope is based on project-level `sourceControl:push`, not merely access to the project.
- Pull status requires global `sourceControl:pull`; project-level push permission is insufficient.
- Tags are global definitions, while tag mappings are workflow-scoped.
- Aggregate folder/tag changes must never erase data outside the caller’s scope.

### Conflicts

Hard contract:

- `SourceControlledFile.conflict` is required.
- HTTP 409 returns the whole status array.
- OpenAPI says conflicts can be uncommitted local changes or merge conflicts.
- Conflict-causing entries have `conflict: true` or are reported as modified.
- Retrying with `force: true` discards local changes.

Not pinned:

- The exact conflict algorithm.
- Whether `status: 'conflicted'` is emitted in addition to `conflict: true`.
- Push-side behavior when `force` is false.
- The exact relationship among `preferLocalVersion`, `force`, and git merge/reset operations.

## 3. Export service contract

The worktree root is:

```text
${InstanceSettings.n8nFolder}/git/
```

### Directory layout

```text
git/
├── workflows/
│   └── <workflow-id>.json
├── credential_stubs/
│   └── <credential-id>.json
├── datatables/
│   └── <data-table-id>.json
├── folders.json
└── tags.json
```

Constant values pinned by fixtures:

```ts
SOURCE_CONTROL_WORKFLOW_EXPORT_FOLDER = 'workflows';
SOURCE_CONTROL_CREDENTIAL_EXPORT_FOLDER = 'credential_stubs';
SOURCE_CONTROL_DATATABLES_EXPORT_FOLDER = 'datatables';
SOURCE_CONTROL_FOLDERS_EXPORT_FILE = 'folders.json';
SOURCE_CONTROL_TAGS_EXPORT_FILE = 'tags.json';
```

Project and variable export locations are not pinned by these specs. The surviving changelog names `variable_stubs.json` and says projects are exported as JSON files, but not their current exact layout.

### `exportCredentialsToWorkFolder`

```ts
exportCredentialsToWorkFolder(
  candidates: SourceControlledFile[],
): Promise<{
  count: number;
  files: string[];
  missingIds: string[];
}>;
```

Hard pins from [source-control-export.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/environments/source-control-export.service.test.ts:109):

- Writes one file per found credential at `git/credential_stubs/<id>.json`.
- Missing candidates are skipped and returned in input order through `missingIds`.
- Partial success is permitted.
- `count` is the number exported; `files.length === count`.
- JSON is pretty-printed; observed formatting is compatible with `JSON.stringify(value, null, 2)`.
- The exported shape is:

```ts
interface ExportableCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
  ownedBy:
    | null
    | string // legacy email form accepted by import
    | {
        type: 'personal';
        projectId?: string;
        projectName?: string;
        personalEmail: string;
      }
    | {
        type: 'team';
        teamId: string;
        teamName: string;
      };
  isGlobal: boolean;
  isResolvable?: boolean;
  resolvableAllowFallback?: boolean;
}
```

- Personal exports include `type`, `projectId`, `projectName`, and `personalEmail`.
- Team exports include `type`, `teamId`, and `teamName`.
- `isGlobal` is always explicit.
- Decrypted strings are replaced with `''`.
- Nested object structure is preserved recursively.
- Numbers and booleans are preserved.
- `oauthTokenData` is omitted entirely, not emitted as an empty object.

The i18n contract adds an important import-side rule for modified credentials: expressions, numbers, and booleans may be updated, while other values are unavailable from git and must not overwrite existing secrets. The changelog separately requires preserving OAuth token data during pull.

Arrays, nulls, dates, and unsupported object types are not directly specified.

### Workflow file

The status reader fixture pins this serialized shape:

```ts
interface ExportableWorkflow {
  id: string;
  name: string;
  connections: IConnections;
  isArchived: boolean;
  nodes: INode[];
  owner?: RemoteResourceOwner;
  triggerCount: number;
  parentFolderId: string | null;
  versionId: string;
  nodeGroups: unknown[];
}
```

Import accepts the broader surviving `IWorkflowToImport` contract: `IWorkflowBase` minus static/pin/timestamp/activeVersion fields, plus optional version metadata, optional owner, and required `parentFolderId`.

No direct export assertion covers workflow settings, active state, active version, version metadata, or property ordering.

### Data-table file

The reader fixture pins:

```ts
interface ExportableDataTable {
  id: string;
  name: string;
  columns: Array<{
    id: string;
    name: string;
    type: string;
    index: number;
  }>;
  ownedBy:
    | {
        type: 'personal';
        projectId: string;
        projectName: string;
        personalEmail: string;
      }
    | {
        type: 'team';
        teamId: string;
        teamName: string;
      };
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

Columns are sorted ascending by `index`. No row data is present in the pinned shape.

### Folder file

```ts
interface ExportableFolder {
  id: string;
  name: string;
  homeProjectId: string;
  parentFolderId: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

interface FolderExportFile {
  folders: ExportableFolder[];
}
```

A project-scoped rewrite preserves inaccessible remote folders and replaces/adds the caller’s complete in-scope folder set.

### Tags file

```ts
interface TagsExportFile {
  tags: Array<{ id: string; name: string }>;
  mappings: Array<{ tagId: string; workflowId: string }>;
}
```

`exportTagsToWorkFolder(context)`:

- Always writes `tags.json`, including when there are zero tags.
- Empty content is exactly:

```json
{
  "tags": [],
  "mappings": []
}
```

- `count` equals the number of tag definitions, not mappings.
- `files` contains one path.
- Unassigned tags remain in `tags`.
- Every workflow/tag mapping is represented.
- For scoped users, all tag definitions remain present but only accessible mappings are refreshed.

## 4. Import service contract

Directly observed methods:

```ts
getRemoteVersionIdsFromFiles(context): Promise<Array<...>>;
getLocalVersionIdsFromDb(context): Promise<Array<...>>;

getRemoteCredentialsFromFiles(context): Promise<Array<...>>;
getLocalCredentialsFromDb(context): Promise<Array<...>>;

getLocalFoldersAndMappingsFromDb(context): Promise<{
  folders: ExportableFolder[];
  // Additional mapping fields are not asserted.
}>;

getRemoteTagsAndMappingsFromFile(context): Promise<TagsExportFile>;
getLocalTagsAndMappingsFromDb(context): Promise<TagsExportFile>;

importTagsFromWorkFolder(candidate: SourceControlledFile, user: User): Promise<unknown>;
importCredentialsFromWorkFolder(
  candidates: SourceControlledFile[],
  importingUserId: string,
): Promise<unknown>;
importWorkflowFromWorkFolder(
  candidates: SourceControlledFile[],
  importingUserId: string,
): Promise<unknown[]>;
```

### Scope matrix

| Caller | Remote/local workflows | Credentials/folders | Tags | Tag mappings |
|---|---|---|---|---|
| Global admin | All remote; service spec proves all local visibility | All | All | All |
| Global owner | All remote and local | All | All | All |
| Global member | None | None | All | None |
| Team project admin | Only resources serialized as owned by a team project where caller is `project:admin` | Same | All | Only mappings for workflows in those projects |
| Project editor/member | None | None | All | None |

Important pins:

- A project admin does not receive their personal-project resources.
- A serialized personal owner matching the project admin’s email does not make that resource project-admin-visible.
- Editor access to another team project does not add it to source-control scope.
- Remote mapping filtering is based on locally known workflow/project ownership.

### Remote workflow discovery

Each workflow JSON must at least support:

```ts
{
  id: string;
  versionId?: string;
  name: string;
  owner?:
    | { type: 'personal'; personalEmail: string }
    | { type: 'team'; teamId: string; teamName: string };
}
```

Instance admins/owners receive all parsed remote workflows. Members receive none. Project admins receive only team-owned workflows belonging to their administered projects.

Malformed JSON behavior and files with missing IDs are not tested.

### Local workflow discovery

- Global owner receives workflows in all personal and team projects.
- Project admin receives only workflows in administered team projects.
- Project member receives none.
- Returned object details beyond IDs are not exhaustively asserted.

### Credential discovery

Remote filtering mirrors workflows.

Local credential records must expose at least:

```ts
{
  id: string;
  name: string;
  type: string;
  data: unknown;
  filename: string;
  isGlobal: boolean;
  isResolvable: boolean;
  resolvableAllowFallback: boolean;
}
```

Defaults:

- Missing/null `isGlobal` → `false`.
- Static credentials default both resolvable flags to `false`.

### Credential import and ownership

Hard pins from [source-control-import.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/environments/source-control-import.service.test.ts:1359):

Legacy ownership:

- `ownedBy: "<existing email>"` → existing user’s personal project.
- `ownedBy: null` → importing user’s personal project.
- Unknown legacy email → importing user’s personal project.

Structured ownership:

- Missing personal email target → importing user’s personal project.
- Missing team project → create a team project with the exact source `teamId` and `teamName`.
- Existing team project with matching ID → reuse it.
- Existing credential owned by a different project → replace its sharing/owner row so only the source owner remains.

Credential data:

- Imported data is encrypted with `Cipher.encryptV2`.
- Existing credential `name`, `type`, and encrypted `data` are updated.
- `isGlobal: true` and `false` are persisted exactly.
- Owner sharing uses role `credential:owner`.

Under-pinned credential cases:

- Team-name collision with a different ID.
- Team ID collision with a different name.
- Multiple pre-existing sharing rows.
- `isResolvable` import.
- Deep merge rules for blank strings/expressions are only pinned by UI copy, not this spec.
- Failure transactionality across credential and owner writes.

### Tag import

Hard pins:

- Tags removed from a workflow in git have their local mappings deleted.
- Tag entities themselves are not deleted merely because a mapping disappears.
- Only workflows represented by the imported remote workflow set are reconciled.
- Mappings belonging to other workflows remain untouched.
- A represented workflow with no mappings in `tags.json` loses all its local tags.
- When the tag file has no mappings, workflow files are scanned to determine which workflows are represented and therefore eligible for mapping removal.

Not pinned:

- Tag creation, rename, or deletion conflict behavior.
- Duplicate IDs/names.
- Missing `tags.json`.
- Transaction boundaries.

### Workflow import and history

Hard pins from [source-control-import.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/environments/source-control-import.service.test.ts:1746):

Required input:

- `versionId`
- `nodes`
- `connections`

If any is missing:

- The workflow is skipped.
- No workflow row is created.
- Return value is `[]`.
- No error is required.

History:

- New workflow import creates a `WorkflowHistory` row for `(workflowId, versionId)`.
- History nodes and connections equal imported content.
- Author is verbatim:

```text
import by <firstName> <lastName>
```

- If the same `(workflowId, versionId)` exists but nodes changed, history content and author are updated.
- If version ID and content are unchanged, history author and `updatedAt` remain untouched.

Archived state:

- If an existing workflow is archived but inconsistently active, import clears `active` and `activeVersionId`, even when the incoming workflow is unarchived.

Not directly pinned:

- Workflow owner assignment/change.
- Folder assignment/import.
- Settings, pin data, static data, node groups, version metadata.
- Connections-only changes to history.
- Workflow deletion.
- Auto-publish behavior.
- Activation/deactivation hooks and rollback.

### Folders, variables, projects, and data tables

These are not directly covered by import methods in the 2,019-line spec.

Secondary surviving constraints:

- The skipped Playwright pull flow expects recreation of projects, folders, workflows, credentials, project variables, and tags.
- Variable value is not asserted after pull; UI text requires new variables to be filled in.
- Changelog says project-variable sync is supported.
- UI warns that data-table column removal during pull causes unrecoverable data loss.
- Changelog says source-control pull reconciles data-table name collisions and column renames.

Exact import algorithms and formats remain open.

## 5. REST routes

All internal endpoints live under `/rest/source-control` in production; integration agents omit the `/rest` prefix.

The module is licensed by `feat:sourceControl`. Playwright explicitly notes that the source-control routes are registered at startup only when that license is available. Exact internal unlicensed response bodies are not tested.

### Internal controller

| Method and path | Access contract | Request / response pins |
|---|---|---|
| `GET /source-control/preferences` | Any authenticated user; response redacted by source-control scope | See redaction rules below |
| `POST /source-control/preferences` | Global `sourceControl:manage`; member gets 403 | Connect/setup request; SSH helper sends `connectionType: 'ssh'`, `repositoryUrl` |
| `PATCH /source-control/preferences` | Global `sourceControl:manage`; member gets 403 | Branch/read-only/color settings update |
| `POST /source-control/disconnect` | Global manage; member gets 403 | `{ keepKeyPair?: boolean }`; helper defaults true |
| `GET /source-control/get-branches` | Global manage; ordinary member and project admin get 403 | `{ branches: string[], currentBranch: string }` |
| `GET /source-control/reset-workfolder` | Global manage; member gets 403 | Mutating GET is preserved by surviving API test |
| `POST /source-control/generate-key-pair` | Global manage; member gets 403 | `{ keyGeneratorType?: 'rsa' \| 'ed25519' }`; empty body defaults to RSA |
| `POST /source-control/pull-workfolder` | Global `sourceControl:pull`; member/project admin get 403 | `PullWorkFolderRequestDto`; success body data is `SourceControlledFile[]` |
| `POST /source-control/push-workfolder` | Global or project-level `sourceControl:push`; service enforces candidate scope | `PushWorkFolderRequestDto`; UI expects `{ files, commit }` |
| `GET /source-control/get-status` | Pull direction requires global pull; push direction allows global/project push | Query: `direction`, `preferLocalVersion`, `verbose`; response `SourceControlledFile[]` |
| `GET /source-control/status` | Member forbidden; manager allowed | Exact response shape not pinned |
| `GET /source-control/remote-content/:type/:id` | Context-aware resource authorization | Foreign workflow returns 403; frontend expects a `{ content: workflow }` result |
 
Preference redaction:

- Global owner/admin gets full preferences, including `repositoryUrl` and `publicKey`.
- Manager receives the full repository URL even if it embeds a private token.
- Project admin with project-level source-control push gets only:

```ts
{
  connected: true;
  branchName: string;
  branchColor: string;
  branchReadOnly: boolean;
}
```

- Member without source-control access gets exactly:

```ts
{ branchReadOnly: boolean }
```

- Unprivileged responses must omit `repositoryUrl`, `publicKey`, `httpsUsername`, and `httpsPassword`.
- Serialized response must not contain embedded repository credentials.

Generate-key response:

```ts
{
  data: {
    publicKey: string;
    keyGeneratorType: 'rsa' | 'ed25519';
  }
}
```

Empty request hard-pins RSA and a public key containing `ssh-rsa`.

### Public API

Route: `POST /api/v1/source-control/pull` externally; integration path is `/source-control/pull`.

Scope middleware:

```ts
apiKeyHasScopeWithGlobalScopeFallback({
  scope: 'sourceControl:pull',
})
```

Observed responses:

- Missing API key → 401:

```json
{ "message": "'X-N8N-API-KEY' header required" }
```

- Invalid API key → 401 with a `message` property; exact text not pinned.
- API key lacking `sourceControl:pull` → 403:

```json
{ "message": "Forbidden" }
```

- Unlicensed → 401:

```json
{
  "status": "Error",
  "message": "Source Control feature is not licensed"
}
```

- Licensed but disconnected → 400:

```json
{
  "status": "Error",
  "message": "Source Control is not connected to a repository"
}
```

- Success → 200, raw `SourceControlledFile[]`, without `{ data: ... }`.
- Conflict → 409, raw `SourceControlledFile[]`.
- `pullWorkfolder` exception → 400 plain text containing `error.message`.
- DTO parse failure → 400 non-empty plain text.

On success it emits `source-control-user-pulled-api` with tracking information plus `forced: payload.force ?? false`.

## 6. Helper functions and support services

### `isSourceControlLicensed`

```ts
isSourceControlLicensed(): boolean
```

Must gate public pulls against `feat:sourceControl`. The surviving preferred license API is `LicenseState.isSourceControlLicensed()`.

### `getTrackingInformationFromPullResult`

```ts
getTrackingInformationFromPullResult(
  userId: string,
  result: SourceControlledFile[],
): object
```

Minimum required output is compatible with:

```ts
{
  workflowUpdates: number;
  // possibly userId; exact full shape is not pinned
}
```

The public handler spreads this into `source-control-user-pulled-api` and adds `forced`. The telemetry relay only consumes `workflowUpdates` and `forced`.

### `SourceControlContextFactory`

```ts
createContext(user: User): Promise<SourceControlContext>
```

The opaque context must encode:

- Global owner/admin instance-wide authority.
- Team projects where the caller has source-control-admin/push authority.
- Exclusion of personal projects for a merely project-scoped admin.
- Exclusion of projects where the role is only editor/member.

The exact context structure is open.

### `SourceControlScopedService`

Required as a constructor dependency of service/import/status paths. Its behavior is pinned indirectly by all scoping results above. No surviving source names its methods.

### `SourceControlStatusService`

```ts
getStatus(user: User, options: StatusOptions): Promise<SourceControlledFile[]>;
```

Project-admin API coverage spies on this method and verifies the parsed options and user.

The core service spec also replaces a `resetWorkfolder` member with an async method returning `undefined`, establishing an operation of that name on the status service, although its public/private visibility is not pinned.

## 7. Preferences and connect flow beyond the rebuilt service

Treat the existing preferences service and type as already implemented. Additional surrounding behavior is:

### SSH keys

- Supported generator types: `rsa`, `ed25519`.
- RSA output contains `ssh-rsa`.
- Ed25519 output begins `ssh-ed25519`.
- Full preference responses expose `publicKey`.
- Public key is derived/runtime data and must not be persisted in the `features.sourceControl` preferences row.
- Key pair storage uses settings key:

```text
features.sourceControl.sshKeys
```

- Stored shape:

```ts
{
  encryptedPrivateKey: string;
  publicKey: string;
}
```

- Private key is encrypted with the instance key.
- The migration’s legacy filesystem paths were:

```text
${n8nFolder}/ssh/key
${n8nFolder}/ssh/key.pub
```

### Setup/connect sequence

Secondary but concrete flow:

1. POST preferences with:

```ts
{
  connectionType: 'ssh';
  keyGeneratorType: 'ed25519';
  repositoryUrl: '';
  initRepo: false;
}
```

This initializes preferences/key material but must not mark the instance connected.

2. Add returned public key to the remote Git provider.

3. POST preferences with `connectionType: 'ssh'` and `repositoryUrl`.

4. Successful connect sets `connected: true`, discovers branches, and initially selects `main`.

5. PATCH preferences with a new `branchName` switches branches.

6. POST disconnect with `{ keepKeyPair: true }` sets `connected: false` and permits reconnection with the existing key.

7. Key regeneration invalidates the old key.

Repository URLs explicitly exercised:

```text
git@github.com:org/repo.git
ssh://git@gitea/user/repo.git
https://.../repo.git
```

Frontend flow also requires HTTPS username/PAT fields, connection-type selection, commit author name/email, `initRepo`, branch color, branch read-only state, and branch listing. Their persistence and validation DTOs are absent.

### Git and SSH dependencies

- `packages/cli` retains direct dependency `simple-git@3.36.0`.
- It retains `sshpk@1.18.0` and `@types/sshpk`.
- Specs mock `SourceControlGitService`, not `simple-git` directly.
- The only direct mock expectation is that successful push orchestration calls `gitService.push()`.

Therefore `simple-git` and `sshpk` are strong dependency evidence, but exact wrapper methods and options are not pinned by the specs.

### Operational secondary constraints

Surviving changelog entries require:

- Serialized work-folder operations.
- Startup fetch failures handled gracefully.
- SSH host-key verification.
- HTTP proxy support for git commands.
- Branch-name format validation while allowing `/`.
- Remote-content access restricted to the source-control work directory.
- Bounded peak memory during status computation.
- Multi-main preference reload propagation.

No surviving implementation fixes the exact mechanisms.

## 8. Events, telemetry, and pubsub

From [relay.event-map.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/events/maps/relay.event-map.ts:669):

```ts
'source-control-settings-updated': {
  branchName: string;
  readOnlyInstance: boolean;
  repoType: 'github' | 'gitlab' | 'other';
  connected: boolean;
  connectionType: 'ssh' | 'https';
};

'source-control-user-started-pull-ui': {
  userId?: string;
  workflowUpdates: number;
  workflowConflicts: number;
  credConflicts: number;
};

'source-control-user-finished-pull-ui': {
  userId?: string;
  workflowUpdates: number;
};

'source-control-user-pulled-api': {
  workflowUpdates: number;
  forced: boolean;
};

'source-control-user-started-push-ui': {
  userId?: string;
  workflowsEligible: number;
  workflowsEligibleWithConflicts: number;
  credsEligible: number;
  credsEligibleWithConflicts: number;
  variablesEligible: number;
};

'source-control-user-finished-push-ui': {
  userId: string;
  workflowsEligible: number;
  workflowsPushed: number;
  credsPushed: number;
  variablesPushed: number;
};
```

Telemetry names and property mapping:

| Relay event | Telemetry event |
|---|---|
| `source-control-settings-updated` | `User updated source control settings` |
| `source-control-user-started-pull-ui` | `User started pull via UI` |
| `source-control-user-finished-pull-ui` | `User finished pull via UI` |
| `source-control-user-pulled-api` | `User pulled via API` |
| `source-control-user-started-push-ui` | `User started push via UI` |
| `source-control-user-finished-push-ui` | `User finished push via UI` |

Telemetry transforms camelCase to snake_case, for example `branchName → branch_name`, `readOnlyInstance → read_only_instance`, and `workflowUpdates → workflow_updates`.

Pulse telemetry adds:

```ts
{
  source_control_set_up: preferencesService.isSourceControlSetup();
  branchName: preferences.branchName;
  read_only_instance: preferences.branchReadOnly;
}
```

Pubsub defines a no-payload command:

```ts
{
  command: 'reload-source-control-config';
  payload?: never;
  senderId?: string;
  targets?: string[];
  selfSend?: boolean;
  debounce?: boolean;
}
```

It is exported as `PubSub.Commands.ReloadSourceControlConfiguration` and included in the command union. No surviving producer or handler exists, so the reload side effect remains open.

Frontend settings expose license state through:

```ts
settings.enterprise.sourceControl =
  license.isSourceControlLicensed();
```

## 9. DTOs, frontend pins, consumers, persistence, and fixtures

### API types

From [source-controlled-file.schema.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/schemas/source-controlled-file.schema.ts:5):

```ts
type SourceControlFileType =
  | 'credential'
  | 'workflow'
  | 'tags'
  | 'variables'
  | 'file'
  | 'folders'
  | 'project'
  | 'datatable';

type SourceControlledFileStatus =
  | 'new'
  | 'modified'
  | 'deleted'
  | 'created'
  | 'renamed'
  | 'conflicted'
  | 'ignored'
  | 'staged'
  | 'unknown';

type SourceControlFileLocation = 'local' | 'remote';

interface SourceControlledFile {
  file: string;
  id: string;
  name: string;
  type: SourceControlFileType;
  status: SourceControlledFileStatus;
  location: SourceControlFileLocation;
  conflict: boolean;
  updatedAt: string;

  pushed?: boolean;
  isLocalPublished?: boolean;
  isRemoteArchived?: boolean;
  parentFolderId?: string | null;
  folderPath?: string[];
  owner?: {
    type: 'personal' | 'team';
    projectId: string;
    projectName: string;
  };
  publishingError?: string;
  publishingErrorDetails?: {
    reason: 'review_pending' | 'changes_requested';
    workflowReviewRequestId: string; // non-empty
  };
}
```

Push DTO:

```ts
class PushWorkFolderRequestDto {
  force?: boolean;
  commitMessage?: string;
  fileNames: SourceControlledFile[]; // required
}
```

Pull DTO:

```ts
class PullWorkFolderRequestDto {
  force?: boolean;
  autoPublish: 'none' | 'all' | 'published'; // defaults 'none'
}
```

Auto-publish meanings from OpenAPI:

- `none`: retain local published state; do not attempt publication.
- `all`: publish all imported workflows.
- `published`: publish only workflows that were published locally before import.

Commit metadata:

```ts
interface GitCommitInfo {
  hash: string;
  message: string;
  branch: string;
}
```

### Frontend/rest-client pins

There is no surviving source-control implementation in `packages/frontend/@n8n/rest-api-client`; the actual client/store lived in the purged frontend `sourceControl.ee` feature.

Surviving Mirage routes pin:

- `GET /rest/source-control/preferences`
- `POST /rest/source-control/preferences`
- `PATCH /rest/source-control/preferences`
- `GET /rest/source-control/get-branches`
- `POST /rest/source-control/disconnect`

The frontend preferences contract additionally expects:

```ts
{
  branchName: string;
  branches: string[];
  repositoryUrl: string;
  branchReadOnly: boolean;
  branchColor: string;
  connected: boolean;
  publicKey: string;
  keyGeneratorType: 'ed25519' | 'rsa';
}
```

Surviving frontend consumers require a store with at least:

- `preferences`
- `isEnterpriseSourceControlEnabled`
- `getPreferences()`
- `pullWorkfolder(force, autoPublish)`
- `getRemoteWorkflow(workflowId) → { content: IWorkflowDb }`
- an action named `pullWorkfolder`, after which workflow, credential, variable, project-navigation, and data-table views refresh.

Sidebar behavior:

- Visible only when licensed and user has global pull or global/project push.
- Pull requires global `sourceControl:pull`.
- Push allows global or project `sourceControl:push`.
- Push is disabled on `branchReadOnly`.
- Query `?sourceControl=pull|push` opens the respective modal.

Settings route `/settings/environments` requires `sourceControl:manage`.

### Read-only consumers

Hard backend guard message for data tables:

```text
Cannot modify data tables on a protected instance. This instance is in read-only mode.
```

This is enforced by:

- `branchWriteAccessMiddleware`
- `DataTableController`
- `DataTableProxyService`

Controller operations blocked include data-table create/update/delete, column add/delete/move/rename, CSV import, row insert/upsert/update/delete.

Agent eval generation blocks with:

```text
Cannot generate eval cases on a protected instance. This instance is in read-only mode.
```

Instance AI:

- Applies `applyBranchReadOnlyOverrides` to permissions.
- Sets `context.branchReadOnly = true`.
- Adapter writes throw:

```text
Cannot modify <resourceType> on a protected instance. This instance is in read-only mode.
```

Adapter guards cover workflows, executions, evaluations, data tables, and other resource adapters.

Safe Instance AI permissions retained are filesystem read, URL fetch, web search, workflow publication, credential deletion, and workflow-version restoration. Other writes are changed to `blocked`.

### Database/config dependencies

No dedicated source-control entity survives in `@n8n/db`.

Required existing persistence types/repositories evidenced by specs:

- `SettingsRepository`
- `User`, `UserRepository`
- `Project`, `ProjectRepository`, project relations
- `WorkflowEntity`, `WorkflowRepository`
- `SharedWorkflowRepository`
- `WorkflowHistoryRepository`
- `WorkflowTagMappingRepository`
- `CredentialsEntity`, `CredentialsRepository`
- `SharedCredentialsRepository`
- `Folder`, `FolderRepository`
- `TagEntity`, `TagRepository`

Data tables use the CLI module’s `DataTable` entity/service rather than a surviving `@n8n/db` source-control entity.

Settings rows:

- `features.sourceControl`
- `features.sourceControl.sshKeys`

`@n8n/config` has no surviving source-control config section. It only includes `source-control` as an allowed logging scope.

### Test helpers and fixtures

`@n8n/backend-test-utils` helpers used:

- `createTeamProject`
- `createWorkflow`
- `createWorkflowWithHistory`
- `getPersonalProject`
- `linkUserToProject`
- `randomCredentialPayload`
- `setActiveVersion`
- `testDb`
- `testModules`
- `mockInstance`

Integration shared helpers used:

- credentials: `createCredentials`, `saveCredential`
- data tables: `createDataTable`
- folders: `createFolder`
- tags: `createTag`, `updateTag`, `assignTagToWorkflow`
- users: `createUser`, `createAdmin`, `createMember`, `createOwner`, `getGlobalOwner`, API-key user creators

There are no standalone source-control fixture JSON files. All fixtures are constructed inside the five environment specs and the additional public API spec.

## 10. Open questions and under-pinned areas

These should be resolved with new clean-room specifications before implementation, not guessed:

1. **Variables**

   - Exact `variable_stubs.json` shape.
   - Whether values are always omitted or selectively sanitized.
   - Global versus project variable ownership encoding.
   - Conflict, deletion, and duplicate-key behavior.
   - Project-level scope requirements.

2. **Project files**

   - Directory and filename.
   - JSON shape.
   - Whether projects are exported only when referenced.
   - ID/name collision policy during pull.

3. **Folder import**

   - Creation, rename, move, parent-before-child ordering.
   - Missing parent behavior.
   - Project ownership changes.
   - Folder deletion and non-empty-folder semantics.

4. **Workflow ownership**

   - Personal/team owner assignment on creation.
   - Missing user/team fallback.
   - Ownership changes on an existing workflow.
   - Undefined owner compatibility noted by the changelog.

5. **Workflow deletion and publishing**

   - Physical delete versus archive.
   - `isArchived`, `active`, and `activeVersionId` transition matrix.
   - Auto-publish hooks, partial failures, `publishingError`, and blocker details.
   - Whether publication failure rolls back import.

6. **Credentials**

   - Exact blank-string/expression merge algorithm.
   - OAuth-token preservation mechanics.
   - Resolvable credential fields on import/export.
   - Team ID/name collision behavior.
   - Transactionality and recovery on owner-write failure.

7. **Data tables**

   - Import method signatures.
   - Whether only schema or also rows sync.
   - Name-collision reconciliation algorithm.
   - Column rename detection.
   - Column removal confirmation/force behavior.
   - Ownership changes and project creation.

8. **Git wrapper**

   - Full `SourceControlGitService` method surface.
   - Clone/init/fetch/pull/reset/checkout/add/commit/push signatures.
   - Remote tracking setup.
   - Proxy and SSH environment construction.
   - Host-key verification and known-host storage.
   - Retry/error classification.
   - Commit-author defaults.

9. **Controller DTOs and responses**

   - Exact POST/PATCH preference schemas.
   - HTTPS credential persistence/redaction.
   - `/status` response.
   - `/reset-workfolder` response.
   - `/remote-content/:type/:id` supported types and not-found behavior.
   - Internal 409 and error bodies.
   - Exact mapping from service `statusResult` to push `{ files, commit }`.

10. **Helper/context classes**

    - Full `SourceControlContext` type.
    - `SourceControlScopedService` method names.
    - Full tracking-helper output.
    - Exact license/module initialization sequence.

11. **Concurrency and multi-main**

    - Lock granularity for serialized work-folder operations.
    - Pubsub reload producer/handler.
    - Behavior when another main changes branch or keys mid-operation.

12. **Filesystem safety**

    - Exact glob patterns.
    - Invalid JSON policy.
    - Symlink/path-traversal defenses.
    - Atomic writes and cleanup of stale files.
    - Ordering/determinism.
    - Invalid `updatedAt` handling.
    - Workfolder reset behavior.

13. **Conflicts**

    - Comparison fields per resource.
    - `preferLocalVersion` semantics.
    - `conflict` versus `status: 'conflicted'`.
    - Force behavior for uncommitted git changes versus resource-level conflicts.

No tests were run because the five core specs deliberately import the absent module. Verification was a read-only coverage audit: all 4,745 requested spec lines, the additional 163-line public API spec, handler/OpenAPI, every referenced module path, the mandated non-test grep result, consumers, DTOs, DB/config evidence, frontend pins, and helper inventories were checked; the worktree remained unchanged.