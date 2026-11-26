-- 🎄 마니또 산타마을 v2 추가분 — 넓은 맵 · 숨겨진 쪽지 · 우체통 · 뿅망치/눈 뿌리기
-- 이미 schema.sql 을 실행한 프로젝트에서: SQL Editor → New query → 이 파일 전체를 붙여넣고 Run
-- (여러 번 실행해도 안전합니다)

-- 1) 쪽지 발견 기록 (참가자별)
alter table public.manitto_participants add column if not exists found_notes int[] not null default '{}';

-- 1-2) 이름·생일·PIN 로그인 (단체방에 공용 주소 하나만 올리는 방식)
alter table public.manitto_participants add column if not exists birth text;
alter table public.manitto_participants add column if not exists pin_hash text;
alter table public.manitto_participants add column if not exists login_fail int not null default 0;
alter table public.manitto_participants add column if not exists locked_until timestamptz;

-- 2) 숨겨진 쪽지 내용 (운영자가 /admin 에서 작성, 초기화해도 유지)
create table if not exists public.manitto_notes (
  seq   int primary key check (seq between 1 and 30),
  title text not null,
  body  text not null
);

-- 3) 우체통 편지
create table if not exists public.manitto_letters (
  id           bigserial primary key,
  sender_id    text not null,
  kind         text not null check (kind in ('board', 'direct', 'manitto')),
  recipient_id text,
  anonymous    boolean not null default true,
  body         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  hidden       boolean not null default false
);
create index if not exists manitto_letters_unread on public.manitto_letters (recipient_id) where read_at is null and not hidden;
create index if not exists manitto_letters_sender on public.manitto_letters (sender_id, created_at);

-- 4) 마을 실시간 이벤트 (뿅망치 · 눈 뿌리기) — 잠깐만 보관
create unlogged table if not exists public.village_events (
  id         bigserial primary key,
  kind       text not null,
  from_pid   text not null,
  from_name  text not null,
  to_pid     text,
  x          real,
  z          real,
  created_at timestamptz not null default now()
);

alter table public.manitto_notes   enable row level security;
alter table public.manitto_letters enable row level security;
alter table public.village_events  enable row level security;

grant select, insert, update, delete on public.manitto_notes, public.manitto_letters, public.village_events to service_role;
grant usage, select on all sequences in schema public to service_role;

-- 5) 위치 동기화 v2: 넓어진 맵(반지름 50) + 이벤트 주고받기 + 안 읽은 편지 수
create or replace function public.village_sync_v2(
  p_token text, p_x real, p_z real, p_yaw real, p_moving boolean,
  p_event text, p_target text, p_since bigint
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  me record;
  result json;
begin
  select id, name into me from manitto_participants where token = p_token;
  if not found then
    raise exception 'invalid token' using errcode = '28000';
  end if;

  if p_x is not null and p_z is not null and p_yaw is not null
     and abs(p_x) <= 50 and abs(p_z) <= 50 and abs(p_yaw) <= 1000
     and sqrt(p_x * p_x + p_z * p_z) >= 1.1 then
    insert into village_positions (pid, name, x, z, yaw, moving, updated_at)
    values ('p-' || me.id, me.name, p_x, p_z, p_yaw, coalesce(p_moving, false), now())
    on conflict (pid) do update
      set x = excluded.x, z = excluded.z, yaw = excluded.yaw,
          moving = excluded.moving, name = excluded.name, updated_at = now();
  end if;

  -- 이벤트: 종류 제한 + 1인당 0.9초에 1번까지
  if p_event in ('snow', 'bonk')
     and not exists (select 1 from village_events
                     where from_pid = 'p-' || me.id and created_at > now() - interval '900 milliseconds') then
    insert into village_events (kind, from_pid, from_name, to_pid, x, z)
    values (p_event, 'p-' || me.id, me.name, left(p_target, 20), p_x, p_z);
  end if;

  if random() < 0.05 then
    delete from village_events where created_at < now() - interval '1 minute';
  end if;

  select json_build_object(
    'me', 'p-' || me.id,
    'p', (select coalesce(json_agg(json_build_array(
            pid, name,
            round(x::numeric, 2), round(z::numeric, 2), round(yaw::numeric, 2),
            moving)), '[]'::json)
          from village_positions
          where updated_at > now() - interval '20 seconds'),
    'e', case when p_since is null or p_since < 0 then '[]'::json else
          (select coalesce(json_agg(json_build_array(id, kind, from_pid, to_pid,
                    round(x::numeric, 1), round(z::numeric, 1), from_name) order by id), '[]'::json)
           from (select * from village_events
                 where id > p_since and created_at > now() - interval '15 seconds'
                 order by id limit 40) ev) end,
    'last', (select coalesce(max(id), 0) from village_events),
    'u', (select count(*) from manitto_letters
          where recipient_id = me.id and read_at is null and not hidden)
  ) into result;

  return result;
end;
$$;

revoke all on function public.village_sync_v2(text, real, real, real, boolean, text, text, bigint) from public;
grant execute on function public.village_sync_v2(text, real, real, real, boolean, text, text, bigint) to anon, authenticated;
