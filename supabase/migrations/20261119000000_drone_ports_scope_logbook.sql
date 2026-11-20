-- =====================================================================
-- Drone ports, profils utilisateurs (admin / pilote), filtrage par drone port,
-- clôture des vols et carnet de vol des pilotes
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilitaire : durée en minutes entre deux heures (gère minuit)
-- ---------------------------------------------------------------------
create or replace function public.flight_minutes(t_start time, t_end time)
returns numeric
language sql
immutable
as $$
  select round((extract(epoch from (t_end - t_start))
               + case when t_end < t_start then 86400 else 0 end) / 60.0, 1)
$$;

-- ---------------------------------------------------------------------
-- Drone ports
-- ---------------------------------------------------------------------
create table public.drone_ports (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  code       text unique,
  region     text,
  district   text,
  latitude   numeric(9,6),
  longitude  numeric(9,6),
  active     boolean not null default true,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_drone_ports_updated before update on public.drone_ports
  for each row execute function public.set_updated_at();

alter table public.drones            add column drone_port_id uuid references public.drone_ports(id) on delete set null;
alter table public.batteries         add column drone_port_id uuid references public.drone_ports(id) on delete set null;
alter table public.health_facilities add column drone_port_id uuid references public.drone_ports(id) on delete set null; -- null = tous les ports
alter table public.pilots
  add column drone_port_id uuid references public.drone_ports(id) on delete set null,
  add column initial_flight_minutes numeric(10,1) not null default 0 check (initial_flight_minutes >= 0);

-- Le vol garde le drone port du drone au moment de la saisie (historique stable si le drone change de port)
alter table public.flights
  add column drone_port_id uuid references public.drone_ports(id) on delete set null,
  add column status        text not null default 'ouvert' check (status in ('ouvert','cloture')),
  add column closed_at     timestamptz,
  add column closed_by     uuid references auth.users(id) on delete set null;

update public.flights f set drone_port_id = d.drone_port_id from public.drones d where d.id = f.drone_id;

create index drones_port_idx    on public.drones(drone_port_id);
create index batteries_port_idx on public.batteries(drone_port_id);
create index pilots_port_idx    on public.pilots(drone_port_id);
create index hf_port_idx        on public.health_facilities(drone_port_id);
create index flights_port_idx   on public.flights(drone_port_id, flight_date desc);
create index flights_status_idx on public.flights(status);

-- ---------------------------------------------------------------------
-- Profils utilisateurs
-- ---------------------------------------------------------------------
create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'pilote' check (role in ('admin','pilote')),
  pilot_id   uuid unique references public.pilots(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- Nouveau compte : le tout premier devient admin, les suivants pilotes
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, role)
  values (new.id, case when exists (select 1 from public.profiles where role = 'admin') then 'pilote' else 'admin' end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Comptes existants : le plus ancien devient admin
insert into public.profiles (user_id, role)
select id, case when row_number() over (order by created_at) = 1 then 'admin' else 'pilote' end
from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- Fonctions de périmètre (security definer : pas de récursion RLS)
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where user_id = auth.uid()), false)
$$;

create or replace function public.my_pilot_id()
returns uuid language sql stable security definer set search_path = public as $$
  select pilot_id from public.profiles where user_id = auth.uid()
$$;

create or replace function public.my_drone_port_id()
returns uuid language sql stable security definer set search_path = public as $$
  select p.drone_port_id
  from public.profiles pr join public.pilots p on p.id = pr.pilot_id
  where pr.user_id = auth.uid()
$$;

revoke all on function public.is_admin(), public.my_pilot_id(), public.my_drone_port_id() from public, anon;
grant execute on function public.is_admin(), public.my_pilot_id(), public.my_drone_port_id() to authenticated;

-- Il doit toujours rester au moins un admin
create or replace function public.profiles_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.role = 'admin' and new.role <> 'admin'
     and not exists (select 1 from public.profiles where role = 'admin' and user_id <> old.user_id) then
    raise exception 'Il doit rester au moins un administrateur';
  end if;
  return new;
