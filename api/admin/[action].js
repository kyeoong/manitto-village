'use strict';
const { MISSIONS, BUCKET, db, check, json, handler, body, cycle, parseRoster, adminOk, origin, missionStatus } = require('../../lib/manitto');
const crypto = require('node:crypto');

async function loadAll(sb) {
  const [ev, people] = await Promise.all([
    sb.from('manitto_event').select('*').eq('id', 1).maybeSingle().then(check),
    sb.from('manitto_participants').select('*').order('seq').then(check)
  ]);
  return { ev, people: people || [] };
}
function publicEvent(ev, people, req) {
  return {
    eventName: ev.event_name, groupMode: ev.group_mode, createdAt: ev.created_at, participantCount: people.length, giftLimit: ev.gift_limit,
    roster: people.map(p => ({ id: p.id, name: p.name, group: p.grp, link: origin(req) + '/index.html?token=' + encodeURIComponent(p.token) }))
  };
}
async function clearEvidence(sb) {
  for (;;) {
    const list = await sb.storage.from(BUCKET).list('', { limit: 1000 });
    if (list.error) throw Object.assign(Error('사진 목록 조회 실패: ' + list.error.message), { status: 500 });
    const names = (list.data || []).map(f => f.name).filter(n => /^[A-Za-z0-9_-]{32}\.(png|jpg|webp)$/.test(n));
    if (!names.length) return;
    const rm = await sb.storage.from(BUCKET).remove(names);
    if (rm.error) throw Object.assign(Error('사진 삭제 실패: ' + rm.error.message), { status: 500 });
  }
}

module.exports = handler(async (req, res) => {
  if (!adminOk(req)) return json(res, 401, { error: '운영자 인증번호가 올바르지 않습니다.' });
  const action = String(req.query.action || '');
  const sb = db();

  if (action === 'event' && req.method === 'GET') {
    const { ev, people } = await loadAll(sb);
    return json(res, 200, { event: ev ? publicEvent(ev, people, req) : null });
  }

  if (action === 'create' && req.method === 'POST') {
    const existing = await sb.from('manitto_event').select('id').eq('id', 1).maybeSingle().then(check);
    if (existing) return json(res, 409, { error: '이미 추첨이 진행되었습니다. 초기화 전까지 재추첨할 수 없습니다.' });
    const b = body(req);
    const participants = parseRoster(b.roster || '');
    const groupMode = b.groupMode === 'separate' ? 'separate' : 'all';
    let pairs = [];
    if (groupMode === 'separate') {
      const groups = new Map();
      for (const p of participants) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
      for (const set of groups.values()) pairs.push(...cycle(set));
    } else pairs = cycle(participants);
    const assigned = new Map(pairs);
    const rows = participants.map((p, i) => ({
      id: p.id, seq: i + 1, name: p.name, grp: p.group, token: p.token,
      recipient_id: assigned.get(p.id), mission: MISSIONS[crypto.randomInt(MISSIONS.length)]
    }));
    // 행사 행을 먼저 넣어 중복 추첨을 막고(기본키 id=1), 실패하면 되돌림
    const evIns = await sb.from('manitto_event')
      .insert({ id: 1, event_name: String(b.eventName || '2026 마니또 월드').slice(0, 80), group_mode: groupMode, gift_limit: 15000 })
      .select('*').single();
    if (evIns.error) return json(res, 409, { error: '이미 추첨이 진행되었습니다. 초기화 전까지 재추첨할 수 없습니다.' });
    const pIns = await sb.from('manitto_participants').insert(rows);
    if (pIns.error) {
      await sb.from('manitto_participants').delete().neq('id', '');
      await sb.from('manitto_event').delete().eq('id', 1);
      throw Object.assign(Error('참가자 저장 실패: ' + pIns.error.message), { status: 500 });
    }
    await sb.from('village_positions').delete().neq('pid', '');
    const { people } = await loadAll(sb);
    return json(res, 200, { event: publicEvent(evIns.data, people, req) });
  }

  if (action === 'delete' && req.method === 'POST') {
    const b = body(req);
    if (b.confirm !== '초기화') throw Error('초기화 확인 문구가 일치하지 않습니다.');
    await clearEvidence(sb);
    check(await sb.from('village_positions').delete().neq('pid', ''));
    check(await sb.from('manitto_participants').delete().neq('id', ''));
    check(await sb.from('manitto_event').delete().eq('id', 1));
    return json(res, 200, { ok: true });
  }

  const { ev, people } = await loadAll(sb);
  if (!ev) return json(res, 404, { error: '먼저 마니또 추첨을 진행해주세요.' });
  const byId = new Map(people.map(p => [p.id, p]));

  if (action === 'matches' && req.method === 'GET')
    return json(res, 200, { matches: people.map(x => ({ name: x.name, group: x.grp, recipient: byId.get(x.recipient_id)?.name || '오류' })) });

  if (action === 'missions' && req.method === 'GET') {
    const submissions = people.map(p => ({ id: p.id, name: p.name, group: p.grp, mission: p.mission, ...missionStatus(p), imageId: p.image_path || null }));
    const count = s => submissions.filter(x => x.status === s).length;
    return json(res, 200, { submissions, stats: { all: submissions.length, pending: count('pending'), approved: count('approved'), rejected: count('rejected'), none: count('not_submitted') } });
  }

  if (action === 'review' && req.method === 'POST') {
    const b = body(req);
    const person = byId.get(String(b.id));
    if (!person || !person.mission_status) throw Error('해당 인증을 찾을 수 없습니다.');
    if (!['approved', 'rejected'].includes(b.status)) throw Error('승인 또는 반려 중 선택해주세요.');
    check(await sb.from('manitto_participants')
      .update({ mission_status: b.status, reviewed_at: new Date().toISOString(), feedback: String(b.feedback || '').slice(0, 250) })
      .eq('id', person.id));
    return json(res, 200, { ok: true });
  }

  if (action === 'evidence' && req.method === 'GET') {
    const id = String(req.query.id || '');
    if (!/^[A-Za-z0-9_-]{32}\.(png|jpg|webp)$/.test(id) || !people.some(x => x.image_path === id))
      return json(res, 404, { error: '인증 사진을 찾지 못했어요.' });
    const dl = await sb.storage.from(BUCKET).download(id);
    if (dl.error || !dl.data) return json(res, 404, { error: '사진이 없습니다.' });
    const buf = Buffer.from(await dl.data.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', id.endsWith('.png') ? 'image/png' : id.endsWith('.jpg') ? 'image/jpeg' : 'image/webp');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(buf);
  }

  return json(res, 404, { error: '없는 기능입니다.' });
});
