import { StudyGroupExperiment, type Actor } from './study-group.experiment';
import { InMemoryIdentityRepository } from '../../src/identity/identity.repository';
import { InMemoryProfileRepository } from '../../src/profile/profile.repository';
import { InMemoryCommunityRepository } from '../../src/community/community.repository';
import { CommunityRateLimiter } from '../../src/community/community.rate-limiter';
import { CommunityService } from '../../src/community/community.service';

const actor = (name: string, claimedRole?: string): NonNullable<Actor> => ({ id: `synthetic:${name}`, claimedRole });
const owner = actor('owner-a');
const moderator = actor('moderator-a');
const member = actor('member-a');
const outsider = actor('outsider');
const platform = actor('platform', 'ADMIN');
const otherOwner = actor('owner-b');
const otherModerator = actor('moderator-b');
const otherMember = actor('member-b');
const identities = [owner, moderator, member, outsider, platform, otherOwner, otherModerator, otherMember];
const denied = (operation: () => unknown) => expect(operation).toThrow(/^RESOURCE_UNAVAILABLE$/);

describe('Phase 20 synthetic TEST study-group policy', () => {
  let experiment: StudyGroupExperiment;
  let clock: number;
  let text: string;
  beforeEach(() => {
    clock = 1000;
    experiment = new StudyGroupExperiment('TEST', identities.map(a => a.id), () => clock, [
      { id: 'group-a', owner: owner.id, moderator: moderator.id, member: member.id },
      { id: 'group-b', owner: otherOwner.id, moderator: otherModerator.id, member: otherMember.id },
    ]);
    text = experiment.write(owner, 'group-a', 'synthetic learning text');
  });
  afterEach(() => {
    experiment.dispose();
    expect(experiment.countFixtures()).toEqual({ users: 0, groups: 0, members: 0, banned: 0,
      invites: 0, texts: 0, reports: 0, cache: 0 });
    denied(() => experiment.read(owner, 'group-a', text));
    denied(() => experiment.create(owner));
  });

  it.each([
    ['anonymous', null, false, false], ['nonmember', outsider, false, false],
    ['platform role', platform, false, false], ['member', member, true, false],
    ['moderator', moderator, true, true], ['owner', owner, true, true],
    ['other owner', otherOwner, false, false], ['other moderator', otherModerator, false, false],
    ['other member', otherMember, false, false],
  ] as const)('%s read/write/list/search/count/report/moderation matrix', (_name, viewer, allowed, manages) => {
    const operations = [
      () => experiment.read(viewer, 'group-a', text),
      () => experiment.list(viewer, 'group-a'),
      () => experiment.list(viewer, 'group-a', 'learning'),
      () => experiment.count(viewer, 'group-a'),
      () => experiment.metadata(viewer, 'group-a'),
      () => experiment.cached(viewer, 'group-a', text),
      () => experiment.notification(viewer, 'group-a', text),
      () => experiment.storage(viewer, 'group-a', text),
      () => experiment.write(viewer, 'group-a', 'synthetic reply'),
      () => experiment.report(viewer, 'group-a', text, 'synthetic concern'),
    ];
    for (const operation of operations) {
      if (allowed) expect(operation()).toBeDefined(); else denied(operation);
    }
    if (manages) {
      expect(experiment.reports(viewer, 'group-a')).toBeDefined();
      experiment.hide(viewer, 'group-a', text);
    } else {
      denied(() => experiment.reports(viewer, 'group-a'));
      denied(() => experiment.hide(viewer, 'group-a', text));
    }
    if (viewer === owner) expect(experiment.invite(viewer, 'group-a')).toMatch(/^[a-f0-9]{64}$/);
    else denied(() => experiment.invite(viewer, 'group-a'));
  });

  it('does not trust stale client role claims or allow cross-group resource IDs', () => {
    const foreignText = experiment.write(otherOwner, 'group-b', 'foreign synthetic text');
    for (const viewer of [owner, moderator, member, actor('member-a', 'OWNER')]) {
      denied(() => experiment.read(viewer, 'group-a', foreignText));
      denied(() => experiment.read(viewer, 'group-b', foreignText));
      denied(() => experiment.hide(viewer, 'group-a', foreignText));
      denied(() => experiment.report(viewer, 'group-a', foreignText, 'concern'));
      denied(() => experiment.cached(viewer, 'group-a', foreignText));
      denied(() => experiment.notification(viewer, 'group-a', foreignText));
      denied(() => experiment.storage(viewer, 'group-a', foreignText));
    }
    denied(() => experiment.invite(actor('member-a', 'OWNER'), 'group-a'));
  });

  it('rejects unsafe profile/identities and permits authenticated bounded creation only', () => {
    expect(() => new StudyGroupExperiment('production', [], () => clock)).toThrow('SYNTHETIC_TEST_ONLY');
    expect(() => new StudyGroupExperiment('TEST', ['real-user'], () => clock)).toThrow('SYNTHETIC_TEST_ONLY');
    const empty = new StudyGroupExperiment('TEST', [owner.id], () => clock);
    try {
      denied(() => empty.create(null));
      denied(() => empty.create(actor('unknown')));
      const a = empty.create(owner);
      const b = empty.create(owner);
      expect(a).not.toBe(b);
      expect(empty.metadata(owner, a).owner).toBe(owner.id);
      denied(() => empty.create(owner));
    } finally { empty.dispose(); }
  });

  it('accepts exactly once into intended group and does not consume on invalid attempts', () => {
    const token = experiment.invite(owner, 'group-a');
    denied(() => experiment.join(null, 'group-a', token));
    denied(() => experiment.join(outsider, 'group-b', token));
    denied(() => experiment.join(outsider, 'missing', token));
    denied(() => experiment.join(member, 'group-a', token));
    experiment.join(outsider, 'group-a', token);
    expect(experiment.read(outsider, 'group-a', text)).toBe('synthetic learning text');
    denied(() => experiment.invite(outsider, 'group-a'));
    denied(() => experiment.join(platform, 'group-a', token));
    expect(experiment.metadata(owner, 'group-a').members).toBe(4);
  });

  it.each(['malformed', 'unknown', 'expired', 'revoked'] as const)('denies %s invitation uniformly', kind => {
    let token = experiment.invite(owner, 'group-a');
    if (kind === 'malformed') token = 'bad';
    if (kind === 'unknown') token = '0'.repeat(64);
    if (kind === 'expired') clock += 86400000;
    if (kind === 'revoked') experiment.revokeInvite(owner, 'group-a', token);
    denied(() => experiment.join(outsider, 'group-a', token));
    expect(experiment.metadata(owner, 'group-a').members).toBe(3);
  });

  it('stores hashes only and owner-only revocation checks group scope', () => {
    const token = experiment.invite(owner, 'group-a');
    // Deliberate white-box storage audit; capability value must never be stored.
    const storage = (experiment as unknown as { groups: Map<string, { invites: Map<string, unknown> }> }).groups;
    const entries = [...storage.get('group-a')!.invites];
    expect(JSON.stringify(entries)).not.toContain(token);
    expect(entries[0][0]).toMatch(/^[a-f0-9]{64}$/);
    for (const viewer of [null, outsider, platform, member, moderator, otherOwner]) {
      denied(() => experiment.revokeInvite(viewer, 'group-a', token));
    }
    denied(() => experiment.revokeInvite(otherOwner, 'group-b', token));
    experiment.join(outsider, 'group-a', token);
  });

  it.each([false, true])('one-use invite concurrent accept has one winner; same actor=%s', duplicate => {
    const token = experiment.invite(owner, 'group-a');
    return Promise.allSettled(Array.from({ length: 16 }, (_, i) => Promise.resolve().then(() =>
      experiment.join(duplicate || i % 2 === 0 ? outsider : platform, 'group-a', token))))
      .then(results => {
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(15);
        expect(experiment.metadata(owner, 'group-a').members).toBe(4);
      });
  });

  it.each([false, true])('invite revoke/accept ordered race is linearizable; revoke first=%s', revokeFirst => {
    const token = experiment.invite(owner, 'group-a');
    const accept = () => experiment.join(outsider, 'group-a', token);
    const revoke = () => experiment.revokeInvite(owner, 'group-a', token);
    return Promise.allSettled((revokeFirst ? [revoke, accept] : [accept, revoke])
      .map(operation => Promise.resolve().then(operation))).then(results => {
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
        expect(experiment.metadata(owner, 'group-a').members).toBe(revokeFirst ? 3 : 4);
      });
  });

  const revokedOperations = (viewer: Actor, textId: string) => [
    () => experiment.read(viewer, 'group-a', textId),
    () => experiment.write(viewer, 'group-a', 'stale reply'),
    () => experiment.list(viewer, 'group-a'), () => experiment.list(viewer, 'group-a', 'learning'),
    () => experiment.count(viewer, 'group-a'), () => experiment.metadata(viewer, 'group-a'),
    () => experiment.cached(viewer, 'group-a', textId),
    () => experiment.notification(viewer, 'group-a', textId),
    () => experiment.storage(viewer, 'group-a', textId),
    () => experiment.report(viewer, 'group-a', textId, 'stale report'),
  ];
  it.each(['leave', 'remove'] as const)('%s immediately revokes stale session across every projection', transition => {
    const stale = actor('member-a', 'OWNER');
    expect(experiment.cached(stale, 'group-a', text)).toBeDefined();
    const outstandingToken = experiment.invite(owner, 'group-a');
    if (transition === 'leave') experiment.leave(member, 'group-a');
    else experiment.remove(moderator, 'group-a', member.id);
    revokedOperations(stale, text).forEach(denied);
    if (transition === 'remove') denied(() => experiment.join(member, 'group-a', outstandingToken));
    else {
      const newToken = experiment.invite(owner, 'group-a');
      experiment.join(member, 'group-a', newToken);
      expect(experiment.read(member, 'group-a', text)).toBeDefined();
    }
  });

  it.each([false, true])('queued access/removal checks ACL at execution; remove first=%s', removeFirst => {
    const access = () => experiment.read(member, 'group-a', text);
    const remove = () => experiment.remove(owner, 'group-a', member.id);
    return Promise.allSettled((removeFirst ? [remove, access] : [access, remove])
      .map(operation => Promise.resolve().then(operation))).then(results => {
        expect(results.map(result => result.status)).toEqual(removeFirst ? ['fulfilled', 'rejected'] : ['fulfilled', 'fulfilled']);
        revokedOperations(member, text).forEach(denied);
      });
  });

  it('enforces moderator removal limits and prevents owner orphaning', () => {
    for (const viewer of [null, outsider, platform, member, otherOwner]) {
      denied(() => experiment.remove(viewer, 'group-a', member.id));
      denied(() => experiment.transfer(viewer, 'group-a', member.id));
    }
    denied(() => experiment.remove(moderator, 'group-a', moderator.id));
    denied(() => experiment.remove(moderator, 'group-a', owner.id));
    denied(() => experiment.remove(owner, 'group-a', owner.id));
    denied(() => experiment.remove(owner, 'group-a', otherMember.id));
    denied(() => experiment.leave(owner, 'group-a'));
    denied(() => experiment.transfer(moderator, 'group-a', moderator.id));
    experiment.remove(owner, 'group-a', moderator.id);
    denied(() => experiment.hide(moderator, 'group-a', text));
    denied(() => experiment.leave(moderator, 'group-a'));
    expect(experiment.metadata(owner, 'group-a').owner).toBe(owner.id);
  });

  it('atomically transfers ownership and revokes old owner powers', () => {
    for (const target of [owner.id, outsider.id, otherOwner.id, 'synthetic:missing']) {
      denied(() => experiment.transfer(owner, 'group-a', target));
    }
    experiment.transfer(owner, 'group-a', member.id);
    expect(experiment.metadata(member, 'group-a').owner).toBe(member.id);
    denied(() => experiment.invite(owner, 'group-a'));
    denied(() => experiment.transfer(owner, 'group-a', moderator.id));
    denied(() => experiment.leave(member, 'group-a'));
    denied(() => experiment.remove(moderator, 'group-a', member.id));
    experiment.leave(owner, 'group-a');
    expect(experiment.metadata(member, 'group-a').members).toBe(2);
  });

  it('concurrent competing transfers produce one owner and a removed target cannot be promoted', async () => {
    const results = await Promise.allSettled([member.id, moderator.id].map(target =>
      Promise.resolve().then(() => experiment.transfer(owner, 'group-a', target))));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(experiment.metadata(member, 'group-a').owner).toBe(member.id);
    denied(() => experiment.invite(moderator, 'group-a'));
    experiment.remove(member, 'group-a', moderator.id);
    denied(() => experiment.transfer(member, 'group-a', moderator.id));
  });

  it('report resolution is scoped, copies cannot mutate state, hiding revokes ordinary projections', () => {
    const reportId = experiment.report(member, 'group-a', text, 'synthetic concern');
    for (const viewer of [null, outsider, platform, member, otherOwner]) {
      denied(() => experiment.resolve(viewer, 'group-a', reportId));
    }
    denied(() => experiment.resolve(otherOwner, 'group-b', reportId));
    experiment.resolve(moderator, 'group-a', reportId);
    const reports = experiment.reports(owner, 'group-a');
    expect(reports[0].resolved).toBe(true);
    reports[0].resolved = false;
    expect(experiment.reports(owner, 'group-a')[0].resolved).toBe(true);
    experiment.cached(member, 'group-a', text);
    experiment.hide(moderator, 'group-a', text);
    for (const operation of [() => experiment.read(member, 'group-a', text),
      () => experiment.cached(member, 'group-a', text), () => experiment.notification(member, 'group-a', text),
      () => experiment.storage(member, 'group-a', text), () => experiment.report(member, 'group-a', text, 'hidden')]) denied(operation);
    expect(experiment.list(member, 'group-a')).toEqual([]);
    expect(experiment.count(member, 'group-a')).toBe(0);
    expect(experiment.read(moderator, 'group-a', text)).toBeDefined();
    experiment.remove(owner, 'group-a', moderator.id);
    denied(() => experiment.reports(moderator, 'group-a'));
    denied(() => experiment.resolve(moderator, 'group-a', reportId));
  });

  it('existing author-private CommunityService stays author-only despite group membership', async () => {
    const identities = new InMemoryIdentityRepository();
    const repository = new InMemoryCommunityRepository();
    const service = new CommunityService(repository, new InMemoryProfileRepository(), identities, new CommunityRateLimiter());
    const author = await identities.createUser({ email: 'synthetic-author@example.invalid', displayName: 'Synthetic author',
      passwordHash: null, status: 'ACTIVE', emailVerifiedAt: new Date() });
    const post = await repository.createPost({ authorUserId: author.id, targetLanguageCode: 'en',
      postType: 'DISCUSSION', content: 'synthetic private journal', cefrLevel: null, topic: null,
      visibility: 'PRIVATE', createdAt: new Date() });
    await expect(service.getPost(post.id, author.id)).resolves.toMatchObject({ visibility: 'PRIVATE' });
    for (const viewer of [null, owner.id, moderator.id, member.id, platform.id, otherOwner.id]) {
      await expect(service.getPost(post.id, viewer)).rejects.toMatchObject({ code: 'COMMUNITY_POST_UNAVAILABLE' });
    }
    await expect(service.getShareLink(post.id)).rejects.toMatchObject({ code: 'COMMUNITY_POST_UNAVAILABLE' });
    await expect(service.listPosts({}, author.id)).resolves.toMatchObject({ items: [] });
  });

  it('uniform unavailable errors reveal no group existence/count/content to outsiders', () => {
    const capture = (operation: () => unknown) => { try { operation(); return 'unexpected success'; }
      catch (error) { return (error as Error).message; } };
    for (const id of ['group-a', 'group-b', 'missing']) {
      expect(capture(() => experiment.metadata(outsider, id))).toBe('RESOURCE_UNAVAILABLE');
      expect(capture(() => experiment.read(outsider, id, text))).toBe('RESOURCE_UNAVAILABLE');
      expect(capture(() => experiment.list(outsider, id, 'learning'))).toBe('RESOURCE_UNAVAILABLE');
      expect(capture(() => experiment.count(outsider, id))).toBe('RESOURCE_UNAVAILABLE');
    }
    for (const value of ['', ' ', 'x'.repeat(2001)]) {
      denied(() => experiment.write(member, 'group-a', value));
      denied(() => experiment.report(member, 'group-a', text, value));
    }
  });

  it('cleanup is idempotent and works in failure/finally path', () => {
    experiment.invite(owner, 'group-a');
    experiment.report(member, 'group-a', text, 'synthetic concern');
    experiment.cached(member, 'group-a', text);
    experiment.remove(owner, 'group-a', member.id);
    expect(experiment.countFixtures()).toMatchObject({ groups: 2, banned: 1, invites: 1, texts: 1, reports: 1, cache: 1 });
    try { throw new Error('synthetic failure'); } catch { /* assert finally path */ }
    finally { experiment.dispose(); }
    experiment.dispose();
  });

  it('caps cache at 20 projections across both groups while retaining existing-key access', () => {
    experiment.cached(member, 'group-a', text);
    for (let i = 0; i < 19; i++) {
      const id = experiment.write(owner, 'group-a', `synthetic ${i}`);
      experiment.cached(member, 'group-a', id);
    }
    const foreignText = experiment.write(otherOwner, 'group-b', 'synthetic capacity text');
    denied(() => experiment.cached(otherMember, 'group-b', foreignText));
    expect(experiment.cached(member, 'group-a', text)).toBe('synthetic learning text');
    expect(experiment.countFixtures().cache).toBe(20);
  });

  it('allows moderator leave but denies nonmember and anonymous leave', () => {
    for (const viewer of [null, outsider, platform, otherMember]) denied(() => experiment.leave(viewer, 'group-a'));
    experiment.leave(moderator, 'group-a');
    denied(() => experiment.hide(moderator, 'group-a', text));
    const token = experiment.invite(owner, 'group-a');
    experiment.join(moderator, 'group-a', token);
    denied(() => experiment.hide(moderator, 'group-a', text)); // Rejoin grants MEMBER only.
    denied(() => experiment.transfer(owner, 'group-b', otherModerator.id));
  });

  it('can promote scoped moderator via ownership transfer and denies old-owner invitation revocation', () => {
    const token = experiment.invite(owner, 'group-a');
    experiment.transfer(owner, 'group-a', moderator.id);
    expect(experiment.metadata(moderator, 'group-a').owner).toBe(moderator.id);
    denied(() => experiment.revokeInvite(owner, 'group-a', token));
    denied(() => experiment.leave(moderator, 'group-a'));
    experiment.revokeInvite(moderator, 'group-a', token);
    denied(() => experiment.join(outsider, 'group-a', token));
  });

  it('denies moderator peer removal in a disposable two-group fixture', () => {
    const peers = new StudyGroupExperiment('TEST', identities.map(a => a.id), () => clock, [
      { id: 'group-a', owner: owner.id, moderator: [moderator.id, otherModerator.id], member: member.id },
      { id: 'group-b', owner: otherOwner.id, moderator: platform.id, member: otherMember.id },
    ]);
    try {
      denied(() => peers.remove(moderator, 'group-a', otherModerator.id));
      denied(() => peers.remove(otherModerator, 'group-a', moderator.id));
      expect(peers.metadata(owner, 'group-a').members).toBe(4);
    } finally {
      peers.dispose();
      expect(Object.values(peers.countFixtures()).every(count => count === 0)).toBe(true);
    }
  });
});
