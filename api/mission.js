'use strict';
const crypto = require('node:crypto');
const { db, check, json, handler, body, findMe, missionStatus, parseImage, BUCKET } = require('../lib/manitto');
module.exports = handler(async (req, res) => {
  const { ev, me } = await findMe(req);
  if (!ev || !me) return json(res, 403, { error: '유효하지 않은 개인 입장 링크입니다.' });
  if (req.method === 'GET') return json(res, 200, { mission: me.mission, ...missionStatus(me) });
  if (req.method !== 'POST') return json(res, 405, { error: '허용되지 않는 요청입니다.' });

  if (me.mission_status && me.mission_status !== 'rejected')
    return json(res, 409, { error: '이미 인증을 제출했습니다. 반려된 경우에만 재제출할 수 있어요.' });
  const b = body(req);
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length < 3 || note.length > 500) throw Error('완료 내용은 3~500자로 적어주세요.');
  const img = parseImage(b.imageData || null);
  if (!img) throw Error('미션 인증 사진을 한 장 첨부해주세요.');

  const sb = db();
  const imagePath = crypto.randomBytes(24).toString('base64url') + '.' + img.ext;
  const up = await sb.storage.from(BUCKET).upload(imagePath, img.buffer, { contentType: img.type, upsert: false });
  if (up.error) throw Object.assign(Error('사진 저장 실패: ' + up.error.message), { status: 500 });

  const old = me.image_path;
  const now = new Date().toISOString();
  // 동시에 두 번 눌러도 한 번만 반영되도록 조건부 업데이트
  const updated = await sb.from('manitto_participants')
    .update({ mission_status: 'pending', note, image_path: imagePath, submitted_at: now, reviewed_at: null, feedback: '' })
    .eq('id', me.id)
    .or('mission_status.is.null,mission_status.eq.rejected')
    .select('*').then(check);
  if (!updated || !updated.length) {
    await sb.storage.from(BUCKET).remove([imagePath]);
    return json(res, 409, { error: '이미 인증을 제출했습니다. 반려된 경우에만 재제출할 수 있어요.' });
  }
  if (old) await sb.storage.from(BUCKET).remove([old]);
  json(res, 200, { ...missionStatus(updated[0]) });
});
