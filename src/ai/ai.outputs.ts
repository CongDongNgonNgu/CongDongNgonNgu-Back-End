import { AiContractError } from './ai.contracts';

export const AI_OUTPUT_CONTRACT_VERSION = 'ai.output.v1' as const;

export const AI_STRUCTURED_OUTPUT_KINDS = [
  'WRITING_CORRECTION',
  'GRAMMAR_COACHING',
  'QUIZ_MATERIAL',
  'LEARN_FROM_CONTENT',
] as const;

export type AiStructuredOutputKind = typeof AI_STRUCTURED_OUTPUT_KINDS[number];

export interface AiWritingCorrection {
  readonly originalText: string;
  readonly correctedText: string;
  readonly explanation: string;
  readonly naturalAlternative: string | null;
}

export interface AiWritingCorrectionOutput {
  readonly version: typeof AI_OUTPUT_CONTRACT_VERSION;
  readonly kind: 'WRITING_CORRECTION';
  readonly summary: string;
  readonly corrections: readonly AiWritingCorrection[];
}

export interface AiGrammarExample {
  readonly incorrectText: string;
  readonly correctedText: string;
  readonly explanation: string;
}

export interface AiGrammarPracticeItem {
  readonly prompt: string;
  readonly answer: string;
  readonly explanation: string;
}

export interface AiGrammarCoachingOutput {
  readonly version: typeof AI_OUTPUT_CONTRACT_VERSION;
  readonly kind: 'GRAMMAR_COACHING';
  readonly explanation: string;
  readonly examples: readonly AiGrammarExample[];
  readonly practiceItems: readonly AiGrammarPracticeItem[];
}

export interface AiQuizItem {
  readonly question: string;
  readonly options: readonly string[];
  readonly correctOptionIndex: number;
  readonly explanation: string;
}

export interface AiQuizMaterialOutput {
  readonly version: typeof AI_OUTPUT_CONTRACT_VERSION;
  readonly kind: 'QUIZ_MATERIAL';
  readonly title: string;
  readonly items: readonly AiQuizItem[];
}

export interface AiLearningVocabularyItem {
  readonly term: string;
  readonly meaning: string;
  readonly exampleSentence: string;
}

export interface AiLearningGrammarNote {
  readonly title: string;
  readonly explanation: string;
  readonly example: string;
}

export interface AiLearningQuestion {
  readonly question: string;
  readonly answerGuide: string;
}

export interface AiLearningSpeakingPrompt {
  readonly prompt: string;
  readonly followUp: string;
}

export interface AiLearnFromContentOutput {
  readonly version: typeof AI_OUTPUT_CONTRACT_VERSION;
  readonly kind: 'LEARN_FROM_CONTENT';
  readonly summary: string;
  readonly vocabulary: readonly AiLearningVocabularyItem[];
  readonly grammarNotes: readonly AiLearningGrammarNote[];
  readonly questions: readonly AiLearningQuestion[];
  readonly miniQuiz: readonly AiQuizItem[];
  readonly speakingPrompts: readonly AiLearningSpeakingPrompt[];
}

export type AiStructuredOutput =
  | AiWritingCorrectionOutput
  | AiGrammarCoachingOutput
  | AiQuizMaterialOutput
  | AiLearnFromContentOutput;

const MAX_OUTPUT_JSON_LENGTH = 20_000;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_EXPLANATION_LENGTH = 1_500;
const MAX_TEXT_LENGTH = 800;
const MAX_ITEMS = 20;

export function parseAiStructuredOutput(
  kind: AiStructuredOutputKind,
  value: unknown,
): AiStructuredOutput {
  const parsed = parseJsonIfNeeded(value);
  if (!isRecord(parsed)) throw invalidOutput();

  switch (kind) {
    case 'WRITING_CORRECTION':
      return parseWritingCorrection(parsed);
    case 'GRAMMAR_COACHING':
      return parseGrammarCoaching(parsed);
    case 'QUIZ_MATERIAL':
      return parseQuizMaterial(parsed);
    case 'LEARN_FROM_CONTENT':
      return parseLearnFromContent(parsed);
    default:
      throw invalidOutput();
  }
}

