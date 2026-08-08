/**
 * Clean-room default prompts for the Evaluation node's built-in LLM-as-judge
 * metrics. These are only defaults — a user can override them in the node UI.
 *
 * Contract (see ../utils/metricHandlers.ts and ./Description.node.ts):
 * - `*_PROMPT` is the default *system* prompt. It is passed to the chain as the
 *   `systemPrompt` invoke variable (the system message template is literally
 *   `{systemPrompt}`), so it is used verbatim and may contain any characters.
 * - `*_INPUT_PROMPT[0]` is the default *human-message* template, parsed by
 *   LangChain's `HumanMessagePromptTemplate.fromTemplate`. It may therefore only
 *   contain the `{placeholder}` variables supplied at invoke time.
 * - `*_INPUT_PROMPT[1]` is an optional plain-text UI hint (not a template).
 *
 * Both metrics use structured output with fields `extended_reasoning`,
 * `reasoning_summary`, and an integer `score` from 1 to 5.
 */

export const CORRECTNESS_PROMPT = `You are an impartial evaluator scoring the correctness of an AI-generated answer against a reference (expected) answer.

Judge how well the actual answer matches the expected answer in factual accuracy and meaning. Ignore differences in wording, formatting, or style that do not change the meaning. Penalize missing facts, added incorrect facts, and contradictions.

Reason through the comparison step by step, write a one-sentence summary, then assign an integer score from 1 to 5 using this rubric:
5 — Fully correct: all key facts match; no contradictions or omissions.
4 — Mostly correct: a minor omission or imprecision that does not mislead.
3 — Partially correct: some key facts match, but there are notable gaps or errors.
2 — Mostly incorrect: only marginal overlap with the expected answer.
1 — Incorrect: contradicts the expected answer or is unrelated.`;

export const CORRECTNESS_INPUT_PROMPT = [
	`Expected answer:
{expected_answer}

Actual answer:
{actual_answer}

Compare the actual answer against the expected answer and score its correctness.`,
	'Available variables: {expected_answer}, {actual_answer}',
];

export const HELPFULNESS_PROMPT = `You are an impartial evaluator scoring how helpful an AI-generated answer is in response to a user's query.

Judge whether the actual answer directly addresses the query, is relevant and complete, and would genuinely help the user accomplish their goal. Reward clarity, relevance, and actionable detail; penalize vagueness, irrelevance, and unanswered parts of the query.

Reason through your assessment step by step, write a one-sentence summary, then assign an integer score from 1 to 5 using this rubric:
5 — Extremely helpful: fully addresses the query; clear and complete.
4 — Helpful: addresses the query with only minor gaps.
3 — Somewhat helpful: partially addresses the query.
2 — Slightly helpful: largely fails to address the query.
1 — Not helpful: irrelevant or fails to address the query.`;

export const HELPFULNESS_INPUT_PROMPT = [
	`User query:
{user_query}

Actual answer:
{actual_answer}

Assess how helpful the actual answer is for the user query and score it.`,
	'Available variables: {user_query}, {actual_answer}',
];
