import { ConfigService } from '@nestjs/config';
import { InMemoryLibraryRepository } from './library.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { LibraryService } from './library.service';
import { LibraryRelationsService } from './library-relations.service';
import { InMemoryLibraryRelationsRepository } from './library-relations.repository';

export async function fixture(sourceHealth?: { valid: boolean }) {
  const repository = new InMemoryLibraryRepository();
  const relations = new InMemoryLibraryRelationsRepository();
  const profiles = new InMemoryProfileRepository();
  const identity = new InMemoryIdentityRepository();
  const reviewer = await identity.createUser({
    email: 'related-reviewer@example.test',
    displayName: 'Reviewer',
    passwordHash: null,
    status: 'ACTIVE',
  });
  await identity.replaceUserRoles(reviewer.id, ['MODERATOR']);
  const library = new LibraryService(repository, profiles, {
    findLibraryCandidateById: async () => null,
    ...(sourceHealth
      ? {
          inspectLibraryCandidateSource: async () => ({
            valid: sourceHealth.valid,
            reason: sourceHealth.valid
              ? ('VALID' as const)
              : ('CANDIDATE_MISSING' as const),
          }),
        }
      : {}),
  });
  await repository.upsertLicense({
    licenseKey: 'TEST-V1',
    displayName: 'Test License',
    canonicalUrl: 'https://example.test/license',
    attributionRequired: true,
    redistributionAllowed: true,
    derivativeConstraints: null,
    active: true,
    sourceNote: null,
  });
  async function resource(term: string) {
    const r = await repository.createResource({
      createdByUserId: reviewer.id,
      createdAt: new Date(),
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      secondaryLanguageCode: null,
      cefrLevel: 'A1',
      topics: [],
      visibility: 'PUBLIC',
      details: {
        resourceType: 'VOCABULARY',
        term,
        definition: 'synthetic definition',
        partOfSpeech: null,
        exampleSentence: null,
      },
    });
    await library.attachProvenance(
      { userId: reviewer.id, roles: ['MODERATOR'] },
      r.id,
      {
        sourceType: 'MANUAL_ENTRY',
        sourceId: 'test:' + term,
        licenseKey: 'TEST-V1',
        attribution: 'Synthetic fixture',
      },
    );
    const current = (await repository.findResourceById(r.id))!;
    await repository.transitionReview({
      resourceId: r.id,
      expectedPreviousState: 'DRAFT',
      expectedProvenanceRevision: current.provenanceRevision,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: reviewer.id,
      note: 'synthetic reviewed fixture',
      occurredAt: new Date(),
    });

    return r;
  }
  const anchor = await resource('anchor');
  const target = await resource('target');
  const service = new LibraryRelationsService(
    library,
    repository,
    relations,
    identity,
    profiles,
    new ConfigService({
      auth: { accessSecret: 'synthetic-related-cursor-test-secret' },
    }),
  );
  return {
    service,
    repository,
    relations,
    profiles,
    identity,
    reviewer,
    library,
    anchor,
    target,
    resource,
  };
}
