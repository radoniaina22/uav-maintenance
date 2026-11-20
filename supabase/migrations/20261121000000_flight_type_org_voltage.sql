-- =====================================================================
-- Vols : type (livraison / contrôle), organisation, distance, tensions batterie
-- CSB : distance de vol
-- =====================================================================

drop view if exists public.v_reports;
drop view if exists public.v_flights;
drop view if exists public.v_logbook;

alter table public.health_facilities
  add column distance_km numeric(7,2) check (distance_km >= 0);

alter table public.flights
  add column flight_type        text not null default 'livraison' check (flight_type in ('livraison','controle')),
  add column organization       text not null default 'UNFPA' check (organization in ('UNFPA','MINSAN','AUTRE')),
  add column organization_other text,
  add column distance_km        numeric(7,2) check (distance_km >= 0),
  -- pack 12S : plage physique large (≈ 2,5 à 4,6 V par cellule)
  add column voltage_start_v    numeric(5,2) check (voltage_start_v between 30 and 55),
  add column voltage_end_v      numeric(5,2) check (voltage_end_v between 30 and 55),
  add constraint flights_org_other_required
    check (organization <> 'AUTRE' or nullif(btrim(organization_other), '') is not null),
  add constraint flights_destination_required
    check (flight_type = 'controle' or destination_id is not null);

-- Un vol de contrôle peut ne pas avoir de CSB de destination
alter table public.flights alter column destination_id drop not null;

-- Carnet de vol : on garde le type de vol
alter table public.logbook_entries
  add column flight_type text not null default 'livraison' check (flight_type in ('livraison','controle'));

create or replace function public.flights_logbook_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'ouvert' and new.status = 'cloture' then
    insert into logbook_entries (pilot_id, flight_id, role, entry_date, takeoff_time, landing_time,
                                 duration_min, drone_code, drone_port_name, destination_name, flight_type)
    select fp.pilot_id, new.id, fp.role, new.flight_date, new.takeoff_time, new.landing_time,
           flight_minutes(new.takeoff_time, new.landing_time), d.code, dp.name, hf.name, new.flight_type
    from flight_pilots fp
    join drones d on d.id = new.drone_id
    left join health_facilities hf on hf.id = new.destination_id
    left join drone_ports dp on dp.id = new.drone_port_id
    where fp.flight_id = new.id;
  elsif old.status = 'cloture' and new.status = 'ouvert' then
    delete from logbook_entries where flight_id = new.id;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Enregistrement d'un vol
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
                         flight_type, organization, organization_other, distance_km,
                         payload_kg, avg_wind_ms, wind_direction_deg, consumption_mah,
                         voltage_start_v, voltage_end_v,
                         battery_pack_id, battery_1_id, battery_2_id, observation)
    select r.drone_id, r.destination_id, r.flight_date, r.takeoff_time, r.drop_time, r.landing_time,
           coalesce(r.flight_type, 'livraison'), coalesce(r.organization, 'UNFPA'),
           case when r.organization = 'AUTRE' then r.organization_other end, r.distance_km,
           r.payload_kg, r.avg_wind_ms, r.wind_direction_deg, r.consumption_mah,
           r.voltage_start_v, r.voltage_end_v,
           r.battery_pack_id, r.battery_1_id, r.battery_2_id, r.observation
    from jsonb_populate_record(null::flights, p_data) r
    returning id into v_id;
  else
    update flights f set
      drone_id = r.drone_id, destination_id = r.destination_id, flight_date = r.flight_date,
      takeoff_time = r.takeoff_time, drop_time = r.drop_time, landing_time = r.landing_time,
      flight_type = coalesce(r.flight_type, 'livraison'), organization = coalesce(r.organization, 'UNFPA'),
      organization_other = case when r.organization = 'AUTRE' then r.organization_other end,
      distance_km = r.distance_km,
      payload_kg = r.payload_kg, avg_wind_ms = r.avg_wind_ms, wind_direction_deg = r.wind_direction_deg,
      consumption_mah = r.consumption_mah, voltage_start_v = r.voltage_start_v, voltage_end_v = r.voltage_end_v,
      battery_pack_id = r.battery_pack_id, battery_1_id = r.battery_1_id, battery_2_id = r.battery_2_id,
      observation = r.observation
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
-- Vues (CSB en jointure externe : vols de contrôle sans destination)
-- =====================================================================
create view public.v_flights as
select
  f.*,
  public.flight_minutes(f.takeoff_time, f.landing_time) as duration_min,
  case when f.drop_time is null then null else public.flight_minutes(f.takeoff_time, f.drop_time) end as time_to_drop_min,
  d.code as drone_code,
  dp.name as drone_port_name,
  hf.name as destination_name,
  hf.category as destination_category,
  hf.distance_km as destination_distance_km,
  case when f.organization = 'AUTRE' then f.organization_other else f.organization end as organization_label,
  round(f.voltage_start_v / 12.0, 3) as cell_voltage_start,
  round(f.voltage_end_v / 12.0, 3) as cell_voltage_end,
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
left join public.health_facilities hf on hf.id = f.destination_id
left join public.drone_ports dp on dp.id = f.drone_port_id
left join public.battery_packs fpk on fpk.id = f.battery_pack_id
left join public.batteries b1 on b1.id = f.battery_1_id
left join public.battery_packs p1 on p1.id = b1.pack_id
left join public.batteries b2 on b2.id = f.battery_2_id
left join public.battery_packs p2 on p2.id = b2.pack_id
where (select public.is_admin()) or f.drone_port_id = (select public.my_drone_port_id());

create view public.v_reports as
select tr.*, f.flight_date, f.drone_id, f.drone_port_id, f.status as flight_status, f.flight_type,
       d.code as drone_code, hf.name as destination_name
from public.technical_reports tr
join public.flights f on f.id = tr.flight_id
join public.drones d on d.id = f.drone_id
left join public.health_facilities hf on hf.id = f.destination_id
where (select public.is_admin()) or f.drone_port_id = (select public.my_drone_port_id());

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

revoke all on public.v_flights, public.v_reports, public.v_logbook from anon;
grant select on public.v_flights, public.v_reports, public.v_logbook to authenticated;
