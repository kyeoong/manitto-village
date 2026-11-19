'use strict';
const { db, check, json, handler, findMe } = require('../lib/manitto');
module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: '허용되지 않는 요청입니다.' });
  const { ev, me } = await findMe(req);
  if (!ev || !me) return json(res, 403, { error: '유효하지 않은 개인 입장 링크입니다.' });
  const r = me.recipient_id
    ? await db().from('manitto_participants').select('name').eq('id', me.recipient_id).maybeSingle().then(check)
    : null;
  json(res, 200, { recipient: r?.name || '오류', mission: me.mission, giftLimit: ev.gift_limit });
});
