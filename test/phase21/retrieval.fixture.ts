// Test-only adapter: never imported by src, registered in a module or deployed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryLibraryRepository } from '../../src/library/library.repository';
import { LibraryService } from '../../src/library/library.service';
import { normalizeLibraryResourceInput } from '../../src/library/library.normalization';
import { InMemoryProfileRepository } from '../../src/profile/profile.repository';
import type { LibraryPublicResource, LibraryResourceRecord, LibraryResourceType } from '../../src/library/library.types';
import type { CommunityCefrLevel } from '../../src/community/community.types';

export interface Query {
  id: string; q: string; anchor: string; relation: string;
  language?: string; type?: LibraryResourceType; level?: CommunityCefrLevel;
  expected: string[]; control?: boolean;
}
interface Fixture {
  version: string;
  resources: Array<{ key: string; language: string; secondary?: string; level: CommunityCefrLevel;
    type: LibraryResourceType; topics: string[]; details: Record<string, unknown> }>;
  relations: Array<{ id: string; from: string; to: string; type: string; reason: string }>;
  queries: Query[];
  configuration: { k: number; maxEdges: number; maxPool: number; maxQueries: number; traversalHops: number; fallback: string };
  thresholds: { candidateMacroRecallMinimum: number; macroRecallGainMinimum: number;
    returnedPrecisionMinimum: number; controlRegressionsMaximum: number;
    correctEmptyQueriesRequired: number; safetyViolationsMaximum: number };
}
export const fixtureBytes = readFileSync(join(__dirname, 'fixture-v1.json'), 'utf8');
export const fixture: Fixture = JSON.parse(fixtureBytes);
export const fingerprint = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export interface Edge { id: string; from: string; to: string; type: string; reason: string;
  owner: string; fromVersion: string; toVersion: string }
interface Reference { id: string; version: string; edgeId: string | null; edgeVersion: string | null }
interface Prepared { query: Query; anchorVersion: string | null; mode: 'RELATIONAL' | 'LEXICAL_FALLBACK' | 'ABSTAIN'; references: Reference[] }
interface Result { mode: Prepared['mode']; items: Array<{ resource: LibraryPublicResource;
  relation: { id: string; type: string; reason: string; owner: string } | null }> }
const types = new Set(['SAME_CONCEPT', 'PREREQUISITE', 'FOLLOW_UP', 'DIRECT_TRANSLATION', 'COLLECTION_MEMBER']);

