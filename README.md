# 🎄 마니또 산타마을 — 무료 배포판 (Vercel + Supabase)

원래 Render 유료 서버용이던 걸 **Vercel 무료 + Supabase 무료** 구조로 바꾼 버전입니다.
**카드를 등록하지 않으면 요금이 나갈 방법이 없습니다.** 무료 한도를 넘으면 청구되지 않고 서비스가 멈춥니다.

## 무엇이 바뀌었나
| 기능 | 원래 (Render) | 지금 |
|---|---|---|
| 화면 | server.js가 HTML 전달 | Vercel이 `public/` 정적 파일로 전달 |
| 추첨·미션 API | server.js | Vercel 함수 `api/` (주소는 동일) |
| 추첨 결과 저장 | 디스크 `event.json` | Supabase DB |
| 인증 사진 | 디스크 `evidence/` | Supabase Storage (비공개 버킷) |
| 실시간 이동 | WebSocket, 0.12초마다 | Supabase 함수 `village_sync`, **2.5초마다** (부드럽게 보간) |

- 실시간 이동은 무료 한도에 맞추려고 2.5초 간격으로 바꿨습니다. 다른 사람이 약간 늦게, 미끄러지듯 움직여 보입니다.
- 탭을 내려두면 동기화가 멈춰서 사용량을 아낍니다.

## 배포 순서 (약 15분)

### 1. Supabase (DB·사진 저장)
1. https://supabase.com 에서 **New project** (Free 플랜, 지역은 Seoul 추천)
2. 왼쪽 **SQL Editor** → New query → `supabase/schema.sql` 내용 전체 붙여넣기 → **Run**
3. **Project Settings → API Keys / Data API** 에서 아래 3개를 복사해 둡니다
   - Project URL (`https://xxxx.supabase.co`)
   - `anon` 또는 `publishable` 키 (공개용)
   - `service_role` 또는 `secret` 키 (**절대 공유 금지**)

### 2. GitHub
- 이 폴더의 **파일들을** 새 **비공개(Private)** 저장소에 올립니다. (`vercel.json`이 맨 위에 있어야 함)

### 3. Vercel
1. https://vercel.com → **Add New → Project** → 방금 만든 저장소 Import
2. Framework Preset은 **Other** 그대로
3. **Environment Variables**에 4개 입력

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | anon / publishable 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret 키 |
| `MANITTO_ADMIN_KEY` | 운영자 비밀번호 (12자 이상 아무 문자열, 직접 정하기) |

4. **Deploy**

### 4. 확인
- `https://(배포주소)/api/health` → `{"ok":true,"created":false}` 나오면 성공
- `https://(배포주소)/admin` → `MANITTO_ADMIN_KEY` 입력 → 1~70 테스트 명단으로 추첨 → CSV 저장 → 개인 링크 개별 발송

## 무료 한도 (70명 동시 접속 기준 추정)
| 서비스 | 쓰는 곳 | 여유 |
|---|---|---|
| Vercel Hobby | 페이지·추첨·미션 API (가끔만 호출) | 월 함수 호출 100만 회 중 극히 일부 |
| Supabase Free | 위치 동기화 (1명당 2.5초에 1번) | 70명이 동시에 마을에 있어도 데이터 전송 약 120MB/시간 → 월 5GB면 약 40시간 |
| Supabase Storage | 인증 사진 (최대 2MB × 70장) | 1GB 안에 충분 |

## 주의
- **카드 등록하지 마세요.** (Vercel·Supabase 모두 카드 없이 무료 사용 가능)
- 한도를 넘으면 Vercel 계정 전체가 멈출 수 있습니다. 다른 프로젝트가 걱정되면 **마니또용 Vercel 계정을 따로** 만드세요.
- Supabase 무료 프로젝트는 **1주일간 사용이 없으면 일시정지**됩니다. 행사 직전에 대시보드에서 상태를 확인하세요.
- `SUPABASE_SERVICE_ROLE_KEY`와 `MANITTO_ADMIN_KEY`는 단체방 등에 절대 공유하지 마세요. 브라우저에는 anon 키만 전달되며, 이 키로는 테이블을 직접 읽을 수 없고 위치 동기화 함수만 부를 수 있습니다.
- 실명·사진을 받기 전 사내 개인정보·보안 담당자 확인을 권장합니다. 보안 감사를 받은 제품은 아닙니다.
- 행사 후 `/admin`의 초기화로 데이터·사진을 지우거나 Supabase 프로젝트를 삭제하세요.

## 구성 파일
- `public/index.html` — 3D 마을 게임 화면
- `public/admin.html` — 추첨·개별 초대장·미션 검토
- `api/` — Vercel 함수 (me, reveal, mission, health, admin/*)
- `lib/manitto.js` — 공용 로직 (추첨·검증·Supabase 연결)
- `supabase/schema.sql` — DB 테이블·위치 동기화 함수·사진 버킷
- `vercel.json` — 배포 설정 (/admin, /play 주소 연결)
