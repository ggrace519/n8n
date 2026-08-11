/**
 * The import line every workflow SDK snippet starts with.
 *
 * Interpolated verbatim into a ```javascript fence in the SDK reference the
 * builder and MCP clients read, so it must be a complete, valid statement
 * naming only real `@n8n/workflow-sdk` exports. A unit test asserts each
 * identifier below is actually exported by the SDK, so the reference can't
 * drift into advertising a builder that no longer exists.
 */
export const SDK_IMPORT_STATEMENT =
	"import { workflow, node, trigger, sticky, placeholder, newCredential, ifElse, switchCase, merge, splitInBatches, nextBatch, languageModel, memory, tool, outputParser, embedding, embeddings, vectorStore, retriever, documentLoader, textSplitter, reranker, fromAi, expr } from '@n8n/workflow-sdk';";
