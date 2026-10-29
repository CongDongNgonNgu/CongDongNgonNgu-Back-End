const {validHealth}=require('./release-checks.cjs');
(async()=>{
 const r=await fetch('https://api.congdongngonngu.vn/api/v1/health',{redirect:'manual',signal:AbortSignal.timeout(10000)});
 if(!validHealth(r.status,await r.json())) throw Error('Health mismatch');
})().catch(()=>{console.error('Production backend verification failed');process.exitCode=1;});
