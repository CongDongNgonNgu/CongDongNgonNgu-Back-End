import type {
  SpeakingRoomLifecycle,
  SpeakingRoomVisibility,
} from './room.types';

const ROOM_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const ROOM_VISIBILITIES = new Set<SpeakingRoomVisibility>(['PUBLIC', 'PRIVATE']);
const ROOM_LIFECYCLES = new Set<SpeakingRoomLifecycle>(['SCHEDULED', 'LIVE']);

export function normalizeRoomVisibility(value: string | undefined): SpeakingRoomVisibility {
  const normalized = (value ?? 'PUBLIC').trim().toUpperCase() as SpeakingRoomVisibility;
  if (!ROOM_VISIBILITIES.has(normalized)) {
    throw new Error('Room visibility must be PUBLIC or PRIVATE');
  }
  return normalized;
}

export function normalizeRoomLifecycle(value: string | undefined): SpeakingRoomLifecycle {
  const normalized = (value ?? 'LIVE').trim().toUpperCase() as SpeakingRoomLifecycle;
  if (!ROOM_LIFECYCLES.has(normalized)) {
    throw new Error('Room lifecycle must be LIVE or SCHEDULED');
  }
  return normalized;
}

export function normalizeRoomLanguageCode(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,34}$/.test(normalized)) {
    throw new Error('Language code is invalid');
  }
  return normalized;
}

export function normalizeRoomLevel(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const normalized = value.trim().toUpperCase();
  if (!ROOM_LEVELS.has(normalized)) throw new Error('Room level is invalid');
  return normalized;
}

export function normalizeRoomTopic(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Room topic is invalid');
  }
  return normalized;
}

export function normalizeRoomCapacity(value: number | undefined): number {
  const capacity = value ?? 20;
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 100) {
    throw new Error('Room capacity must be between 2 and 100');
  }
  return capacity;
}
