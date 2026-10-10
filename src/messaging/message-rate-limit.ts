import type { PoolClient } from 'pg';

export async function consumeMessageBudget(client: PoolClient, actor: string,
  bucket: 'SEND_MINUTE' | 'SEND_HOUR' | 'STREAM_MINUTE', limit: number, seconds: number): Promise<number> {
  const row = (await client.query<{ hits: number; retry_seconds: number }>(`
    WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO direct_message_rate_limits(actor_id,bucket,hits,reset_at)
    SELECT $1,$2,1,instant.now+make_interval(secs=>$4) FROM instant WHERE true
    ON CONFLICT(actor_id,bucket) DO UPDATE SET
      hits=CASE WHEN direct_message_rate_limits.reset_at<=(SELECT now FROM instant) THEN 1
        ELSE LEAST(direct_message_rate_limits.hits+1,$3+1) END,
      reset_at=CASE WHEN direct_message_rate_limits.reset_at<=(SELECT now FROM instant)
        THEN (SELECT now FROM instant)+make_interval(secs=>$4) ELSE direct_message_rate_limits.reset_at END
    RETURNING hits,GREATEST(1,CEIL(EXTRACT(EPOCH FROM reset_at-(SELECT now FROM instant))))::int AS retry_seconds`,
  [actor, bucket, limit, seconds])).rows[0];
  return row.hits > limit ? row.retry_seconds : 0;
}
