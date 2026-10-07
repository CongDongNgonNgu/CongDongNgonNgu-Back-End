import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type Actor = { id: string; claimedRole?: string } | null;
type Role = 'OWNER' | 'MODERATOR' | 'MEMBER';
type Seed = { id: string; owner: string; moderator: string | readonly string[]; member: string };
type Text = { id: string; content: string; hidden: boolean };
type Invite = { expires: number; used: boolean; revoked: boolean };
type Report = { id: string; textId: string; reason: string; resolved: boolean };
type Group = { members: Map<string, Role>; banned: Set<string>; texts: Map<string, Text>;
  invites: Map<string, Invite>; reports: Map<string, Report> };
function unavailable(): never { throw new Error('RESOURCE_UNAVAILABLE'); }
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** TEST-only policy experiment. No application imports, I/O or persistence.
 * Synchronous ACL+transition is atomic in this process, not across SQL workers. */
export class StudyGroupExperiment {
  private readonly users: Set<string>;
  private readonly groups = new Map<string, Group>();
  private readonly cache = new Map<string, string>();
  private closed = false;

  constructor(profile: string, users: readonly string[], private readonly now: () => number,
    seeds: readonly Seed[] = []) {
    if (profile !== 'TEST' || users.length > 20 || users.some(id => !/^synthetic:[a-z0-9-]+$/.test(id))) {
      throw new Error('SYNTHETIC_TEST_ONLY');
    }
    this.users = new Set(users);
    for (const seed of seeds) {
      const group = this.newGroup({ id: seed.owner }, seed.id);
      const moderators = typeof seed.moderator === 'string' ? [seed.moderator] : seed.moderator;
      if (moderators.some(id => !this.users.has(id)) || !this.users.has(seed.member) ||
        new Set([seed.owner, ...moderators, seed.member]).size !== moderators.length + 2) unavailable();
      for (const id of moderators) group.members.set(id, 'MODERATOR');
      group.members.set(seed.member, 'MEMBER');
    }
  }

  private identity(actor: Actor): string {
    if (this.closed || !actor || !this.users.has(actor.id)) unavailable();
    return actor.id;
  }
  private newGroup(actor: Actor, id: string): Group {
    const user = this.identity(actor);
    if (this.groups.size >= 2 || this.groups.has(id)) unavailable();
    const group: Group = { members: new Map([[user, 'OWNER']]), banned: new Set(),
      texts: new Map(), invites: new Map(), reports: new Map() };
    this.groups.set(id, group);
    return group;
  }
  create(actor: Actor): string {
    const id = randomUUID();
    this.newGroup(actor, id);
    return id;
  }
  private scoped(actor: Actor, id: string, roles: readonly Role[] = ['OWNER', 'MODERATOR', 'MEMBER']): Group {
    const user = this.identity(actor);
    const group = this.groups.get(id);
    if (!group || !roles.includes(group.members.get(user)!)) unavailable();
    return group;
  }
  private visible(actor: Actor, id: string, textId: string): Text {
    const group = this.scoped(actor, id);
    const text = group.texts.get(textId);
    if (!text || (text.hidden && group.members.get(actor!.id) === 'MEMBER')) unavailable();
    return text;
  }
  metadata(actor: Actor, id: string) {
    const group = this.scoped(actor, id);
    return { id, members: group.members.size, owner: [...group.members].find(([, role]) => role === 'OWNER')![0] };
  }
  write(actor: Actor, id: string, content: string): string {
    const group = this.scoped(actor, id);
    if (typeof content !== 'string' || !content.trim() || content.length > 2000 || group.texts.size >= 20) unavailable();
    const textId = randomUUID();
    group.texts.set(textId, { id: textId, content, hidden: false });
    return textId;
  }
  read(actor: Actor, id: string, textId: string): string {
    return this.visible(actor, id, textId).content;
  }
  list(actor: Actor, id: string, query = '') {
    const group = this.scoped(actor, id);
    if (typeof query !== 'string' || query.length > 2000) unavailable();
    return [...group.texts.values()].filter(text =>
      (!text.hidden || group.members.get(actor!.id) !== 'MEMBER') && text.content.includes(query))
      .map(text => ({ id: text.id, content: text.content }));
  }
  count(actor: Actor, id: string): number { return this.list(actor, id).length; }
  cached(actor: Actor, id: string, textId: string): string {
    const text = this.visible(actor, id, textId);
    const key = `${id}/${textId}`;
    if (!this.cache.has(key) && this.cache.size >= 20) unavailable();
    this.cache.set(key, text.content);
    return this.cache.get(key)!;
  }
  notification(actor: Actor, id: string, textId: string) {
    this.visible(actor, id, textId);
    return { groupId: id, textId }; // No body or durable/offline delivery.
  }
  storage(actor: Actor, id: string, textId: string): string { return this.read(actor, id, textId); }