export async function createExperiment() {
  if (fixture.resources.length > fixture.configuration.maxPool || fixture.queries.length > fixture.configuration.maxQueries) {
    throw new Error('Fixture exceeds frozen bounds');
  }
  const repository = new InMemoryLibraryRepository();
  // Explicit disposable mutation seam, confined to this test adapter.
  const records = (repository as unknown as { resources: Map<string, LibraryResourceRecord> }).resources;
  const invalidSources = new Set<string>();
  const service = new LibraryService(repository, new InMemoryProfileRepository(), {
    findLibraryCandidateById: async () => null,
    inspectLibraryCandidateSource: async reference => invalidSources.has(reference.sourceId)
      ? { valid: false, reason: 'CANDIDATE_INVALIDATED' } : { valid: true, reason: 'VALID' },
  });
  const licenseInput = {
    licenseKey: 'PHASE21-TEST', displayName: 'Synthetic test permission',
    canonicalUrl: 'https://example.invalid/phase21-test-license', attributionRequired: true,
    redistributionAllowed: true, active: true,
  };
  const license = await service.registerLicense({ userId: 'synthetic-reviewer', roles: ['MODERATOR'] }, licenseInput);
  // Remove wall-clock variation from public source cards.
  license.createdAt = license.updatedAt = new Date('2026-10-07T00:00:00Z');
  const idMap = new Map(fixture.resources.map((r, i) => [r.key, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
  const id = (key: string): string => idMap.get(key) ?? key;
  for (const [i, resource] of fixture.resources.entries()) {
    const timestamp = new Date(Date.parse('2026-10-07T00:00:00Z') + i * 1000);
    const normalized = normalizeLibraryResourceInput({ resourceType: resource.type,
      primaryLanguageCode: resource.language, secondaryLanguageCode: resource.secondary,
      cefrLevel: resource.level, topics: resource.topics, visibility: 'PUBLIC', details: resource.details });
    records.set(id(resource.key), {
      ...normalized, id: id(resource.key), createdByUserId: 'synthetic-author', moderationState: 'ACTIVE',
      reviewState: 'VERIFIED', createdAt: timestamp, updatedAt: timestamp, reviewedByUserId: 'synthetic-reviewer',
      reviewedAt: timestamp, provenanceRevision: 1,
      provenance: [{ id: `provenance:${resource.key}`, resourceId: id(resource.key), sourceType: 'ORIGINAL_AUTHOR',
        sourceId: `phase21:${resource.key}`, sourceUrl: null, licenseKey: license.licenseKey,
        attribution: `Synthetic Phase21 fixture: ${resource.key}`, originalAuthorReference: 'Synthetic test curator',
        originalContributorUserId: null, importBatch: null, transformationHistory: [], sourcePostId: null,
        sourceResponseId: null, sourceCandidateId: null, sourceAcceptanceId: null,
        createdAt: timestamp, updatedAt: timestamp, license }],
    });
  }
  const versions = new Map<string, string>();
  for (const key of idMap.keys()) versions.set(id(key), fingerprint(await service.getPublicResource(id(key))));
  const experiment = {
    fixtureBytes, service, repository, records, id,
    edges: fixture.relations.map(edge => ({ ...edge, from: id(edge.from), to: id(edge.to),
      owner: 'phase21-reviewed-fixture-v1', fromVersion: versions.get(id(edge.from))!, toVersion: versions.get(id(edge.to))! })),
    async baseline(query: Query) {
      return service.searchPublicResources({ q: query.q, language: query.language, type: query.type,
        level: query.level, limit: fixture.configuration.k });
    },
    async prepare(query: Query): Promise<Prepared> {
      const anchor = await service.getPublicResource(id(query.anchor));
      const prepared: Prepared = { query: structuredClone(query), anchorVersion: anchor ? fingerprint(anchor) : null,
        mode: 'ABSTAIN', references: [] };
      if (!anchor || experiment.edges.length > fixture.configuration.maxEdges || !types.has(query.relation)) return prepared;
      const seen = new Set<string>();
      for (const edge of experiment.edges.filter(validEdge).sort((a, b) => a.id.localeCompare(b.id))) {
        if (!validEdge(edge) || edge.from !== anchor.id || edge.type !== query.relation || seen.has(edge.to)
          || edge.fromVersion !== prepared.anchorVersion) continue;
        const target = await service.getPublicResource(edge.to);
        if (!target || target.id !== edge.to || fingerprint(target) !== edge.toVersion || !matches(target, query)) continue;
        prepared.references.push({ id: target.id, version: fingerprint(target), edgeId: edge.id, edgeVersion: fingerprint(edge) });
        seen.add(target.id);
        if (prepared.references.length === fixture.configuration.k) break;
      }
      if (prepared.references.length) prepared.mode = 'RELATIONAL';
      else {
        prepared.mode = 'LEXICAL_FALLBACK';
        for (const item of (await experiment.baseline(query)).items) {
          const target = await service.getPublicResource(item.id);
          if (target && target.id === item.id && matches(target, query)) {
            prepared.references.push({ id: target.id, version: fingerprint(target), edgeId: null, edgeVersion: null });
          }
        }
      }
      return prepared;
    },
    async serialize(prepared: Prepared): Promise<Result> {
      const result: Result = { mode: prepared.mode, items: [] };
      const anchor = await service.getPublicResource(id(prepared.query.anchor));
      if (!anchor || fingerprint(anchor) !== prepared.anchorVersion || experiment.edges.length > fixture.configuration.maxEdges) return result;
      for (const reference of prepared.references.slice(0, fixture.configuration.k)) {
        const edge = reference.edgeId ? experiment.edges.filter(validEdge).find(x => x.id === reference.edgeId) : null;
        if (reference.edgeId && (!edge || !validEdge(edge) || fingerprint(edge) !== reference.edgeVersion
          || edge.from !== anchor.id || edge.to !== reference.id || edge.type !== prepared.query.relation)) continue;
        const target = await service.getPublicResource(reference.id);
        if (!target || target.id !== reference.id || fingerprint(target) !== reference.version || !matches(target, prepared.query)) continue;
        result.items.push({ resource: target, relation: edge
          ? { id: edge.id, type: edge.type, reason: edge.reason, owner: edge.owner } : null });
      }
      return result;
    },
    async retrieve(query: Query) { return experiment.serialize(await experiment.prepare(query)); },
    async invalidate(key: string, state: string) {
      const record = records.get(id(key))!;
      if (state === 'PRIVATE') record.visibility = 'PRIVATE';
      if (state === 'INACTIVE') record.moderationState = 'HIDDEN';
      if (state === 'UNVERIFIED') record.reviewState = 'COMMUNITY_REVIEW';
      if (state === 'DELETED') records.delete(id(key));
      if (state === 'PROVENANCE_MISSING') record.provenance = [];
      if (state === 'LICENSE_MISSING') record.provenance[0].licenseKey = 'UNKNOWN-TEST';
      if (state === 'LICENSE_INACTIVE') await service.registerLicense({ userId: 'synthetic-reviewer', roles: ['MODERATOR'] }, { ...licenseInput, active: false });
      if (state === 'LICENSE_UNSAFE') await service.registerLicense({ userId: 'synthetic-reviewer', roles: ['MODERATOR'] }, { ...licenseInput, redistributionAllowed: false });
      if (state === 'SOURCE_CHANGED') record.provenance[0].sourceId = 'phase21:changed';
      if (state === 'SOURCE_INVALID') {
        Object.assign(record.provenance[0], { sourceType: 'PHASE06_LIBRARY_CANDIDATE',
          sourceId: id(key), sourceCandidateId: id(key), sourcePostId: id('present'),
          sourceResponseId: id('past'), sourceAcceptanceId: id('perfect') });
        invalidSources.add(id(key));
      }
    },
  };
  return experiment;
}

function validEdge(value: unknown): value is Edge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return typeof edge.id === 'string' && /^e\d{2}$/.test(edge.id)
    && typeof edge.type === 'string' && types.has(edge.type)
    && typeof edge.from === 'string' && typeof edge.to === 'string' && edge.from !== edge.to
    && typeof edge.reason === 'string' && edge.reason.trim().length > 0 && edge.reason.length <= 300
    && edge.owner === 'phase21-reviewed-fixture-v1'
    && typeof edge.fromVersion === 'string' && typeof edge.toVersion === 'string';
}
function matches(resource: LibraryPublicResource, query: Query): boolean {
  return (!query.language || resource.primaryLanguageCode === query.language || resource.secondaryLanguageCode === query.language)
    && (!query.type || resource.resourceType === query.type) && (!query.level || resource.cefrLevel === query.level);
}
