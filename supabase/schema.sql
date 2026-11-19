-- 🎄 마니또 산타마을 — Supabase 스키마
-- Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run

-- 1) 행사 정보 (한 행만 사용)
create table if not exists public.manitto_event (
  id          int primary key default 1 check (id = 1),
  event_name  text not null,
  group_mode  text not null,
  gift_limit  int  not null default 15000,
  created_at  timestamptz not null default now()
);

-- 2) 참가자 + 마니또 배정 + 미션 인증
create table if not exists public.manitto_participants (
  id             text primary key,
  seq            int  not null,
  name           text not null,
  grp            text not null,
  token          text not null unique,
  recipient_id   text,
  mission        text not null,
  mission_status text,            -- null(미제출) / pending / approved / rejected
  note           text,
  image_path     text,
  submitted_at   timestamptz,
  reviewed_at    timestamptz,
  feedback       text
);

-- 3) 마을 위치 (자주 덮어써서 unlogged 로 가볍게)
create unlogged table if not exists public.village_positions (
  pid        text primary key,
  name       text not null,
  x          real not null,
  z          real not null,
  yaw        real not null,
  moving     boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 브라우저(anon 키)에서는 테이블을 직접 못 읽게 막음 (서버의 service 키만 접근)
alter table public.manitto_event        enable row level security;
alter table public.manitto_participants enable row level security;
alter table public.village_positions    enable row level security;

-- 4) 위치 동기화 함수: 개인 토큰이 맞을 때만 내 위치 저장 + 최근 20초 안에 움직인 사람 목록 반환
create or replace function public.village_sync(
  p_token text, p_x real, p_z real, p_yaw real, p_moving boolean
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
     and abs(p_x) <= 17.1 and abs(p_z) <= 17.1 and abs(p_yaw) <= 1000
     and sqrt(p_x * p_x + p_z * p_z) >= 1.1 then
    insert into village_positions (pid, name, x, z, yaw, moving, updated_at)
    values ('p-' || me.id, me.name, p_x, p_z, p_yaw, coalesce(p_moving, false), now())
    on conflict (pid) do update
      set x = excluded.x, z = excluded.z, yaw = excluded.yaw,
          moving = excluded.moving, name = excluded.name, updated_at = now();
  end if;

  select json_build_object(
    'me', 'p-' || me.id,
    'p', coalesce(json_agg(json_build_array(
            pid, name,
            round(x::numeric, 2), round(z::numeric, 2), round(yaw::numeric, 2),
            moving)), '[]'::json)
  ) into result
  from village_positions
  where updated_at > now() - interval '20 seconds';

  return result;
end;
$$;

revoke all on function public.village_sync(text, real, real, real, boolean) from public;
grant execute on function public.village_sync(text, real, real, real, boolean) to anon, authenticated;

-- 5) 인증 사진 저장소 (비공개)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;
