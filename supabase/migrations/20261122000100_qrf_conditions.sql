-- =====================================================================
-- QRF : conditions météo ET techniques (qrf_weather -> qrf_conditions)
-- =====================================================================

drop view if exists public.v_flights;

alter table public.flights rename column qrf_weather to qrf_conditions;
alter table public.flights drop constraint flights_qrf_weather_values;
alter table public.flights add constraint flights_qrf_conditions_values check (
  qrf_conditions is null or qrf_conditions <@ array[
    -- météo
    'vent','pluie','orage','visibilite','turbulence',
    -- technique
    'gps','liaison','batterie','moteur','vibrations','capteurs','largage',
    -- autre
    'autre'
  ]::text[]
);
alter table public.flights rename constraint flights_qrf_fields_only_if_qrf to flights_qrf_fields_only_if_qrf_old;
alter table public.flights drop constraint flights_qrf_fields_only_if_qrf_old;
alter table public.flights add constraint flights_qrf_fields_only_if_qrf
  check (qrf or (qrf_cause is null and qrf_conditions is null and qrf_time is null and qrf_details is null));

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
                         battery_pack_id, battery_1_id, battery_2_id, observation,
                         qrf, qrf_cause, qrf_conditions, qrf_time, qrf_details, retry_of_flight_id)
    select r.drone_id, r.destination_id, r.flight_date, r.takeoff_time,
           case when coalesce(r.qrf, false) then null else r.drop_time end, r.landing_time,
           coalesce(r.flight_type, 'livraison'), coalesce(r.organization, 'UNFPA'),
           case when r.organization = 'AUTRE' then r.organization_other end, r.distance_km,
           r.payload_kg, r.avg_wind_ms, r.wind_direction_deg, r.consumption_mah,
           r.voltage_start_v, r.voltage_end_v,
           r.battery_pack_id, r.battery_1_id, r.battery_2_id, r.observation,
           coalesce(r.qrf, false),
           case when r.qrf then r.qrf_cause end,
           case when r.qrf then nullif(r.qrf_conditions, '{}') end,
           case when r.qrf then r.qrf_time end,
           case when r.qrf then r.qrf_details end,
           r.retry_of_flight_id
    from jsonb_populate_record(null::flights, p_data) r
    returning id into v_id;
  else
    update flights f set
      drone_id = r.drone_id, destination_id = r.destination_id, flight_date = r.flight_date,
      takeoff_time = r.takeoff_time,
      drop_time = case when coalesce(r.qrf, false) then null else r.drop_time end,
      landing_time = r.landing_time,
      flight_type = coalesce(r.flight_type, 'livraison'), organization = coalesce(r.organization, 'UNFPA'),
      organization_other = case when r.organization = 'AUTRE' then r.organization_other end,
      distance_km = r.distance_km,
      payload_kg = r.payload_kg, avg_wind_ms = r.avg_wind_ms, wind_direction_deg = r.wind_direction_deg,
      consumption_mah = r.consumption_mah, voltage_start_v = r.voltage_start_v, voltage_end_v = r.voltage_end_v,
      battery_pack_id = r.battery_pack_id, battery_1_id = r.battery_1_id, battery_2_id = r.battery_2_id,
      observation = r.observation,
      qrf = coalesce(r.qrf, false),
      qrf_cause = case when r.qrf then r.qrf_cause end,
      qrf_conditions = case when r.qrf then nullif(r.qrf_conditions, '{}') end,
      qrf_time = case when r.qrf then r.qrf_time end,
      qrf_details = case when r.qrf then r.qrf_details end,
      retry_of_flight_id = r.retry_of_flight_id
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

-- ---------------------------------------------------------------------
-- Vue des vols (recréée pour exposer qrf_conditions)
-- ---------------------------------------------------------------------
create view public.v_flights as
select
  f.*,
  public.flight_minutes(f.takeoff_time, f.landing_time) as duration_min,
  case when f.drop_time is null then null else public.flight_minutes(f.takeoff_time, f.drop_time) end as time_to_drop_min,
  case when f.qrf_time is null then null else public.flight_minutes(f.takeoff_time, f.qrf_time) end as time_to_qrf_min,
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
  (select count(*) from public.technical_reports tr where tr.flight_id = f.id and tr.status <> 'clos') as open_report_count,
  (select count(*) from public.flights rt where rt.retry_of_flight_id = f.id) as retry_count
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

revoke all on public.v_flights from anon;
grant select on public.v_flights to authenticated;
