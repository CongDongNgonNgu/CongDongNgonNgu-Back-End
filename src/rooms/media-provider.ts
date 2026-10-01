import { createHash } from 'node:crypto';
import type { SpeakingRoomParticipantRole } from './room.types';

export const SPEAKING_ROOM_MEDIA_PROVIDER = 'SPEAKING_ROOM_MEDIA_PROVIDER';

export type MediaProviderState = 'AVAILABLE' | 'DISABLED' | 'OUTAGE';

export interface MediaSessionRequest {
  idempotencyKey: string;
  roomId: string;
  userId: string;
  role: SpeakingRoomParticipantRole;
  expiresAt: Date;
}

export interface MediaSessionGrant {
  providerId: string;
  providerState: MediaProviderState;
  providerSessionId: string;
  token: string;
  expiresAt: Date;
}

export interface SpeakingRoomMediaProvider {
  readonly providerId: string;
  readonly state: MediaProviderState;
  issueSession(input: MediaSessionRequest): Promise<MediaSessionGrant>;
}

export class MediaProviderUnavailableError extends Error {
  constructor(readonly providerState: MediaProviderState, message = 'Media provider is unavailable') {
    super(message);
    this.name = 'MediaProviderUnavailableError';
  }
}

export class DisabledMediaProvider implements SpeakingRoomMediaProvider {
  readonly providerId = 'disabled';
  readonly state = 'DISABLED' as const;

  async issueSession(): Promise<MediaSessionGrant> {
    throw new MediaProviderUnavailableError(this.state);
  }
}

/** Test-only adapter. Production wiring deliberately uses DisabledMediaProvider. */
export class InMemoryMediaProvider implements SpeakingRoomMediaProvider {
  readonly providerId = 'test-media';
  readonly state = 'AVAILABLE' as const;
  private readonly grants = new Map<string, MediaSessionGrant & { fingerprint: string }>();

  async issueSession(input: MediaSessionRequest): Promise<MediaSessionGrant> {
    // Expiry is server-derived and can move by a few milliseconds on a replay;
    // the logical identity is the room, actor and server-derived role.
    const fingerprint = [input.roomId, input.userId, input.role].join(':');
    const existing = this.grants.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Media idempotency key was reused');
      return cloneGrant(existing);
    }
    const digest = createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32);
    const grant = {
      providerId: this.providerId,
      providerState: this.state,
      providerSessionId: 'test-session-' + digest,
      token: 'test-token-' + digest,
      expiresAt: new Date(input.expiresAt),
      fingerprint,
    };
    this.grants.set(input.idempotencyKey, grant);
    return cloneGrant(grant);
  }
}

function cloneGrant(grant: MediaSessionGrant): MediaSessionGrant {
  return { ...grant, expiresAt: new Date(grant.expiresAt) };
}