end;
$$;
create trigger trg_profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------
-- Carnet de vol
-- ---------------------------------------------------------------------
create table public.logbook_entries (
  id               uuid primary key default gen_random_uuid(),
  pilot_id         uuid not null references public.pilots(id) on delete cascade,
  flight_id        uuid not null references public.flights(id) on delete restrict,
  role             text not null check (role in ('pilote','copilote')),
  entry_date       date not null,
  takeoff_time     time not null,
  landing_time     time not null,
  duration_min     numeric(10,1) not null check (duration_min >= 0),
  drone_code       text,
  drone_port_name  text,
  destination_name text,
  created_at       timestamptz not null default now(),
  unique (pilot_id, flight_id)
);
create index logbook_pilot_idx on public.logbook_entries(pilot_id, entry_date, takeoff_time);

-- ---------------------------------------------------------------------
-- Règles sur les vols : port, verrouillage, clôture / réouverture
-- ---------------------------------------------------------------------
create or replace function public.flights_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'ouvert';
    new.closed_at := null;
    new.closed_by := null;
    select drone_port_id into new.drone_port_id from drones where id = new.drone_id;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'cloture' then
      raise exception 'Vol clôturé : suppression impossible (un administrateur doit d''abord le rouvrir)';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.status = 'cloture' and new.status = 'cloture' then
    raise exception 'Ce vol est clôturé et ne peut plus être modifié';
  end if;

  if old.status = 'cloture' and new.status = 'ouvert' then
    if not is_admin() then
      raise exception 'Seul un administrateur peut rouvrir un vol clôturé';
    end if;
    new.closed_at := null;
    new.closed_by := null;
  end if;

  if new.drone_id is distinct from old.drone_id then
    select drone_port_id into new.drone_port_id from drones where id = new.drone_id;
  else
    new.drone_port_id := old.drone_port_id;
  end if;

  if old.status = 'ouvert' and new.status = 'cloture' then
    if not exists (select 1 from flight_pilots where flight_id = new.id) then
      raise exception 'Impossible de clôturer : aucun pilote associé au vol';
    end if;
    new.closed_at := now();
    new.closed_by := auth.uid();
  end if;

  return new;
end;
$$;
create trigger trg_flights_guard before insert or update or delete on public.flights
  for each row execute function public.flights_guard();

-- Alimentation du carnet de vol à la clôture / retrait à la réouverture
create or replace function public.flights_logbook_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'ouvert' and new.status = 'cloture' then
    insert into logbook_entries (pilot_id, flight_id, role, entry_date, takeoff_time, landing_time,
                                 duration_min, drone_code, drone_port_name, destination_name)
    select fp.pilot_id, new.id, fp.role, new.flight_date, new.takeoff_time, new.landing_time,
           flight_minutes(new.takeoff_time, new.landing_time), d.code, dp.name, hf.name
    from flight_pilots fp
    join drones d on d.id = new.drone_id
    join health_facilities hf on hf.id = new.destination_id
    left join drone_ports dp on dp.id = new.drone_port_id
    where fp.flight_id = new.id;
  elsif old.status = 'cloture' and new.status = 'ouvert' then
    delete from logbook_entries where flight_id = new.id;
  end if;
  return null;
end;
$$;
create trigger trg_flights_logbook after update of status on public.flights
  for each row execute function public.flights_logbook_sync();

-- Pilotes non modifiables sur un vol clôturé
create or replace function public.flight_pilots_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from flights where id = coalesce(new.flight_id, old.flight_id) and status = 'cloture') then
    raise exception 'Vol clôturé : les pilotes ne peuvent plus être modifiés';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger trg_flight_pilots_guard before insert or update or delete on public.flight_pilots
  for each row execute function public.flight_pilots_guard();

-- =====================================================================
-- RLS : périmètre par drone port
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['drones','batteries','pilots','health_facilities','flights',
                           'flight_pilots','technical_reports','maintenance_visits']
  loop
    execute format('drop policy if exists "authenticated_all" on public.%I', t);
  end loop;
end $$;

alter table public.drone_ports     enable row level security;
alter table public.profiles        enable row level security;
alter table public.logbook_entries enable row level security;

-- Référentiels : lecture selon le port, écriture admin
create policy sel on public.drone_ports for select to authenticated
  using ((select public.is_admin()) or id = (select public.my_drone_port_id()));
create policy sel on public.drones for select to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));
create policy sel on public.batteries for select to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));
create policy sel on public.pilots for select to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()) or id = (select public.my_pilot_id()));
create policy sel on public.health_facilities for select to authenticated
  using ((select public.is_admin()) or drone_port_id is null or drone_port_id = (select public.my_drone_port_id()));

