'use strict';
// 공용 주소 입장: 이름 + 생일(MMDD) + PIN 4자리. 첫 입장 때 입력한 PIN이 본인 비밀번호가 됩니다.
const { db, check, json, handler, body, validBirth, hashPin, checkPin } = require('../lib/manitto');
const MAX_FAIL = 5, LOCK_MIN = 10;

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: '허용되지 않는 요청입니다.' });
  const b = body(req);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const birth = String(b.birth || '').replace(/[^0-9]/g, '');
  const pin = String(b.pin || '');
  if (!name || name.length > 40) throw Error('이름을 입력해주세요.');
  if (!validBirth(birth)) throw Error('생일은 월일 4자리로 입력해주세요. (예: 0315)');
  if (!/^\d{4}$/.test(pin)) throw Error('PIN은 숫자 4자리로 입력해주세요.');

  const sb = db();
  const ev = await sb.from('manitto_event').select('id').eq('id', 1).maybeSingle().then(check);
  if (!ev) return json(res, 403, { error: '아직 마니또 추첨 전이에요. 운영자 안내를 기다려주세요!' });
  const people = (await sb.from('manitto_participants').select('*').eq('name', name).then(check)) || [];
  if (!people.length) return json(res, 403, { error: '명단에서 이름을 찾지 못했어요. 운영자에게 등록된 이름 그대로 입력해주세요.' });

  const now = Date.now();
  const lockedAll = people.every(p => p.locked_until && new Date(p.locked_until).getTime() > now);
  if (lockedAll) return json(res, 429, { error: `여러 번 틀려서 잠깐 잠겼어요. ${LOCK_MIN}분 뒤 다시 시도하거나 운영자에게 문의하세요.` });

  const me = people.find(p => p.birth === birth && !(p.locked_until && new Date(p.locked_until).getTime() > now));
  const ok = me && (me.pin_hash ? checkPin(pin, me.pin_hash) : true);
  if (!ok) {
    // 실패 횟수 기록 (이름이 같은 사람 모두) → 5번 틀리면 10분 잠금
    for (const p of people) {
      const fail = (p.login_fail || 0) + 1;
      check(await sb.from('manitto_participants').update(fail >= MAX_FAIL
        ? { login_fail: 0, locked_until: new Date(now + LOCK_MIN * 60000).toISOString() }
        : { login_fail: fail }).eq('id', p.id));
    }
    const msg = me && me.pin_hash ? 'PIN이 맞지 않아요. 처음 입장할 때 정한 4자리를 입력해주세요.' : '이름이나 생일이 맞지 않아요.';
    return json(res, 403, { error: msg + ' (5번 틀리면 10분 동안 잠겨요)' });
  }

  const first = !me.pin_hash;
  check(await sb.from('manitto_participants').update(first
    ? { pin_hash: hashPin(pin), login_fail: 0, locked_until: null }
    : { login_fail: 0, locked_until: null }).eq('id', me.id));
  json(res, 200, { token: me.token, name: me.name, first });
});
