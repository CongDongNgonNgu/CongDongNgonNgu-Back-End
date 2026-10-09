import { MemoryExchangeActionLimiter } from './exchange-action-limiter';

describe('Exchange authenticated attempt bounds',()=>{
  it('counts rejected requests towards the daily window and releases each expired window',async()=>{
    let now=0;const limiter=new MemoryExchangeActionLimiter(()=>now);
    for(let i=0;i<10;i++) await limiter.consume('actor','REQUEST');
    for(let i=0;i<50;i++) await expect(limiter.consume('actor','REQUEST')).rejects.toMatchObject({code:'EXCHANGE_RATE_LIMITED'});
    now=3_600_000;
    await expect(limiter.consume('actor','REQUEST')).rejects.toMatchObject({code:'EXCHANGE_RATE_LIMITED'});
    now=86_400_000;
    await expect(limiter.consume('actor','REQUEST')).resolves.toBeUndefined();
  });
  it('shares transition allowance and isolates reporters and actor scopes',async()=>{
    const limiter=new MemoryExchangeActionLimiter();
    for(let i=0;i<60;i++) await limiter.consume('actor','TRANSITION');
    await expect(limiter.consume('actor','TRANSITION')).rejects.toMatchObject({code:'EXCHANGE_RATE_LIMITED'});
    for(let i=0;i<10;i++) await limiter.consume('actor','REPORT');
    await expect(limiter.consume('actor','REPORT')).rejects.toMatchObject({code:'EXCHANGE_RATE_LIMITED'});
    await expect(limiter.consume('another','TRANSITION')).resolves.toBeUndefined();
  });
});
