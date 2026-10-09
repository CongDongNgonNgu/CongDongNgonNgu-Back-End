import type { Pool,PoolClient } from 'pg';
import { ExchangeFailure } from './exchange.errors';

export const EXCHANGE_ACTION_LIMITER = 'EXCHANGE_ACTION_LIMITER';
export type ExchangeLimitedAction = 'REQUEST' | 'TRANSITION' | 'REPORT';
export interface ExchangeActionLimiter { consume(actor: string, action: ExchangeLimitedAction): Promise<void> }
const rules = {
  REQUEST: [{bucket:'REQUEST_HOUR',limit:10,seconds:3600},{bucket:'REQUEST_DAY',limit:60,seconds:86400}],
  TRANSITION: [{bucket:'TRANSITION_HOUR',limit:60,seconds:3600}],
  REPORT: [{bucket:'REPORT_HOUR',limit:10,seconds:3600}],
} as const;
function limited(retryAfterSeconds:number) {
  return new ExchangeFailure('EXCHANGE_RATE_LIMITED',429,'Too many Exchange actions',retryAfterSeconds);
}
export class MemoryExchangeActionLimiter implements ExchangeActionLimiter {
  private readonly counters=new Map<string,{hits:number;resetAt:number}>();
  constructor(private readonly now:()=>number=Date.now) {}
  async consume(actor:string,action:ExchangeLimitedAction):Promise<void> {
    const now=this.now();let retry=0;
    for(const rule of rules[action]) {
      const key=actor+':'+rule.bucket;
      let counter=this.counters.get(key);
      if(!counter || counter.resetAt<=now) counter={hits:0,resetAt:now+rule.seconds*1000};
      counter.hits=Math.min(counter.hits+1,rule.limit+1);this.counters.set(key,counter);
      if(counter.hits>rule.limit) retry=Math.max(retry,Math.ceil((counter.resetAt-now)/1000));
    }
    if(retry) throw limited(retry);
  }
}

export class PostgresExchangeActionLimiter implements ExchangeActionLimiter {
  constructor(private readonly pool:Pool) {}
  async consume(actor:string,action:ExchangeLimitedAction):Promise<void> {
    // Separate bounded statement: expired metadata is disposable and no account locks
    // are held while cleanup skips counters in use by other transactions.
    await this.pool.query(`DELETE FROM exchange_action_rate_limits WHERE ctid IN (
      SELECT ctid FROM exchange_action_rate_limits WHERE reset_at<=clock_timestamp()
      ORDER BY reset_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    const client=await this.pool.connect();let retry=0;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const user=await client.query(`SELECT id FROM users WHERE id=$1 AND status='ACTIVE'
        AND email_verified_at IS NOT NULL FOR UPDATE`,[actor]);
      if(!user.rowCount) throw new ExchangeFailure('EXCHANGE_PROFILE_UNAVAILABLE',404,'Buddy profile was not found');
      for(const rule of rules[action]) {
        retry=Math.max(retry,await consumeExchangeCounter(client,actor,rule.bucket,rule.limit,rule.seconds));
      }
      // Commit every authenticated attempt, including requests denied by either window.
      // Never retain rate locks while acquiring the later pair transaction's locks.
      await client.query('COMMIT');
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>undefined);throw error;
    } finally {client.release();}
    if(retry) throw limited(retry);
  }
}

export async function consumeExchangeCounter(client:PoolClient,actor:string,bucket:string,
  limit:number,seconds:number,targetKey=''):Promise<number> {
  const result=await client.query<{hits:number;retry_seconds:number}>(`
    WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO exchange_action_rate_limits(actor_id,bucket,target_key,hits,reset_at)
    SELECT $1,$2,$3,1,instant.now+make_interval(secs=>$5) FROM instant WHERE true
    ON CONFLICT(actor_id,bucket,target_key) DO UPDATE SET
      hits=CASE WHEN exchange_action_rate_limits.reset_at<=(SELECT now FROM instant) THEN 1
        ELSE LEAST(exchange_action_rate_limits.hits+1,$4+1) END,
      reset_at=CASE WHEN exchange_action_rate_limits.reset_at<=(SELECT now FROM instant)
        THEN (SELECT now FROM instant)+make_interval(secs=>$5) ELSE exchange_action_rate_limits.reset_at END
    RETURNING hits,GREATEST(1,CEIL(EXTRACT(EPOCH FROM reset_at-(SELECT now FROM instant))))::int AS retry_seconds`,
    [actor,bucket,targetKey,limit,seconds]);
  return result.rows[0].hits>limit ? result.rows[0].retry_seconds : 0;
}

export async function consumeNewConnectionPair(client:PoolClient,first:string,second:string):Promise<void> {
  const [a,b]=[first,second].sort();
  const retry=await consumeExchangeCounter(client,a,'PAIR_MINUTE',1,60,b);
  if(retry) throw limited(retry);
}
