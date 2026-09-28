import {
  TatoebaPreflightError,
  validateImportActor,
  validateImportLicense,
} from './tatoeba-preflight.contract';
import {
  TATOEBA_REQUIRED_LICENSE_KEYS,
  type TatoebaImportPreflightInput,
  type TatoebaImportPreflightRepository,
  type TatoebaImportPreflightResult,
  type TatoebaLicenseContractSummaries,
} from './tatoeba-preflight.types';

export async function runTatoebaImportPreflight(
  input: TatoebaImportPreflightInput,
  repository: TatoebaImportPreflightRepository,
): Promise<TatoebaImportPreflightResult> {
  try {
    return await repository.withReadOnlyTransaction(async (transaction) => {
      const actor = await transaction.findImportActor(input.actorUserId);
      const actorValidation = validateImportActor(input.actorUserId, actor);
      if (!actorValidation.ok) {
        return {
          status: 'FAIL',
          environment: input.environment,
          reason: actorValidation.reason,
          actor: actorValidation.summary,
        };
      }

      const licenses: Partial<TatoebaLicenseContractSummaries> = {};
      for (const key of TATOEBA_REQUIRED_LICENSE_KEYS) {
        const license = await transaction.findLicense(key);
        const validation = validateImportLicense(key, license);
        licenses[key] = validation.summary;
        if (!validation.ok) {
          return {
            status: 'FAIL',
            environment: input.environment,
            reason: validation.reason,
            actor: actorValidation.summary,
            licenses,
          };
        }
      }

      return {
        status: 'PASS',
        environment: input.environment,
        actor: actorValidation.summary,
        licenses: licenses as TatoebaLicenseContractSummaries,
      };
    });
  } catch (error) {
    if (error instanceof TatoebaPreflightError) throw error;
    throw new TatoebaPreflightError(
      'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
      'Tatoeba import preflight database access failed closed.',
    );
  }
}
