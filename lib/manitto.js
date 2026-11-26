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

// 숨겨진 쪽지 기본 내용 (운영자가 /admin 에서 바꾸기 전까지 사용)
const NOTE_COUNT = 12;
const DEFAULT_NOTES = [
  ['🌲 숲속 첫 번째 쪽지', '이 숲의 나무들은 사실 매일 밤 몰래 키를 재고 있대요. 가장 큰 나무가 되면 꼭대기에 별을 달 수 있거든요. 오늘 하루도 조금씩 자란 당신처럼요.'],
  ['🌲 다람쥐의 메모', '도토리를 숨긴 곳을 또 까먹었어요… 혹시 찾으면 반만 드세요. 나머지 반은 내일의 나를 위해!'],
  ['🌲 나무 밑 비밀', '올해 제일 잘한 일 하나만 떠올려 보세요. 작아도 괜찮아요. 그걸 해낸 건 바로 당신이니까요.'],
  ['🌲 숲지기의 TMI', '산타마을 숲에는 나무가 꽤 많아요. 쪽지는 그중 몇 그루에만 숨어 있어요. 다 흔들어 본 당신, 체력 인정!'],
  ['⛄ 눈 속의 편지', '눈은 차갑지만, 눈사람은 늘 웃고 있죠. 힘든 날에도 웃음을 지켜준 동료에게 오늘 고맙다고 말해보는 건 어때요?'],
  ['⛄ 눈밭 TMI', '눈뭉치를 가장 멀리 던지는 비법: 힘보다 각도! …라고 산타가 말했지만 산타는 썰매만 타요.'],
  ['⛄ 꽁꽁 언 메모', '올해 마지막 달, 수고 많았어요. 내년의 당신에게 한 줄 남긴다면 뭐라고 쓸 건가요?'],
  ['⛄ 눈사람의 고백', '사실 저… 당근 코 말고 귤 코가 더 좋아요. 다들 비밀로 해주세요.'],
  ['❄️ 얼음 구멍 속 쪽지', '호수 아래 물고기들은 겨울에도 천천히 헤엄친대요. 서두르지 않아도 괜찮아요. 우리도 각자의 속도로!'],
  ['🏠 굴뚝 쪽지 ①', '산타가 굴뚝으로 들어오는 이유: 현관 비밀번호를 몰라서. (진짜예요)'],
  ['🏠 굴뚝 쪽지 ②', '이 마을에서 가장 따뜻한 곳은 벽난로가 아니라, 서로를 챙기는 마음이 모인 곳이래요.'],
  ['💡 가로등 아래 쪽지', '12개를 다 찾았다면 당신은 진정한 산타마을 탐험가! 마니또에게도 오늘 작은 빛이 되어주세요 ✨']
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

function validBirth(b) { if (!/^\d{4}$/.test(b)) return false; const m = +b.slice(0, 2), d = +b.slice(2); return m >= 1 && m <= 12 && d >= 1 && d <= 31; }
function hashPin(pin) { const salt = crypto.randomBytes(12).toString('hex'); return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); }
function checkPin(pin, stored) {
  const [salt, hash] = String(stored || '').split(':'); if (!salt || !hash) return false;
  const a = crypto.scryptSync(pin, salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseRoster(raw) {
  if (typeof raw !== 'string' || raw.length > 24000) throw Error('명단이 너무 깁니다.');
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (lines.length < 3 || lines.length > 150) throw Error('3~150명을 입력해주세요.');
  const seen = new Set();
  return lines.map((line, i) => {
    const [name, groupRaw, birthRaw = ''] = line.split(/[,\t|]/).map(x => x.trim());
    const group = groupRaw || '본사', birth = birthRaw.replace(/[^0-9]/g, '');
    if (!name || name.length > 40 || group.length > 30) throw Error(`${i + 1}번 참가자 정보가 잘못되었습니다.`);
    if (birthRaw && !validBirth(birth)) throw Error(`${i + 1}번 ${name}님의 생일은 월일 4자리로 적어주세요. (예: 0315)`);
    const key = `${name}::${group}`;
    if (seen.has(key)) throw Error(`중복된 참가자: ${name} (${group})`);
    seen.add(key);
    return { id: String(i + 1), name, group, birth: birth || null, token: newToken() };
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

module.exports = { validBirth, hashPin, checkPin, NOTE_COUNT, DEFAULT_NOTES, MISSIONS, BUCKET, db, check, json, handler, body, cycle, parseRoster, adminOk, origin, missionStatus, parseImage, findMe, newToken };
