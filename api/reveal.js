'use strict';
const { db, check, json, handler, findMe } = require('../lib/manitto');
module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: '허용되지 않는 요청입니다.' });
  const { ev, me } = await findMe(req);
  if (!ev || !me) return json(res, 403, { error: '유효하지 않은 개인 입장 링크입니다.' });
  const sb = db();
  const r = me.recipient_id
    ? await sb.from('manitto_participants').select('name').eq('id', me.recipient_id).maybeSingle().then(check)
    : null;
  // 룰렛 연출용 후보 이름 (같은 추첨 그룹, 본인 제외) — 결과는 이미 정해져 있음
  let q = sb.from('manitto_participants').select('name').neq('id', me.id);
  if (ev.group_mode === 'separate') q = q.eq('grp', me.grp);
  const pool = ((await q.then(check)) || []).map(p => p.name).sort(() => Math.random() - 0.5).slice(0, 24);
  json(res, 200, { recipient: r?.name || '오류', mission: me.mission, giftLimit: ev.gift_limit, pool });
});
