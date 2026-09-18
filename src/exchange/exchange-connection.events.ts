import { Injectable } from '@nestjs/common';
import type {
  ExchangeConnectionEvent,
  ExchangeConnectionEventSink,
} from './exchange-connection.types';

export const EXCHANGE_CONNECTION_EVENT_SINK = 'EXCHANGE_CONNECTION_EVENT_SINK';

@Injectable()
export class NoopExchangeConnectionEventSink implements ExchangeConnectionEventSink {
  async publish(_event: ExchangeConnectionEvent): Promise<void> {
    // Phase 12 will attach notification delivery to this seam.
  }
}
