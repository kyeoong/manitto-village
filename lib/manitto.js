'use strict';
/** 공용 로직: Supabase 연결, 응답 헬퍼, 검증. (Vercel 함수에서 require) */
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const MISSIONS = [
  '포스트잇에 마니또 초상화 그려주기',
  '마니또에게 익명 응원 메시지 전달하기',
  '마니또에게 어울리는 노래 추천하기',
  '마니또에게 따뜻한 칭찬 메모 남기기',
  '마니또가 좋아하는 간식 취향 알아보기',
  '마니또에게 귀여운 캐릭터 낙서 선물하기',
  '마니또를 위한 연말 응원 카드 쓰기'
];
const MAX_IMAGE = 2 * 1024 * 1024;
const BUCKET = 'evidence';

let client = null;
function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(Error('서버 환경변수(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)가 설정되지 않았습니다.'), { status: 500 });
  if (!client) client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
function check(result) { if (result.error) throw Object.assign(Error('DB 오류: ' + result.error.message), { status: 500 }); return result.data; }

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(data));
}
/** 핸들러 감싸기: 에러를 JSON으로 */
function handler(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) { json(res, e.status || 400, { error: e.message || '요청 처리 중 오류가 발생했습니다.' }); }
  };
}
function body(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch { throw Error('JSON 형식을 확인해주세요.'); } }
  return b && typeof b === 'object' ? b : {};
}

function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; --i) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// 동명이인 판별: "김민지(기획팀)" → "김민지"
function baseName(n) { return String(n).replace(/\s*[\(\[（].*$/, '').replace(/\s+/g, ''); }
function cycle(people) {
  if (people.length < 2) throw Error('분리 추첨은 소속별 최소 2명이어야 합니다.');
  // 본인 제외 + 동명이인끼리는 서로 배정되지 않도록 섞기를 반복
  for (let t = 0; t < 5000; t++) {
    const a = shuffle(people);
    if (a.every((p, i) => baseName(p.name) !== baseName(a[(i + 1) % a.length].name)))
      return a.map((p, i) => [p.id, a[(i + 1) % a.length].id]);
  }
  throw Error('동명이인이 너무 많아 서로 겹치지 않게 배정할 수 없어요. (' + (people[0] && people[0].group) + ')');
}
function parseRoster(raw) {
  if (typeof raw !== 'string' || raw.length > 24000) throw Error('명단이 너무 깁니다.');
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (lines.length < 3 || lines.length > 150) throw Error('3~150명을 입력해주세요.');
  const seen = new Set();
  return lines.map((line, i) => {
    const [name, group = '본사'] = line.split(/[,\t|]/).map(x => x.trim());
    if (!name || !group || name.length > 40 || group.length > 30) throw Error(`${i + 1}번 참가자 정보가 잘못되었습니다.`);
    const key = `${name}::${group}`;
    if (seen.has(key)) throw Error(`중복된 참가자: ${name} (${group})`);
    seen.add(key);
    return { id: String(i + 1), name, group, token: newToken() };
  });
}

function adminOk(req) {
  const ADMIN_KEY = process.env.MANITTO_ADMIN_KEY || '';
  if (ADMIN_KEY.length < 12) throw Object.assign(Error('서버에 MANITTO_ADMIN_KEY(12자 이상)가 설정되지 않았습니다.'), { status: 500 });
  const v = req.headers['x-admin-key'] || '';
  return typeof v === 'string' && v.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(ADMIN_KEY));
}

function origin(req) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (base) return base;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000');
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? 'http' : 'https'}://${host}`;
}

function missionStatus(p) {
  return p.mission_status
    ? { status: p.mission_status, note: p.note, hasImage: !!p.image_path, submittedAt: p.submitted_at, reviewedAt: p.reviewed_at || null, feedback: p.feedback || '' }
    : { status: 'not_submitted' };
}

function parseImage(str) {
  if (!str) return null;
  if (typeof str !== 'string') throw Error('사진 형식을 확인해주세요.');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(str);
  if (!m) throw Error('사진은 JPG, PNG 또는 WebP만 가능합니다.');
  if (m[2].length > MAX_IMAGE * 1.4 + 10) throw Error('사진은 2MB 이하만 업로드할 수 있어요.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE || buf.length === 0) throw Error('사진은 2MB 이하만 업로드할 수 있어요.');
  const isPNG = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJPG = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWEBP = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if ((m[1] === 'png' && !isPNG) || (m[1] === 'jpeg' && !isJPG) || (m[1] === 'webp' && !isWEBP)) throw Error('사진 파일 내용이 잘못되었습니다.');
  return { buffer: buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1], type: 'image/' + m[1] };
}

/** 토큰으로 본인 조회 */
async function findMe(req) {
  const token = String((req.query && req.query.token) || '');
  if (!token || token.length > 100) return { ev: null, me: null };
  const sb = db();
  const [ev, me] = await Promise.all([
    sb.from('manitto_event').select('*').eq('id', 1).maybeSingle().then(check),
    sb.from('manitto_participants').select('*').eq('token', token).maybeSingle().then(check)
  ]);
  return { ev, me };
}

module.exports = { MISSIONS, BUCKET, db, check, json, handler, body, cycle, parseRoster, adminOk, origin, missionStatus, parseImage, findMe, newToken };
