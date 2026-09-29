import { isUuid } from './tatoeba-preflight.contract';
import {
  safeTatoebaInputPairIdentity,
  safeTatoebaTranslationIdentity,
  validateTatoebaTranslationImportCandidate,
} from './tatoeba-translation-import.contract';
import type {
  TatoebaTranslationImportCommand,
  TatoebaTranslationImportOutcome,
  TatoebaTranslationImportRepository,
} from './tatoeba-translation-import.types';

export class TatoebaTranslationImportService {
  constructor(private readonly repository: TatoebaTranslationImportRepository) {}

  async importTranslation(command: TatoebaTranslationImportCommand): Promise<TatoebaTranslationImportOutcome> {
    if (!isUuid(command.actorUserId)) {
      return {
        status: 'QUARANTINED',
        durableIdentity: null,
        inputPairIdentity: null,
        reason: 'TATOEBA_IMPORT_ACTOR_ID_INVALID',
        durableResourceCreated: false,
      };
    }

    const validation = validateTatoebaTranslationImportCandidate(command.candidate);
    if (!validation.ok) {
      return {
        status: 'QUARANTINED',
        durableIdentity: safeTatoebaTranslationIdentity(command.candidate?.durableIdentity),
        inputPairIdentity: safeTatoebaInputPairIdentity(command.candidate?.inputPairIdentity),
        reason: validation.reason,
        durableResourceCreated: false,
      };
    }

    return this.repository.importTranslation(command);
  }
}
