'use strict';
// 숨겨진 쪽지: GET = 내가 찾은 쪽지 목록, POST {seq} = 쪽지 발견 기록 + 내용 받기
const { NOTE_COUNT, DEFAULT_NOTES, db, check, json, handler, body, findMe } = require('../lib/manitto');

async function noteText(sb, seqs) {
  const rows = seqs.length ? await sb.from('manitto_notes').select('*').in('seq', seqs).then(check) : [];
  const custom = new Map((rows || []).map(r => [r.seq, r]));
  return seqs.map(seq => {
    const c = custom.get(seq), d = DEFAULT_NOTES[seq - 1] || ['📜 쪽지', '산타마을의 작은 비밀을 찾았어요!'];
    return { seq, title: c ? c.title : d[0], body: c ? c.body : d[1] };
  });
}

module.exports = handler(async (req, res) => {
  const { ev, me } = await findMe(req);
  if (!ev || !me) return json(res, 403, { error: '유효하지 않은 개인 입장 링크입니다.' });
  const sb = db();
  const found = (me.found_notes || []).filter(n => n >= 1 && n <= NOTE_COUNT).sort((a, b) => a - b);

  if (req.method === 'GET') return json(res, 200, { total: NOTE_COUNT, found: await noteText(sb, found) });
  if (req.method !== 'POST') return json(res, 405, { error: '허용되지 않는 요청입니다.' });

  const seq = Number(body(req).seq);
  if (!Number.isInteger(seq) || seq < 1 || seq > NOTE_COUNT) throw Error('없는 쪽지예요.');
  const isNew = !found.includes(seq);
  if (isNew) check(await sb.from('manitto_participants').update({ found_notes: [...found, seq] }).eq('id', me.id));
  const [note] = await noteText(sb, [seq]);
  json(res, 200, { note, isNew, count: found.length + (isNew ? 1 : 0), total: NOTE_COUNT });
});
