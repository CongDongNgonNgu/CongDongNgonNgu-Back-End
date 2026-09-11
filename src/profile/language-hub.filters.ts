import {
  buildLanguageHubFilterSummary,
  CEFR_LEVELS,
  type CefrLevel,
  type LanguageHubFilterInput,
  type LanguageHubFilterSummary,
} from './language-hub.contract';
import { ProfileFailure } from './profile.errors';

const TOPIC_PATTERN = /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u;
const MAX_TOPIC_LENGTH = 80;

export function normalizeLanguageHubFilters(
  input: LanguageHubFilterInput = {},
): LanguageHubFilterSummary {
  const levels = normalizeLevels(input.level);
  const topic = normalizeTopic(input.topic);
  return {
    ...buildLanguageHubFilterSummary(),
    levels,
    topic,
  };
}

function normalizeLevels(input: readonly string[] | undefined): CefrLevel[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw invalidLevel();
  }

  const normalized = input.map((value) => {
    if (typeof value !== 'string') {
      throw invalidLevel();
    }
    const level = value.normalize('NFKC').trim().toUpperCase() as CefrLevel;
    if (!CEFR_LEVELS.includes(level)) {
      throw invalidLevel();
    }
    return level;
  });

  return [...new Set(normalized)].sort(
    (left, right) => CEFR_LEVELS.indexOf(left) - CEFR_LEVELS.indexOf(right),
  );
}

function normalizeTopic(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw invalidTopic();
  }

  let topic: string;
  try {
    topic = input
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/\s+/gu, '-');
  } catch {
    throw invalidTopic();
  }

  if (topic.length === 0) return null;
  if (topic.length > MAX_TOPIC_LENGTH || !TOPIC_PATTERN.test(topic)) {
    throw invalidTopic();
  }
  return topic;
}

function invalidLevel(): ProfileFailure {
  return new ProfileFailure('LANGUAGE_INVALID_LEVEL', 400, 'Language level is invalid');
}

function invalidTopic(): ProfileFailure {
  return new ProfileFailure('LANGUAGE_INVALID_TOPIC', 400, 'Language topic is invalid');
}
