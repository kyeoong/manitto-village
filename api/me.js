'use strict';
const { db, json, handler, findMe, missionStatus } = require('../lib/manitto');
module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: '허용되지 않는 요청입니다.' });
  const { ev, me } = await findMe(req);
  if (!ev || !me) return json(res, 403, { error: '유효하지 않은 개인 입장 링크입니다.' });
  const cnt = await db().from('manitto_participants').select('id', { count: 'exact', head: true });
  json(res, 200, {
    id: me.id, capacity: cnt.count || 70, name: me.name, group: me.grp, mission: me.mission, giftLimit: ev.gift_limit, status: missionStatus(me),
    // 브라우저가 Supabase 위치 동기화 함수(village_sync)만 부를 수 있는 공개용 키
    village: { url: process.env.SUPABASE_URL || '', key: process.env.SUPABASE_ANON_KEY || '' }
  });
});