  invite(actor: Actor, id: string): string {
    const group = this.scoped(actor, id, ['OWNER']);
    if (group.invites.size >= 20) unavailable();
    const token = randomBytes(32).toString('hex');
    group.invites.set(digest(token), { expires: this.now() + 86400000, used: false, revoked: false });
    return token;
  }
  revokeInvite(actor: Actor, id: string, token: string): void {
    const group = this.scoped(actor, id, ['OWNER']);
    const invitation = this.lookupInvite(group, token);
    invitation.revoked = true;
  }
  private lookupInvite(group: Group, token: string): Invite {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) unavailable();
    const invite = group.invites.get(digest(token));
    if (!invite || invite.used || invite.revoked || invite.expires <= this.now()) unavailable();
    return invite;
  }
  join(actor: Actor, id: string, token: string): void {
    const user = this.identity(actor);
    const group = this.groups.get(id);
    if (!group || group.members.has(user) || group.banned.has(user) || group.members.size >= 20) unavailable();
    const invite = this.lookupInvite(group, token);
    // No asynchronous gap between current ACL, consume and membership insertion.
    invite.used = true;
    group.members.set(user, 'MEMBER');
  }
  leave(actor: Actor, id: string): void {
    const group = this.scoped(actor, id, ['MODERATOR', 'MEMBER']);
    group.members.delete(actor!.id);
  }
  remove(actor: Actor, id: string, target: string): void {
    const group = this.scoped(actor, id, ['OWNER', 'MODERATOR']);
    const role = group.members.get(target);
    if (!role || role === 'OWNER' || target === actor!.id ||
      (group.members.get(actor!.id) === 'MODERATOR' && role !== 'MEMBER')) unavailable();
    group.members.delete(target);
    group.banned.add(target);
  }
  transfer(actor: Actor, id: string, target: string): void {
    const group = this.scoped(actor, id, ['OWNER']);
    if (!group.members.has(target) || target === actor!.id) unavailable();
    group.members.set(actor!.id, 'MEMBER');
    group.members.set(target, 'OWNER');
  }
  hide(actor: Actor, id: string, textId: string): void {
    const group = this.scoped(actor, id, ['OWNER', 'MODERATOR']);
    const text = group.texts.get(textId);
    if (!text) unavailable();
    text.hidden = true;
    this.cache.delete(`${id}/${textId}`);
  }
  report(actor: Actor, id: string, textId: string, reason: string): string {
    this.visible(actor, id, textId);
    const group = this.scoped(actor, id);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || group.reports.size >= 20) unavailable();
    const reportId = randomUUID();
    group.reports.set(reportId, { id: reportId, textId, reason, resolved: false });
    return reportId;
  }
  reports(actor: Actor, id: string): Report[] {
    return [...this.scoped(actor, id, ['OWNER', 'MODERATOR']).reports.values()].map(report => ({ ...report }));
  }
  resolve(actor: Actor, id: string, reportId: string): void {
    const report = this.scoped(actor, id, ['OWNER', 'MODERATOR']).reports.get(reportId);
    if (!report) unavailable();
    report.resolved = true;
  }
  /** Aggregate cleanup evidence only; never bodies, IDs or token values. */
  countFixtures() {
    const counts = { users: this.users.size, groups: this.groups.size, members: 0, banned: 0,
      invites: 0, texts: 0, reports: 0, cache: this.cache.size };
    for (const group of this.groups.values()) {
      for (const key of ['members', 'banned', 'invites', 'texts', 'reports'] as const) counts[key] += group[key].size;
    }
    return counts;
  }
  dispose(): void {
    for (const group of this.groups.values()) {
      group.members.clear(); group.banned.clear(); group.texts.clear(); group.invites.clear(); group.reports.clear();
    }
    this.users.clear(); this.groups.clear(); this.cache.clear(); this.closed = true;
  }
}