do $$
declare t text;
begin
  foreach t in array array['drone_ports','drones','batteries','pilots','health_facilities']
  loop
    execute format('create policy ins on public.%I for insert to authenticated with check ((select public.is_admin()))', t);
    execute format('create policy upd on public.%I for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
    execute format('create policy del on public.%I for delete to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;

-- Vols : lecture / écriture dans son port
create policy scoped on public.flights for all to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()))
  with check ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));

-- Tables filles : visibles si le vol / drone parent l'est (RLS appliquée dans la sous-requête)
create policy scoped on public.flight_pilots for all to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id))
  with check (exists (select 1 from public.flights f where f.id = flight_id));
create policy scoped on public.technical_reports for all to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id))
  with check (exists (select 1 from public.flights f where f.id = flight_id));
create policy scoped on public.maintenance_visits for all to authenticated
  using (exists (select 1 from public.drones d where d.id = drone_id))
  with check (exists (select 1 from public.drones d where d.id = drone_id));

-- Profils : chacun voit le sien, l'admin gère tout
create policy sel on public.profiles for select to authenticated
  using (user_id = auth.uid() or (select public.is_admin()));
create policy upd on public.profiles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Carnet : le pilote voit le sien, l'admin tout. Écriture uniquement par trigger.
create policy sel on public.logbook_entries for select to authenticated
  using ((select public.is_admin()) or pilot_id = (select public.my_pilot_id()));

revoke all on public.drone_ports, public.profiles, public.logbook_entries from anon;
grant select, insert, update, delete on public.drone_ports to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.logbook_entries to authenticated;
revoke insert, delete on public.profiles from authenticated;
revoke insert, update, delete on public.logbook_entries from authenticated;

-- =====================================================================
-- Vues : recalculées sur TOUS les vols (compteurs drones / batteries exacts),
-- puis filtrées explicitement selon le périmètre de l'utilisateur.
-- =====================================================================
drop view if exists public.v_reports;
drop view if exists public.v_pilot_stats;
drop view if exists public.v_battery_status;
drop view if exists public.v_drone_status;
drop view if exists public.v_flights;

create view public.v_flights as
select
  f.*,
  public.flight_minutes(f.takeoff_time, f.landing_time) as duration_min,
  case when f.drop_time is null then null else public.flight_minutes(f.takeoff_time, f.drop_time) end as time_to_drop_min,
  d.code as drone_code,
  dp.name as drone_port_name,
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
left join public.drone_ports dp on dp.id = f.drone_port_id
left join public.batteries b1 on b1.id = f.battery_1_id
left join public.batteries b2 on b2.id = f.battery_2_id
where (select public.is_admin()) or f.drone_port_id = (select public.my_drone_port_id());

create view public.v_drone_status as
with flown as (
  select drone_id, count(*) as flight_count,
         sum(public.flight_minutes(takeoff_time, landing_time)) as flown_min,
         max(flight_date) as last_flight_date
  from public.flights group by drone_id
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
    dp.name as drone_port_name,
    coalesce(fl.flight_count, 0) as flight_count,
    fl.last_flight_date,
    round((d.initial_flight_minutes + coalesce(fl.flown_min, 0)) / 60.0, 1) as total_hours,
    lv.hours_at_visit as last_visit_hours,
    lv.visit_date as last_visit_date,
    (select count(*) from public.technical_reports tr join public.flights f2 on f2.id = tr.flight_id
      where f2.drone_id = d.id and tr.status <> 'clos') as open_reports
  from public.drones d
  left join public.drone_ports dp on dp.id = d.drone_port_id
  left join flown fl on fl.drone_id = d.id
  left join last_visit lv on lv.drone_id = d.id
)
select
  c.*,
  case when c.last_visit_hours is not null
       then c.last_visit_hours + c.visit_interval_hours
       else (floor(c.total_hours / c.visit_interval_hours) + 1) * c.visit_interval_hours
  end as next_visit_hours,
  round(
    case when c.last_visit_hours is not null
         then c.last_visit_hours + c.visit_interval_hours
         else (floor(c.total_hours / c.visit_interval_hours) + 1) * c.visit_interval_hours
    end - c.total_hours, 1) as hours_to_next_visit