function parseLearnFromContent(value: Record<string, unknown>): AiLearnFromContentOutput {
  requireExactKeys(value, [
    'version',
    'kind',
    'summary',
    'vocabulary',
    'grammarNotes',
    'questions',
    'miniQuiz',
    'speakingPrompts',
  ]);
  if (value.version !== AI_OUTPUT_CONTRACT_VERSION || value.kind !== 'LEARN_FROM_CONTENT') {
    throw invalidOutput();
  }
  const vocabulary = readBoundedArray(value.vocabulary, parseLearningVocabularyItem);
  const grammarNotes = readBoundedArray(value.grammarNotes, parseLearningGrammarNote);
  const questions = readBoundedArray(value.questions, parseLearningQuestion);
  const miniQuiz = readBoundedArray(value.miniQuiz, parseQuizItem);
  const speakingPrompts = readBoundedArray(value.speakingPrompts, parseLearningSpeakingPrompt);
  return {
    version: AI_OUTPUT_CONTRACT_VERSION,
    kind: 'LEARN_FROM_CONTENT',
    summary: readText(value.summary, MAX_SUMMARY_LENGTH),
    vocabulary,
    grammarNotes,
    questions,
    miniQuiz,
    speakingPrompts,
  };
}

function parseLearningVocabularyItem(value: unknown): AiLearningVocabularyItem {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['term', 'meaning', 'exampleSentence']);
  return {
    term: readText(value.term, MAX_TEXT_LENGTH),
    meaning: readText(value.meaning, MAX_EXPLANATION_LENGTH),
    exampleSentence: readText(value.exampleSentence, MAX_TEXT_LENGTH),
  };
}

function parseLearningGrammarNote(value: unknown): AiLearningGrammarNote {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['title', 'explanation', 'example']);
  return {
    title: readText(value.title, MAX_TEXT_LENGTH),
    explanation: readText(value.explanation, MAX_EXPLANATION_LENGTH),
    example: readText(value.example, MAX_TEXT_LENGTH),
  };
}

function parseLearningQuestion(value: unknown): AiLearningQuestion {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['question', 'answerGuide']);
  return {
    question: readText(value.question, MAX_TEXT_LENGTH),
    answerGuide: readText(value.answerGuide, MAX_EXPLANATION_LENGTH),
  };
}

function parseLearningSpeakingPrompt(value: unknown): AiLearningSpeakingPrompt {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['prompt', 'followUp']);
  return {
    prompt: readText(value.prompt, MAX_TEXT_LENGTH),
    followUp: readText(value.followUp, MAX_TEXT_LENGTH),
  };
}

function readBoundedArray<T>(value: unknown, parser: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw invalidOutput();
  return value.map(parser);
}

function parseWritingCorrection(value: Record<string, unknown>): AiWritingCorrectionOutput {
  requireExactKeys(value, ['version', 'kind', 'summary', 'corrections']);
  if (value.version !== AI_OUTPUT_CONTRACT_VERSION || value.kind !== 'WRITING_CORRECTION') {
    throw invalidOutput();
  }
  if (!Array.isArray(value.corrections) || value.corrections.length < 1 || value.corrections.length > MAX_ITEMS) {
    throw invalidOutput();
  }

  return {
    version: AI_OUTPUT_CONTRACT_VERSION,
    kind: 'WRITING_CORRECTION',
    summary: readText(value.summary, MAX_SUMMARY_LENGTH),
    corrections: value.corrections.map(parseWritingCorrectionItem),
  };
}

function parseWritingCorrectionItem(value: unknown): AiWritingCorrection {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['originalText', 'correctedText', 'explanation', 'naturalAlternative']);
  return {
    originalText: readText(value.originalText, MAX_TEXT_LENGTH),
    correctedText: readText(value.correctedText, MAX_TEXT_LENGTH),
    explanation: readText(value.explanation, MAX_EXPLANATION_LENGTH),
    naturalAlternative: value.naturalAlternative === null
      ? null
      : readText(value.naturalAlternative, MAX_TEXT_LENGTH),
  };
}

