'use strict';
const { db, check, json, handler } = require('../lib/manitto');
module.exports = handler(async (req, res) => {
  const ev = await db().from('manitto_event').select('id').eq('id', 1).maybeSingle().then(check);
  json(res, 200, { ok: true, created: !!ev });
});
