import { randomUUID } from 'node:crypto';
import type { AiConversationMode, AiConversationStatus, AiRoleplayConfig } from './ai.conversation.contracts';
import type { AiLearnerContext } from './ai.context';

export const AI_CONVERSATION_REPOSITORY = 'AI_CONVERSATION_REPOSITORY';
export type AiConversationTurnRole = 'learner' | 'assistant';
export type AiConversationTurnKind = 'response' | 'explanation';

export interface AiConversationTurn {
  id: string;
  role: AiConversationTurnRole;
  kind: AiConversationTurnKind;
  content: string;
  createdAt: Date;
  requestId: string;
}

export interface AiConversationRecord {
  id: string;
  ownerUserId: string;
  mode: AiConversationMode;
  responseLanguageCode: string;
  learnerContext: AiLearnerContext;
  roleplay: AiRoleplayConfig | null;
  turns: AiConversationTurn[];
  status: AiConversationStatus;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAiConversationRecordInput {
  ownerUserId: string;
  mode: AiConversationMode;
  responseLanguageCode: string;
  learnerContext: AiLearnerContext;
  roleplay: AiRoleplayConfig | null;
  createdAt?: Date;
}

export interface AiConversationRepository {
  create(input: CreateAiConversationRecordInput): Promise<AiConversationRecord>;
  findById(id: string): Promise<AiConversationRecord | null>;
  save(record: AiConversationRecord): Promise<AiConversationRecord>;
}

export class InMemoryAiConversationRepository implements AiConversationRepository {
  private readonly records = new Map<string, AiConversationRecord>();

  async create(input: CreateAiConversationRecordInput): Promise<AiConversationRecord> {
    const now = input.createdAt ? new Date(input.createdAt) : new Date();
    const record: AiConversationRecord = {
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      mode: input.mode,
      responseLanguageCode: input.responseLanguageCode,
      learnerContext: cloneLearnerContext(input.learnerContext),
      roleplay: input.roleplay ? cloneRoleplay(input.roleplay) : null,
      turns: [],
      status: 'ACTIVE',
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return cloneRecord(record);
  }

  async findById(id: string): Promise<AiConversationRecord | null> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : null;
  }

  async save(record: AiConversationRecord): Promise<AiConversationRecord> {
    this.records.set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }
}

function cloneRecord(record: AiConversationRecord): AiConversationRecord {
  return {
    ...record,
    learnerContext: cloneLearnerContext(record.learnerContext),
    roleplay: record.roleplay ? cloneRoleplay(record.roleplay) : null,
    turns: record.turns.map((turn) => ({ ...turn, createdAt: new Date(turn.createdAt) })),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function cloneLearnerContext(context: AiLearnerContext): AiLearnerContext {
  return {
    ...context,
    targetLanguage: { ...context.targetLanguage },
    proficiency: { ...context.proficiency },
    learningGoals: [...context.learningGoals],
  };
}

function cloneRoleplay(roleplay: AiRoleplayConfig): AiRoleplayConfig {
  return {
    ...roleplay,
    constraints: [...roleplay.constraints],
    safeBoundaries: [...roleplay.safeBoundaries],
    goals: [...roleplay.goals],
  };
}