from calc c
where (select public.is_admin()) or c.drone_port_id = (select public.my_drone_port_id());

create view public.v_battery_status as
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
  dp.name as drone_port_name,
  coalesce(u.flight_cycles, 0) as flight_cycles,
  b.initial_cycles + coalesce(u.flight_cycles, 0) as total_cycles,
  b.max_cycles - (b.initial_cycles + coalesce(u.flight_cycles, 0)) as remaining_cycles,
  round(100.0 * (b.initial_cycles + coalesce(u.flight_cycles, 0)) / b.max_cycles, 1) as cycle_pct,
  u.last_used_on
from public.batteries b
left join public.drone_ports dp on dp.id = b.drone_port_id
left join usage u on u.battery_id = b.id
where (select public.is_admin()) or b.drone_port_id = (select public.my_drone_port_id());

-- Heures pilotes = heures antérieures + carnet de vol (vols clôturés uniquement)
create view public.v_pilot_stats as
select
  p.*,
  dp.name as drone_port_name,
  count(l.id) as flight_count,
  round((p.initial_flight_minutes + coalesce(sum(l.duration_min), 0)) / 60.0, 1) as total_hours,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'pilote'), 0) / 60.0, 1) as pic_hours,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'copilote'), 0) / 60.0, 1) as copilot_hours,
  max(l.entry_date) as last_flight_date,
  (select count(*) from public.flight_pilots fp join public.flights f on f.id = fp.flight_id
    where fp.pilot_id = p.id and f.status = 'ouvert') as open_flight_count,
  exists (select 1 from public.profiles pr where pr.pilot_id = p.id) as has_account
from public.pilots p
left join public.drone_ports dp on dp.id = p.drone_port_id
left join public.logbook_entries l on l.pilot_id = p.id
where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id()) or p.id = (select public.my_pilot_id())
group by p.id, dp.name;

create view public.v_logbook as
select
  l.*,
  p.full_name as pilot_name,
  round((p.initial_flight_minutes
         + sum(l.duration_min) over (partition by l.pilot_id
                                     order by l.entry_date, l.takeoff_time, l.created_at
                                     rows unbounded preceding)) / 60.0, 2) as cumulative_hours
from public.logbook_entries l
join public.pilots p on p.id = l.pilot_id
where (select public.is_admin()) or l.pilot_id = (select public.my_pilot_id());

create view public.v_reports as
select tr.*, f.flight_date, f.drone_id, f.drone_port_id, f.status as flight_status,
       d.code as drone_code, hf.name as destination_name
from public.technical_reports tr
join public.flights f on f.id = tr.flight_id
join public.drones d on d.id = f.drone_id
join public.health_facilities hf on hf.id = f.destination_id
where (select public.is_admin()) or f.drone_port_id = (select public.my_drone_port_id());

revoke all on public.v_flights, public.v_drone_status, public.v_battery_status,
              public.v_pilot_stats, public.v_logbook, public.v_reports from anon;
grant select on public.v_flights, public.v_drone_status, public.v_battery_status,
              public.v_pilot_stats, public.v_logbook, public.v_reports to authenticated;

-- =====================================================================
-- Administration des comptes
-- =====================================================================
create or replace function public.admin_list_users()
returns table (user_id uuid, email text, role text, pilot_id uuid, pilot_name text,
               last_sign_in_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs';
  end if;
  return query
    select u.id, u.email::text, pr.role, pr.pilot_id, p.full_name, u.last_sign_in_at, u.created_at
    from auth.users u
    left join public.profiles pr on pr.user_id = u.id
    left join public.pilots p on p.id = pr.pilot_id
    order by u.email;
end;
$$;
revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- Clôture d'un vol (l'heure est ajoutée au carnet de chaque pilote par trigger)
create or replace function public.close_flight(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update flights set status = 'cloture' where id = p_id and status = 'ouvert';
  if not found then
    raise exception 'Vol introuvable ou déjà clôturé';
  end if;
end;
$$;

create or replace function public.reopen_flight(p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update flights set status = 'ouvert' where id = p_id and status = 'cloture';
  if not found then
    raise exception 'Vol introuvable ou déjà ouvert';
  end if;
end;
$$;
revoke all on function public.close_flight(uuid), public.reopen_flight(uuid) from public, anon;
grant execute on function public.close_flight(uuid), public.reopen_flight(uuid) to authenticated;
