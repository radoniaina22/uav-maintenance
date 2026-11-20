-- =====================================================================
-- Packs de batteries (1A / 1B…), transferts entre drone ports,
-- relevés de capacité réelle, direction moyenne du vent
-- =====================================================================

-- Les vues dépendant des colonnes modifiées sont recréées plus bas
drop view if exists public.v_flights;
drop view if exists public.v_battery_status;

-- ---------------------------------------------------------------------
-- Direction moyenne du vent (degrés, provenance : 0 = Nord, 90 = Est)
-- ---------------------------------------------------------------------
alter table public.flights
  add column wind_direction_deg smallint check (wind_direction_deg between 0 and 359);

-- ---------------------------------------------------------------------
-- Packs
-- ---------------------------------------------------------------------
create table public.battery_packs (
  id            uuid primary key default gen_random_uuid(),
  pack_number   integer not null unique check (pack_number > 0),
  drone_port_id uuid references public.drone_ports(id) on delete set null,
  status        text not null default 'en_service' check (status in ('en_service','stock','hors_service')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index battery_packs_port_idx on public.battery_packs(drone_port_id);
create trigger trg_battery_packs_updated before update on public.battery_packs
  for each row execute function public.set_updated_at();

alter table public.batteries
  drop column label,
  add column pack_id  uuid references public.battery_packs(id) on delete restrict,
  add column position text check (position in ('A','B')),
  add constraint batteries_pack_position check ((pack_id is null) = (position is null)),
  add constraint batteries_pack_slot unique (pack_id, position);
create index batteries_pack_idx on public.batteries(pack_id);

alter table public.flights
  add column battery_pack_id uuid references public.battery_packs(id) on delete set null;

-- Une batterie d'un pack est toujours dans le drone port de son pack
create or replace function public.batteries_sync_port()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.pack_id is not null then
    select drone_port_id into new.drone_port_id from battery_packs where id = new.pack_id;
  end if;
  return new;
end;
$$;
create trigger trg_batteries_sync_port before insert or update of pack_id, drone_port_id on public.batteries
  for each row execute function public.batteries_sync_port();

create or replace function public.packs_cascade_port()
returns trigger language plpgsql set search_path = public as $$
begin
  update batteries set drone_port_id = new.drone_port_id where pack_id = new.id;
  return null;
end;
$$;
create trigger trg_packs_cascade_port after update of drone_port_id on public.battery_packs
  for each row when (old.drone_port_id is distinct from new.drone_port_id)
  execute function public.packs_cascade_port();

-- ---------------------------------------------------------------------
-- Historique des transferts (alimenté automatiquement)
-- ---------------------------------------------------------------------
create table public.battery_transfers (
  id            uuid primary key default gen_random_uuid(),
  battery_id    uuid not null references public.batteries(id) on delete cascade,
  pack_id       uuid references public.battery_packs(id) on delete set null,
  from_port_id  uuid references public.drone_ports(id) on delete set null,
  to_port_id    uuid references public.drone_ports(id) on delete set null,
  transfer_date date not null default current_date,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index battery_transfers_battery_idx on public.battery_transfers(battery_id, transfer_date desc);
create index battery_transfers_pack_idx on public.battery_transfers(pack_id);

create or replace function public.batteries_log_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into battery_transfers (battery_id, pack_id, from_port_id, to_port_id, transfer_date, notes, created_by)
  values (new.id, new.pack_id, old.drone_port_id, new.drone_port_id,
          coalesce(nullif(current_setting('app.transfer_date', true), '')::date, current_date),
          nullif(current_setting('app.transfer_note', true), ''),
          auth.uid());
  return null;
end;
$$;
create trigger trg_batteries_log_transfer after update of drone_port_id on public.batteries
  for each row when (old.drone_port_id is distinct from new.drone_port_id)
  execute function public.batteries_log_transfer();

-- Transfert d'un pack complet
create or replace function public.transfer_pack(p_pack_id uuid, p_to_port_id uuid, p_date date default current_date, p_notes text default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Réservé aux administrateurs';
  end if;
  perform set_config('app.transfer_date', coalesce(p_date, current_date)::text, true);
  perform set_config('app.transfer_note', coalesce(p_notes, ''), true);
  update battery_packs set drone_port_id = p_to_port_id
   where id = p_pack_id and drone_port_id is distinct from p_to_port_id;
  if not found then
    raise exception 'Pack introuvable ou déjà affecté à ce drone port';
  end if;
end;
$$;

-- Transfert d'une batterie isolée (hors pack)
create or replace function public.transfer_battery(p_battery_id uuid, p_to_port_id uuid, p_date date default current_date, p_notes text default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Réservé aux administrateurs';
  end if;
  if exists (select 1 from batteries where id = p_battery_id and pack_id is not null) then
    raise exception 'Cette batterie fait partie d''un pack : transférez le pack complet ou retirez-la du pack';
  end if;
  perform set_config('app.transfer_date', coalesce(p_date, current_date)::text, true);
  perform set_config('app.transfer_note', coalesce(p_notes, ''), true);
  update batteries set drone_port_id = p_to_port_id
   where id = p_battery_id and drone_port_id is distinct from p_to_port_id;
  if not found then
    raise exception 'Batterie introuvable ou déjà affectée à ce drone port';
  end if;
end;
$$;
revoke all on function public.transfer_pack(uuid, uuid, date, text), public.transfer_battery(uuid, uuid, date, text) from public, anon;
grant execute on function public.transfer_pack(uuid, uuid, date, text), public.transfer_battery(uuid, uuid, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- Relevés de capacité réelle (décharge mesurée)
-- ---------------------------------------------------------------------
create table public.battery_capacity_tests (
  id             uuid primary key default gen_random_uuid(),
  battery_id     uuid not null references public.batteries(id) on delete cascade,
  test_date      date not null default current_date,
  measured_mah   integer not null check (measured_mah > 0 and measured_mah <= 40000),
  cycles_at_test integer,
  technician     text,
  notes          text,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index battery_capacity_tests_idx on public.battery_capacity_tests(battery_id, test_date desc, created_at desc);

-- Compteur de cycles au moment du relevé (tous vols confondus, même hors périmètre)
create or replace function public.capacity_test_cycles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cycles_at_test is null then
    select b.initial_cycles
           + (select count(*) from flights f where f.battery_1_id = b.id or f.battery_2_id = b.id)
      into new.cycles_at_test
      from batteries b where b.id = new.battery_id;
  end if;
  return new;
end;
$$;
create trigger trg_capacity_test_cycles before insert on public.battery_capacity_tests
  for each row execute function public.capacity_test_cycles();

-- ---------------------------------------------------------------------
-- Enregistrement d'un vol : ajout du pack et de la direction du vent
-- ---------------------------------------------------------------------
create or replace function public.save_flight(p_id uuid, p_data jsonb, p_pilot_ids uuid[])
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := coalesce(array_length(p_pilot_ids, 1), 0);
begin
  if v_n = 0 then
    raise exception 'Au moins un pilote est requis';
  elsif v_n > 2 then
    raise exception 'Un vol ne peut avoir que 2 pilotes au maximum';
  elsif v_n = 2 and p_pilot_ids[1] = p_pilot_ids[2] then
    raise exception 'Les deux pilotes doivent être différents';
  end if;

  if p_id is null then
    insert into flights (drone_id, destination_id, flight_date, takeoff_time, drop_time, landing_time,
                         payload_kg, avg_wind_ms, wind_direction_deg, consumption_mah,
                         battery_pack_id, battery_1_id, battery_2_id, observation)
    select r.drone_id, r.destination_id, r.flight_date, r.takeoff_time, r.drop_time, r.landing_time,
           r.payload_kg, r.avg_wind_ms, r.wind_direction_deg, r.consumption_mah,
           r.battery_pack_id, r.battery_1_id, r.battery_2_id, r.observation
    from jsonb_populate_record(null::flights, p_data) r
    returning id into v_id;
  else
    update flights f set
      drone_id = r.drone_id, destination_id = r.destination_id, flight_date = r.flight_date,
      takeoff_time = r.takeoff_time, drop_time = r.drop_time, landing_time = r.landing_time,
      payload_kg = r.payload_kg, avg_wind_ms = r.avg_wind_ms, wind_direction_deg = r.wind_direction_deg,
      consumption_mah = r.consumption_mah, battery_pack_id = r.battery_pack_id,
      battery_1_id = r.battery_1_id, battery_2_id = r.battery_2_id, observation = r.observation
    from jsonb_populate_record(null::flights, p_data) r
    where f.id = p_id
    returning f.id into v_id;

    if v_id is null then
      raise exception 'Vol introuvable';
    end if;
    delete from flight_pilots where flight_id = v_id;
  end if;

  insert into flight_pilots (flight_id, pilot_id, role)
  select v_id, t.pid, case when t.ord = 1 then 'pilote' else 'copilote' end
  from unnest(p_pilot_ids) with ordinality as t(pid, ord);

  return v_id;
end;
$$;

-- =====================================================================
-- Vues
-- =====================================================================
create view public.v_battery_status as
with usage as (
  select battery_id, count(*) as flight_cycles, max(flight_date) as last_used_on
  from (
    select battery_1_id as battery_id, flight_date from public.flights where battery_1_id is not null
    union all
    select battery_2_id, flight_date from public.flights where battery_2_id is not null
  ) u group by battery_id
),
last_test as (
  select distinct on (battery_id) battery_id, measured_mah, test_date
  from public.battery_capacity_tests
  order by battery_id, test_date desc, created_at desc
)
select
  b.*,
  bp.pack_number,
  case when bp.pack_number is not null then bp.pack_number::text || b.position end as code,
  bp.status as pack_status,
  dp.name as drone_port_name,
  coalesce(u.flight_cycles, 0) as flight_cycles,
  b.initial_cycles + coalesce(u.flight_cycles, 0) as total_cycles,
  b.max_cycles - (b.initial_cycles + coalesce(u.flight_cycles, 0)) as remaining_cycles,
  round(100.0 * (b.initial_cycles + coalesce(u.flight_cycles, 0)) / b.max_cycles, 1) as cycle_pct,
  u.last_used_on,
  lt.measured_mah as last_measured_mah,
  lt.test_date as last_test_date,
  case when lt.measured_mah is null then null else round(100.0 * lt.measured_mah / b.capacity_mah, 1) end as health_pct,
  (select count(*) from public.battery_capacity_tests t where t.battery_id = b.id) as test_count
from public.batteries b
left join public.battery_packs bp on bp.id = b.pack_id
left join public.drone_ports dp on dp.id = b.drone_port_id
left join usage u on u.battery_id = b.id
left join last_test lt on lt.battery_id = b.id
where (select public.is_admin()) or b.drone_port_id = (select public.my_drone_port_id());

create view public.v_pack_status as
select
  bp.*,
  dp.name as drone_port_name,
  count(bs.id) as battery_count,
  max(bs.total_cycles) as max_total_cycles,
  max(bs.cycle_pct) as max_cycle_pct,
  min(bs.health_pct) as min_health_pct,
  sum(bs.capacity_mah) as nominal_capacity_mah,
  sum(coalesce(bs.last_measured_mah, bs.capacity_mah)) as real_capacity_mah,
  max(bs.last_used_on) as last_used_on
from public.battery_packs bp
left join public.drone_ports dp on dp.id = bp.drone_port_id
left join public.v_battery_status bs on bs.pack_id = bp.id
where (select public.is_admin()) or bp.drone_port_id = (select public.my_drone_port_id())
group by bp.id, dp.name;

create view public.v_flights as
select
  f.*,
  public.flight_minutes(f.takeoff_time, f.landing_time) as duration_min,
  case when f.drop_time is null then null else public.flight_minutes(f.takeoff_time, f.drop_time) end as time_to_drop_min,
  d.code as drone_code,
  dp.name as drone_port_name,
  hf.name as destination_name,
  hf.category as destination_category,
  fpk.pack_number,
  coalesce(p1.pack_number::text || b1.position, b1.serial_number) as battery_1_code,
  coalesce(p2.pack_number::text || b2.position, b2.serial_number) as battery_2_code,
  b1.serial_number as battery_1_serial,
  b2.serial_number as battery_2_serial,
  (coalesce(b1.capacity_mah, 0) + coalesce(b2.capacity_mah, 0)) as pack_capacity_mah,
  (select string_agg(p.full_name, ', ' order by (fp.role = 'copilote'), p.full_name)
     from public.flight_pilots fp join public.pilots p on p.id = fp.pilot_id
    where fp.flight_id = f.id) as pilot_names,
  (select count(*) from public.technical_reports tr where tr.flight_id = f.id) as report_count,
  (select count(*) from public.technical_reports tr where tr.flight_id = f.id and tr.status <> 'clos') as open_report_count
from public.flights f
join public.drones d on d.id = f.drone_id
join public.health_facilities hf on hf.id = f.destination_id
left join public.drone_ports dp on dp.id = f.drone_port_id
left join public.battery_packs fpk on fpk.id = f.battery_pack_id
left join public.batteries b1 on b1.id = f.battery_1_id
left join public.battery_packs p1 on p1.id = b1.pack_id
left join public.batteries b2 on b2.id = f.battery_2_id
left join public.battery_packs p2 on p2.id = b2.pack_id
where (select public.is_admin()) or f.drone_port_id = (select public.my_drone_port_id());

create view public.v_battery_transfers as
select t.*, fp.name as from_port_name, tp.name as to_port_name,
       b.serial_number, bp.pack_number
from public.battery_transfers t
join public.batteries b on b.id = t.battery_id
left join public.battery_packs bp on bp.id = t.pack_id
left join public.drone_ports fp on fp.id = t.from_port_id
left join public.drone_ports tp on tp.id = t.to_port_id
where (select public.is_admin())
   or t.from_port_id = (select public.my_drone_port_id())
   or t.to_port_id = (select public.my_drone_port_id());

-- =====================================================================
-- RLS & droits
-- =====================================================================
alter table public.battery_packs          enable row level security;
alter table public.battery_transfers      enable row level security;
alter table public.battery_capacity_tests enable row level security;

create policy sel on public.battery_packs for select to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));
create policy ins on public.battery_packs for insert to authenticated with check ((select public.is_admin()));
create policy upd on public.battery_packs for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy del on public.battery_packs for delete to authenticated using ((select public.is_admin()));

create policy sel on public.battery_transfers for select to authenticated
  using ((select public.is_admin())
         or from_port_id = (select public.my_drone_port_id())
         or to_port_id = (select public.my_drone_port_id()));

-- Relevés : saisis par les utilisateurs du drone port de la batterie
create policy scoped on public.battery_capacity_tests for all to authenticated
  using (exists (select 1 from public.batteries b where b.id = battery_id))
  with check (exists (select 1 from public.batteries b where b.id = battery_id));

revoke all on public.battery_packs, public.battery_transfers, public.battery_capacity_tests from anon;
grant select, insert, update, delete on public.battery_packs, public.battery_capacity_tests to authenticated;
grant select on public.battery_transfers to authenticated;
revoke insert, update, delete on public.battery_transfers from authenticated;

revoke all on public.v_flights, public.v_battery_status, public.v_pack_status, public.v_battery_transfers from anon;
grant select on public.v_flights, public.v_battery_status, public.v_pack_status, public.v_battery_transfers to authenticated;
