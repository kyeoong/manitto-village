'use strict';
// 우체통: GET = 게시판 + 받은 편지 + 받는 사람 목록, POST = 편지 보내기 / 읽음 처리
const { db, check, json, handler, body, findMe } = require('../lib/manitto');

const fromLabel = (l, names) =>
  l.kind === 'manitto' ? '🎅 당신의 마니또' : l.anonymous ? '익명의 산타' : (names.get(l.sender_id) || '누군가');

module.exports = handler(async (req, res) => {
  const { ev, me } = await findMe(req);
  if (!ev || !me) return json(res, 403, { error: '유효하지 않은 개인 입장 링크입니다.' });
  const sb = db();

  if (req.method === 'GET') {
    const [people, board, inbox] = await Promise.all([
      sb.from('manitto_participants').select('id,name,grp').order('seq').then(check),
      sb.from('manitto_letters').select('*').eq('kind', 'board').eq('hidden', false).order('id', { ascending: false }).limit(80).then(check),
      sb.from('manitto_letters').select('*').eq('recipient_id', me.id).eq('hidden', false).order('id', { ascending: false }).limit(80).then(check)
    ]);
    const names = new Map(people.map(p => [p.id, p.name]));
    const view = l => ({ id: l.id, from: fromLabel(l, names), mine: l.sender_id === me.id, body: l.body, at: l.created_at, read: !!l.read_at, kind: l.kind });
    return json(res, 200, {
      board: board.map(view),
      inbox: inbox.map(view),
      people: people.filter(p => p.id !== me.id).map(p => ({ id: p.id, name: p.name, group: p.grp }))
    });
  }
  if (req.method !== 'POST') return json(res, 405, { error: '허용되지 않는 요청입니다.' });

  const b = body(req);
  if (b.action === 'read') {
    check(await sb.from('manitto_letters').update({ read_at: new Date().toISOString() }).eq('recipient_id', me.id).is('read_at', null));
    return json(res, 200, { ok: true });
  }

  const kind = ['board', 'direct', 'manitto'].includes(b.kind) ? b.kind : null;
  if (!kind) throw Error('편지 종류를 선택해주세요.');
  const text = typeof b.body === 'string' ? b.body.trim() : '';
  if (text.length < 1 || text.length > 500) throw Error('편지는 1~500자로 써주세요.');

  // 도배 방지: 하루 30통
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const cnt = await sb.from('manitto_letters').select('id', { count: 'exact', head: true }).eq('sender_id', me.id).gte('created_at', since);
  if ((cnt.count || 0) >= 30) throw Error('오늘은 편지를 너무 많이 보냈어요. 내일 다시 보내주세요!');

  let recipient = null;
  if (kind === 'manitto') {
    recipient = me.recipient_id;
  } else if (kind === 'direct') {
    recipient = String(b.to || '');
    if (recipient === me.id) throw Error('나에게는 보낼 수 없어요.');
    const exists = await sb.from('manitto_participants').select('id').eq('id', recipient).maybeSingle().then(check);
    if (!exists) throw Error('받는 사람을 선택해주세요.');
  }
  check(await sb.from('manitto_letters').insert({
    sender_id: me.id, kind, recipient_id: recipient,
    anonymous: kind === 'manitto' ? true : b.anonymous !== false, body: text
  }));
  json(res, 200, { ok: true });
});
