import { isUuid } from './tatoeba-preflight.contract';
import {
  safeTatoebaSentenceSourceIdentity,
  validateTatoebaSentenceImportCandidate,
} from './tatoeba-sentence-import.contract';
import type {
  TatoebaSentenceImportCommand,
  TatoebaSentenceImportOutcome,
  TatoebaSentenceImportRepository,
} from './tatoeba-sentence-import.types';

export class TatoebaSentenceImportService {
  constructor(private readonly repository: TatoebaSentenceImportRepository) {}

  async importSentence(command: TatoebaSentenceImportCommand): Promise<TatoebaSentenceImportOutcome> {
    if (!isUuid(command.actorUserId)) {
      return {
        status: 'QUARANTINED',
        sourceIdentity: safeTatoebaSentenceSourceIdentity(command.candidate.sourceIdentity),
        reason: 'TATOEBA_IMPORT_ACTOR_ID_INVALID',
        durableResourceCreated: false,
      };
    }

    const validation = validateTatoebaSentenceImportCandidate(command.candidate);
    if (!validation.ok) {
      return {
        status: 'QUARANTINED',
        sourceIdentity: safeTatoebaSentenceSourceIdentity(command.candidate.sourceIdentity),
        reason: validation.reason,
        durableResourceCreated: false,
      };
    }

    return this.repository.importSentence(command);
  }
}
