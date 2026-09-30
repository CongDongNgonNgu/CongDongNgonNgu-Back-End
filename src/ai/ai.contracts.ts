export type AiContractErrorCode =
  | 'AI_CONTEXT_INVALID'
  | 'AI_CONTEXT_TARGET_UNAVAILABLE'
  | 'AI_CONTEXT_TARGET_AMBIGUOUS'
  | 'AI_PROMPT_INVALID'
  | 'AI_PROMPT_MODE_INVALID'
  | 'AI_PROMPT_INPUT_TOO_LARGE'
  | 'AI_COACHING_REQUEST_INVALID'
  | 'AI_STRUCTURED_OUTPUT_INVALID';

export class AiContractError extends Error {
  readonly name = 'AiContractError';

  constructor(
    readonly code: AiContractErrorCode,
    message: string,
  ) {
    super(message);
  }
}
