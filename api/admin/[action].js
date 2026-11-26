'use strict';
const { NOTE_COUNT, DEFAULT_NOTES, MISSIONS, BUCKET, db, check, json, handler, body, cycle, parseRoster, adminOk, origin, missionStatus } = require('../../lib/manitto');
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
    entryUrl: origin(req) + '/',
    roster: people.map(p => ({ id: p.id, name: p.name, group: p.grp, birth: p.birth || '', pinSet: !!p.pin_hash, link: origin(req) + '/index.html?token=' + encodeURIComponent(p.token) }))
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
      id: p.id, seq: i + 1, name: p.name, grp: p.group, token: p.token, birth: p.birth,
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

  // 숨겨진 쪽지 내용 (행사와 무관하게 미리 작성 가능, 초기화해도 유지)
  if (action === 'notes' && req.method === 'GET') {
    const [rows, people] = await Promise.all([
      sb.from('manitto_notes').select('*').then(check),
      sb.from('manitto_participants').select('name,found_notes').then(check)
    ]);
    const custom = new Map((rows || []).map(r => [r.seq, r]));
    const notes = Array.from({ length: NOTE_COUNT }, (_, i) => {
      const c = custom.get(i + 1), d = DEFAULT_NOTES[i];
      return { seq: i + 1, title: c ? c.title : d[0], body: c ? c.body : d[1], custom: !!c };
    });
    const ranking = (people || []).map(p => ({ name: p.name, count: (p.found_notes || []).length }))
      .filter(p => p.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);
    return json(res, 200, { notes, ranking });
  }
  if (action === 'notes' && req.method === 'POST') {
    const list = Array.isArray(body(req).notes) ? body(req).notes : [];
    const rows = [];
    for (const n of list) {
      const seq = Number(n.seq), title = String(n.title || '').trim(), text = String(n.body || '').trim();
      if (!Number.isInteger(seq) || seq < 1 || seq > NOTE_COUNT) continue;
      if (!title || title.length > 40) throw Error(seq + '번 쪽지 제목은 1~40자로 써주세요.');
      if (!text || text.length > 600) throw Error(seq + '번 쪽지 내용은 1~600자로 써주세요.');
      rows.push({ seq, title, body: text });
    }
    if (rows.length) check(await sb.from('manitto_notes').upsert(rows, { onConflict: 'seq' }));
    return json(res, 200, { ok: true, saved: rows.length });
  }

  // 우체통 편지 확인 (익명이어도 운영자는 보낸 사람 확인 가능)
  if (action === 'letters' && req.method === 'GET') {
    const [letters, people] = await Promise.all([
      sb.from('manitto_letters').select('*').order('id', { ascending: false }).limit(300).then(check),
      sb.from('manitto_participants').select('id,name').then(check)
    ]);
    const names = new Map((people || []).map(p => [p.id, p.name]));
    return json(res, 200, { letters: (letters || []).map(l => ({
      id: l.id, kind: l.kind, from: names.get(l.sender_id) || '?', to: l.recipient_id ? (names.get(l.recipient_id) || '?') : '게시판',
      anonymous: l.anonymous, body: l.body, at: l.created_at, hidden: l.hidden
    })) });
  }
  if (action === 'letter-hide' && req.method === 'POST') {
    const b = body(req);
    check(await sb.from('manitto_letters').update({ hidden: !!b.hidden }).eq('id', Number(b.id)));
    return json(res, 200, { ok: true });
  }

  if (action === 'delete' && req.method === 'POST') {
    const b = body(req);
    if (b.confirm !== '초기화') throw Error('초기화 확인 문구가 일치하지 않습니다.');
    await clearEvidence(sb);
    check(await sb.from('village_positions').delete().neq('pid', ''));
    check(await sb.from('village_events').delete().gte('id', 0));
    check(await sb.from('manitto_letters').delete().gte('id', 0));
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

  if (action === 'pin-reset' && req.method === 'POST') {
    const person = byId.get(String(body(req).id));
    if (!person) throw Error('해당 참가자를 찾을 수 없습니다.');
    check(await sb.from('manitto_participants').update({ pin_hash: null, login_fail: 0, locked_until: null }).eq('id', person.id));
    return json(res, 200, { ok: true });
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
