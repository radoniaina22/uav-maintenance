-- =====================================================================
-- UAV Maintenance - schéma initial
-- Drones VTOL fixed wing Tango 4 (MAL1, MAL2, MAL3) - UNFPA
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fonction utilitaire : updated_at
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Drones
-- ---------------------------------------------------------------------
create table public.drones (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,                 -- MAL1, MAL2, MAL3
  model                text not null default 'Tango 4',
  serial_number        text,
  -- heures de vol déjà effectuées avant la mise en service du logiciel (minutes)
  initial_flight_minutes numeric(10,1) not null default 0 check (initial_flight_minutes >= 0),
  -- intervalle des visites systématiques (heures)
  visit_interval_hours numeric(6,1) not null default 250 check (visit_interval_hours > 0),
  status               text not null default 'operationnel'
                       check (status in ('operationnel','maintenance','immobilise','retire')),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger trg_drones_updated before update on public.drones
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Batteries (Tattu 12S 30000 / 33000 mAh, montées x2 en parallèle)
-- ---------------------------------------------------------------------
create table public.batteries (
  id             uuid primary key default gen_random_uuid(),
  serial_number  text not null unique,
  label          text,                                     -- étiquette interne (ex. B01)
  model          text not null default 'Tattu 12S',
  capacity_mah   integer not null default 30000 check (capacity_mah in (30000, 33000)),
  initial_cycles integer not null default 0 check (initial_cycles >= 0),
  max_cycles     integer not null default 500 check (max_cycles > 0),
  status         text not null default 'en_service'
                 check (status in ('en_service','stock','hors_service')),
  commissioned_on date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_batteries_updated before update on public.batteries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Pilotes
-- ---------------------------------------------------------------------
create table public.pilots (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  license_number text,
  phone          text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_pilots_updated before update on public.pilots
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Formations sanitaires (destinations : CSB)
-- ---------------------------------------------------------------------
create table public.health_facilities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text unique,
  category   text not null default 'CSB2' check (category in ('CSB1','CSB2')),
  district   text,
  commune    text,
  latitude   numeric(9,6),
  longitude  numeric(9,6),
  active     boolean not null default true,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_hf_updated before update on public.health_facilities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Vols
-- ---------------------------------------------------------------------
create table public.flights (
  id               uuid primary key default gen_random_uuid(),
  drone_id         uuid not null references public.drones(id) on delete restrict,
  destination_id   uuid not null references public.health_facilities(id) on delete restrict,
  flight_date      date not null,
  takeoff_time     time not null,
  drop_time        time,
  landing_time     time not null,
  payload_kg       numeric(6,2) check (payload_kg >= 0),
  avg_wind_ms      numeric(5,1) check (avg_wind_ms >= 0),
  consumption_mah  integer check (consumption_mah >= 0),
  battery_1_id     uuid references public.batteries(id) on delete restrict,
  battery_2_id     uuid references public.batteries(id) on delete restrict,
  observation      text,
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint flights_distinct_batteries check (battery_1_id is null or battery_2_id is null or battery_1_id <> battery_2_id)
);
create index flights_drone_idx on public.flights(drone_id, flight_date desc);
create index flights_dest_idx on public.flights(destination_id);
create index flights_bat1_idx on public.flights(battery_1_id);
create index flights_bat2_idx on public.flights(battery_2_id);
create trigger trg_flights_updated before update on public.flights
  for each row execute function public.set_updated_at();

-- Pilotes d'un vol (2 maximum)
create table public.flight_pilots (
  flight_id uuid not null references public.flights(id) on delete cascade,
  pilot_id  uuid not null references public.pilots(id) on delete restrict,
  role      text not null default 'pilote' check (role in ('pilote','copilote')),
  primary key (flight_id, pilot_id)
);
create index flight_pilots_pilot_idx on public.flight_pilots(pilot_id);

create or replace function public.check_max_two_pilots()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.flight_pilots where flight_id = new.flight_id) >= 2 then
    raise exception 'Un vol ne peut avoir que 2 pilotes au maximum';
  end if;
  return new;
end;
$$;
create trigger trg_flight_pilots_max before insert on public.flight_pilots
  for each row execute function public.check_max_two_pilots();

-- ---------------------------------------------------------------------
-- Rapports techniques / incidents (liés à un vol)
-- ---------------------------------------------------------------------
create table public.technical_reports (
  id                uuid primary key default gen_random_uuid(),
  flight_id         uuid not null references public.flights(id) on delete cascade,
  report_type       text not null default 'technique' check (report_type in ('technique','incident')),
  severity          text not null default 'mineur' check (severity in ('mineur','majeur','critique')),
  component         text,                 -- ex. moteur VTOL 1, moteur principal, batterie, structure...
  description       text not null,
  corrective_action text,
  status            text not null default 'ouvert' check (status in ('ouvert','en_cours','clos')),
  resolved_on       date,
  created_by        uuid default auth.uid() references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index technical_reports_flight_idx on public.technical_reports(flight_id);
create index technical_reports_status_idx on public.technical_reports(status);
create trigger trg_tr_updated before update on public.technical_reports
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Visites de maintenance (systématiques 250 h, correctives, autres)
-- ---------------------------------------------------------------------
create table public.maintenance_visits (
  id             uuid primary key default gen_random_uuid(),
  drone_id       uuid not null references public.drones(id) on delete cascade,
  visit_type     text not null default 'systematique' check (visit_type in ('systematique','corrective','autre')),
  visit_date     date not null default current_date,
  hours_at_visit numeric(10,1) not null check (hours_at_visit >= 0),  -- compteur horaire du drone à la visite
  technician     text,
  work_done      text,
  notes          text,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index maintenance_visits_drone_idx on public.maintenance_visits(drone_id, hours_at_visit desc);
create trigger trg_mv_updated before update on public.maintenance_visits
  for each row execute function public.set_updated_at();

-- =====================================================================
-- Vues de calcul (security_invoker => RLS de l'utilisateur appliquée)
-- =====================================================================

-- Vols avec durée calculée (gère le passage de minuit)
create view public.v_flights with (security_invoker = true) as
select
  f.*,
  round((extract(epoch from (f.landing_time - f.takeoff_time))
        + case when f.landing_time < f.takeoff_time then 86400 else 0 end) / 60.0, 1) as duration_min,
  case when f.drop_time is null then null else
    round((extract(epoch from (f.drop_time - f.takeoff_time))
        + case when f.drop_time < f.takeoff_time then 86400 else 0 end) / 60.0, 1) end as time_to_drop_min,
  d.code as drone_code,
  hf.name as destination_name,
  hf.category as destination_category,
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
left join public.batteries b1 on b1.id = f.battery_1_id
left join public.batteries b2 on b2.id = f.battery_2_id;

-- Statistiques drones + suivi visite 250 h
create view public.v_drone_status with (security_invoker = true) as
with flown as (
  select drone_id, count(*) as flight_count, sum(duration_min) as flown_min, max(flight_date) as last_flight_date
  from public.v_flights group by drone_id
),
last_visit as (
  select distinct on (drone_id) drone_id, hours_at_visit, visit_date
  from public.maintenance_visits
  where visit_type = 'systematique'
  order by drone_id, hours_at_visit desc, visit_date desc
),
calc as (
  select
    d.*,
    coalesce(fl.flight_count, 0) as flight_count,
    fl.last_flight_date,
    round((d.initial_flight_minutes + coalesce(fl.flown_min, 0)) / 60.0, 1) as total_hours,
    lv.hours_at_visit as last_visit_hours,
    lv.visit_date as last_visit_date,
    (select count(*) from public.technical_reports tr join public.flights f2 on f2.id = tr.flight_id
      where f2.drone_id = d.id and tr.status <> 'clos') as open_reports
  from public.drones d
  left join flown fl on fl.drone_id = d.id
  left join last_visit lv on lv.drone_id = d.id
)
select
  c.*,
  -- prochaine visite : dernière visite + intervalle, sinon le prochain multiple de l'intervalle
  case when c.last_visit_hours is not null
       then c.last_visit_hours + c.visit_interval_hours
       else (floor(c.total_hours / c.visit_interval_hours) + 1) * c.visit_interval_hours
  end as next_visit_hours,
  round(
    case when c.last_visit_hours is not null
         then c.last_visit_hours + c.visit_interval_hours
         else (floor(c.total_hours / c.visit_interval_hours) + 1) * c.visit_interval_hours
    end - c.total_hours, 1) as hours_to_next_visit
from calc c;

-- Statistiques batteries (cycles)
create view public.v_battery_status with (security_invoker = true) as
with usage as (
  select battery_id, count(*) as flight_cycles, max(flight_date) as last_used_on
  from (
    select battery_1_id as battery_id, flight_date from public.flights where battery_1_id is not null
    union all
    select battery_2_id, flight_date from public.flights where battery_2_id is not null
  ) u group by battery_id
)
select
  b.*,
  coalesce(u.flight_cycles, 0) as flight_cycles,
  b.initial_cycles + coalesce(u.flight_cycles, 0) as total_cycles,
  b.max_cycles - (b.initial_cycles + coalesce(u.flight_cycles, 0)) as remaining_cycles,
  round(100.0 * (b.initial_cycles + coalesce(u.flight_cycles, 0)) / b.max_cycles, 1) as cycle_pct,
  u.last_used_on
from public.batteries b
left join usage u on u.battery_id = b.id;

-- Statistiques pilotes
create view public.v_pilot_stats with (security_invoker = true) as
select
  p.*,
  count(f.id) as flight_count,
  round(coalesce(sum(f.duration_min), 0) / 60.0, 1) as total_hours,
  max(f.flight_date) as last_flight_date
from public.pilots p
left join public.flight_pilots fp on fp.pilot_id = p.id
left join public.v_flights f on f.id = fp.flight_id
group by p.id;

-- Rapports avec contexte du vol
create view public.v_reports with (security_invoker = true) as
select tr.*, f.flight_date, f.drone_id, d.code as drone_code, hf.name as destination_name
from public.technical_reports tr
join public.flights f on f.id = tr.flight_id
join public.drones d on d.id = f.drone_id
join public.health_facilities hf on hf.id = f.destination_id;

-- =====================================================================
-- Sécurité : RLS - accès réservé aux utilisateurs authentifiés
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['drones','batteries','pilots','health_facilities','flights',
                           'flight_pilots','technical_reports','maintenance_visits']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "authenticated_all" on public.%I for all to authenticated using (true) with check (true)', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

revoke all on public.v_flights, public.v_drone_status, public.v_battery_status,
              public.v_pilot_stats, public.v_reports from anon;
grant select on public.v_flights, public.v_drone_status, public.v_battery_status,
              public.v_pilot_stats, public.v_reports to authenticated;

-- =====================================================================
-- Données de référence : les 3 drones
-- =====================================================================
insert into public.drones (code, model) values
  ('MAL1', 'Tango 4'),
  ('MAL2', 'Tango 4'),
  ('MAL3', 'Tango 4')
on conflict (code) do nothing;
