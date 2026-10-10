import { randomUUID } from 'node:crypto';
import { MessageStreamService } from './message-stream.service';
import type { MessageStreamLease, MessageStreamRepository } from './postgres-message-stream.repository';

describe('Direct message SSE lifecycle', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });
  function fixture() {
    const lease: MessageStreamLease = { id: randomUUID(), ownerToken: randomUUID(), actor: randomUUID(),
      conversationId: randomUUID(), sessionId: randomUUID() };
    const repository = { acquire: jest.fn().mockResolvedValue(lease), poll: jest.fn().mockResolvedValue('0'),
      release: jest.fn().mockResolvedValue(undefined) } satisfies MessageStreamRepository;
    const authorize = jest.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const service = new MessageStreamService(repository);
    const open = (lastEventId?: string) => service.open(lease.actor, lease.conversationId, lease.sessionId,
      authorize, controller.signal, lastEventId);
    return { lease, repository, authorize, controller, open };
  }

  it('emits only version hints and discovers persisted changes on another instance', async () => {
    const { open, repository, controller } = fixture();
    const events: unknown[] = [];
    const stream = await open('0');
    const subscription = stream.subscribe(event => events.push(event));
    expect(events).toEqual([{ type: 'hint', id: '0', data: { version: '0' }, retry: 1000 }]);
    repository.poll.mockResolvedValue('9007199254740993');
    await jest.advanceTimersByTimeAsync(1000);
    expect(events[1]).toEqual({ type: 'hint', id: '9007199254740993', data: { version: '9007199254740993' } });
    subscription.unsubscribe();
    controller.abort();
    await Promise.resolve();
    expect(repository.release).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(repository.poll).toHaveBeenCalledTimes(2);
  });

  it('never overlaps an in-flight poll or emits after cancellation', async () => {
    const { open, repository, controller } = fixture();
    let finish!: (value: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    const events: unknown[] = [];
    (await open()).subscribe(event => events.push(event));
    repository.poll.mockReturnValue(pending);
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(repository.poll).toHaveBeenCalledTimes(2);
    controller.abort();
    finish('1');
    await jest.advanceTimersByTimeAsync(5000);
    expect(events).toHaveLength(1);
    expect(repository.release).toHaveBeenCalledTimes(1);
    expect(repository.poll).toHaveBeenCalledTimes(2);
  });

  it('reauthenticates after database work immediately before emission and closes on revocation', async () => {
    const { open, repository, authorize } = fixture();
    const events: unknown[] = [];
    let completed = false;
    (await open()).subscribe({ next: event => events.push(event), complete: () => { completed = true; } });
    repository.poll.mockResolvedValue('1');
    authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('synthetic revoked session'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(1);
    expect(completed).toBe(true);
    expect(repository.release).toHaveBeenCalledTimes(1);
  });

  it('sends an empty heartbeat after25 seconds and closes silently on database failure', async () => {
    const { open, repository } = fixture();
    const events: unknown[] = [];
    let completed = false;
    (await open()).subscribe({ next: event => events.push(event), complete: () => { completed = true; } });
    await jest.advanceTimersByTimeAsync(25_000);
    expect(events).toEqual([{ type: 'hint', id: '0', data: { version: '0' }, retry: 1000 }, { type: 'keepalive', data: '' }]);
    repository.poll.mockRejectedValue(new Error('synthetic internal failure must not reach client'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(events).toHaveLength(2);
    expect(completed).toBe(true);
    expect(repository.release).toHaveBeenCalledTimes(1);
  });

  it('releases a lease acquired after setup was cancelled', async () => {
    const { open, repository, controller, lease } = fixture();
    let finish!: (value: MessageStreamLease) => void;
    repository.acquire.mockReturnValue(new Promise<MessageStreamLease>(resolve => { finish = resolve; }));
    const outcome = open().catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    finish(lease);
    expect(await outcome).toMatchObject({ code: 'MESSAGE_STREAM_CANCELLED' });
    expect(repository.release).toHaveBeenCalledTimes(1);
    expect(repository.poll).not.toHaveBeenCalled();
  });

  it('rejects malformed or future Last-Event-ID without retaining a lease', async () => {
    const { open, repository } = fixture();
    await expect(open('01')).rejects.toMatchObject({ code: 'MESSAGE_INVALID_STREAM_CURSOR' });
    expect(repository.acquire).not.toHaveBeenCalled();
    await expect(open('1')).rejects.toMatchObject({ code: 'MESSAGE_INVALID_STREAM_CURSOR' });
    expect(repository.release).toHaveBeenCalledTimes(1);
  });
});
