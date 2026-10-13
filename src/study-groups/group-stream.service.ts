import { MessageStreamService } from '../communication/hint-stream.service';
import { PostgresGroupStreamRepository } from './postgres-group-stream.repository';
export class GroupStreamService extends MessageStreamService {
  constructor(repository: PostgresGroupStreamRepository) {
    super(repository);
  }
}
