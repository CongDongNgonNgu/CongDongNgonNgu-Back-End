// Independent process and pool: no process-local mutex can make this proof pass.
require('ts-node/register');
const { Pool } = require('pg');
const { StudyGroupService } = require('../../src/study-groups/study-group.service');
const pool = new Pool({ connectionString: process.env.PHASE22_SCOPED_DATABASE_URL, max: 2 });
const service = new StudyGroupService(pool);
process.send({ ready: true });
process.once('message', async (message) => {
  try {
    const result = await service[message.method](...message.args);
    process.send({ success: true, id: result.id });
  } catch (error) {
    process.send({ success: false, code: error.code ?? error.getResponse?.().code ?? 'FAILED' });
  } finally { await pool.end(); process.disconnect(); }
});
