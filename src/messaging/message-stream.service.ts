import { Observable, type Subscriber } from 'rxjs';
import type { MessageStreamLease, MessageStreamRepository } from './postgres-message-stream.repository';
import { MessageFailure } from './message-failure';
import { parseSequence } from './message-validation';

export type MessageStreamEvent =
  | { type: 'hint'; id: string; data: { version: string }; retry?: number }
  | { type: 'keepalive'; data: '' };

export class MessageStreamService {
  constructor(private readonly repository: MessageStreamRepository) {}

  // Await setup before returning the Observable so Nest can return safe HTTP
  // authorization/429 errors before committing SSE headers. Native @SseSignal
  // also covers a disconnect during that asynchronous setup.
  async open(actor: string, conversationId: string, sessionId: string, reauthorize: () => Promise<void>,
    signal: AbortSignal, lastEventId?: string): Promise<Observable<MessageStreamEvent>> {
    let cursor: bigint | undefined;
    try { if (lastEventId !== undefined) cursor = parseSequence(lastEventId); }
    catch { throw invalidCursor(); }
    let lease: MessageStreamLease | undefined;
    let observer: Subscriber<MessageStreamEvent> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let subscribed = false;
    let release: Promise<void> | undefined;
    const stop = () => {
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      observer?.complete();
      if (lease && !release) {
        // A failed cleanup cannot keep a stream alive. DB lease expiry bounds
        // abandoned metadata; never surface internal errors in a streamed event.
        release = this.repository.release(lease).catch(() => undefined);
      }
    };
    const assertOpen = () => {
      if (closed || signal.aborted) throw new MessageFailure('MESSAGE_STREAM_CANCELLED', 409, 'Message stream was cancelled');
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      assertOpen();
      await reauthorize();
      assertOpen();
      lease = await this.repository.acquire(actor, conversationId, sessionId);
      assertOpen();
      let version = parseSequence(await this.repository.poll(lease));
      if (cursor !== undefined && cursor > version) throw invalidCursor();
      await reauthorize();
      assertOpen();
      let heartbeatAt = Date.now();
      const schedule = () => {
        if (!closed) {
          timer = setTimeout(() => { void tick(); }, 1000);
          timer.unref?.();
        }
      };
      const tick = async () => {
        try {
          await reauthorize();
          if (closed) return;
          const current = parseSequence(await this.repository.poll(lease!));
          if (closed) return;
          // Authentication must be fresh after awaited DB work, immediately
          // before a hint/heartbeat. Pair/version reads were locked by poll().
          await reauthorize();
          if (closed) return;
          if (current < version) throw new Error('Conversation version regressed');
          if (current > version) {
            version = current;
            observer?.next({ type: 'hint', id: version.toString(), data: { version: version.toString() } });
          }
          if (!closed && Date.now() - heartbeatAt >= 25_000) {
            heartbeatAt = Date.now();
            observer?.next({ type: 'keepalive', data: '' });
          }
        } catch { stop(); }
        finally { schedule(); }
      };
      return new Observable<MessageStreamEvent>(subscriber => {
        if (closed || subscribed) { subscriber.complete(); return; }
        subscribed = true;
        observer = subscriber;
        // Initial current-version hint always triggers authoritative REST catch-up.
        observer.next({ type: 'hint', id: version.toString(), data: { version: version.toString() }, retry: 1000 });
        schedule();
        return stop;
      });
    } catch (error) {
      stop();
      await release;
      throw error;
    }
  }
}

function invalidCursor(): MessageFailure {
  return new MessageFailure('MESSAGE_INVALID_STREAM_CURSOR', 400, 'Message stream cursor is invalid');
}