function parseGrammarCoaching(value: Record<string, unknown>): AiGrammarCoachingOutput {
  requireExactKeys(value, ['version', 'kind', 'explanation', 'examples', 'practiceItems']);
  if (value.version !== AI_OUTPUT_CONTRACT_VERSION || value.kind !== 'GRAMMAR_COACHING') {
    throw invalidOutput();
  }
  if (!Array.isArray(value.examples) || value.examples.length < 1 || value.examples.length > MAX_ITEMS) {
    throw invalidOutput();
  }
  if (!Array.isArray(value.practiceItems) || value.practiceItems.length < 1 || value.practiceItems.length > MAX_ITEMS) {
    throw invalidOutput();
  }

  return {
    version: AI_OUTPUT_CONTRACT_VERSION,
    kind: 'GRAMMAR_COACHING',
    explanation: readText(value.explanation, MAX_EXPLANATION_LENGTH),
    examples: value.examples.map(parseGrammarExample),
    practiceItems: value.practiceItems.map(parseGrammarPracticeItem),
  };
}

function parseGrammarExample(value: unknown): AiGrammarExample {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['incorrectText', 'correctedText', 'explanation']);
  return {
    incorrectText: readText(value.incorrectText, MAX_TEXT_LENGTH),
    correctedText: readText(value.correctedText, MAX_TEXT_LENGTH),
    explanation: readText(value.explanation, MAX_EXPLANATION_LENGTH),
  };
}

function parseGrammarPracticeItem(value: unknown): AiGrammarPracticeItem {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['prompt', 'answer', 'explanation']);
  return {
    prompt: readText(value.prompt, MAX_TEXT_LENGTH),
    answer: readText(value.answer, MAX_TEXT_LENGTH),
    explanation: readText(value.explanation, MAX_EXPLANATION_LENGTH),
  };
}

function parseQuizMaterial(value: Record<string, unknown>): AiQuizMaterialOutput {
  requireExactKeys(value, ['version', 'kind', 'title', 'items']);
  if (value.version !== AI_OUTPUT_CONTRACT_VERSION || value.kind !== 'QUIZ_MATERIAL') {
    throw invalidOutput();
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ITEMS) {
    throw invalidOutput();
  }

  return {
    version: AI_OUTPUT_CONTRACT_VERSION,
    kind: 'QUIZ_MATERIAL',
    title: readText(value.title, MAX_SUMMARY_LENGTH),
    items: value.items.map(parseQuizItem),
  };
}

function parseQuizItem(value: unknown): AiQuizItem {
  if (!isRecord(value)) throw invalidOutput();
  requireExactKeys(value, ['question', 'options', 'correctOptionIndex', 'explanation']);
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 6) {
    throw invalidOutput();
  }
  const correctOptionIndex = value.correctOptionIndex;
  if (!Number.isInteger(correctOptionIndex)
    || (correctOptionIndex as number) < 0
    || (correctOptionIndex as number) >= value.options.length) {
    throw invalidOutput();
  }
  const options = value.options.map((option) => readText(option, MAX_TEXT_LENGTH));
  if (new Set(options).size !== options.length) throw invalidOutput();

  return {
    question: readText(value.question, MAX_TEXT_LENGTH),
    options,
    correctOptionIndex: correctOptionIndex as number,
    explanation: readText(value.explanation, MAX_EXPLANATION_LENGTH),
  };
}

function parseJsonIfNeeded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length > MAX_OUTPUT_JSON_LENGTH) throw invalidOutput();
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidOutput();
  }
}

function readText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw invalidOutput();
  const normalized = value.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) {
    throw invalidOutput();
  }
  return normalized;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidOutput();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidOutput(): AiContractError {
  return new AiContractError(
    'AI_STRUCTURED_OUTPUT_INVALID',
    'AI structured output is invalid',
  );
}
