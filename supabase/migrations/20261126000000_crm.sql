-- Compte rendu matériel (CRM) : état du drone, des batteries et des pièces
-- tel qu'il était juste après un vol donné (calculé à date, donc réimprimable plus tard).

create or replace function public.crm_flight(p_flight uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f public.flights;
  d public.drones;
  v_start timestamp;
  v_key record;
  v_seq bigint;
  v_before numeric;
  v_this numeric;
  v_visit record;
  v_next numeric;
  v_result jsonb;
begin
  select * into f from public.flights where id = p_flight;
  if not found then raise exception 'Vol introuvable' using errcode = 'P0002'; end if;
  -- même périmètre que la consultation des vols
  if not (public.is_admin() or f.drone_port_id = public.my_drone_port_id()) then
    raise exception 'Vol non accessible depuis votre drone port' using errcode = '42501';
  end if;
  select * into d from public.drones where id = f.drone_id;
  v_start := f.flight_date + f.takeoff_time;

  -- vols du drone jusqu'à celui-ci inclus (ordre : début, création, id)
  select count(*), coalesce(sum(public.flight_minutes(x.takeoff_time, x.landing_time)), 0)
    into v_seq, v_before
  from public.flights x
  where x.drone_id = f.drone_id
    and (x.flight_date + x.takeoff_time, x.created_at, x.id) < (v_start, f.created_at, f.id);
  v_seq := v_seq + 1;
  v_this := public.flight_minutes(f.takeoff_time, f.landing_time);
  v_before := (d.initial_flight_minutes + v_before) / 60.0;

  -- dernière visite systématique effectuée à la date du vol
  select hours_at_visit, visit_date into v_visit
  from public.maintenance_visits
  where drone_id = f.drone_id and visit_type = 'systematique' and visit_date <= f.flight_date
  order by hours_at_visit desc, visit_date desc limit 1;

  v_next := case when v_visit.hours_at_visit is not null then v_visit.hours_at_visit + d.visit_interval_hours
                 else (floor((v_before + v_this / 60.0) / d.visit_interval_hours) + 1) * d.visit_interval_hours end;

  v_result := jsonb_build_object(
    'drone_code', d.code,
    'drone_model', d.model,
    'drone_serial', d.serial_number,
    'flight_seq', v_seq,
    'flight_minutes', v_this,
    'hours_before', round(v_before, 2),
    'hours_after', round(v_before + v_this / 60.0, 2),
    'visit_interval_hours', d.visit_interval_hours,
    'last_visit_hours', v_visit.hours_at_visit,
    'last_visit_date', v_visit.visit_date,
    'next_visit_hours', v_next,
    'hours_to_next_visit', round(v_next - (v_before + v_this / 60.0), 2),
    'batteries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', case when bp.pack_number is not null then bp.pack_number::text || b.position else b.serial_number end,
        'serial', b.serial_number,
        'capacity_mah', b.capacity_mah,
        'cycles_after', b.initial_cycles + (
          select count(*) from public.flights y
          where (y.battery_1_id = b.id or y.battery_2_id = b.id)
            and (y.flight_date + y.takeoff_time, y.created_at, y.id) <= (v_start, f.created_at, f.id)),
        'max_cycles', b.max_cycles,
        'measured_mah', (select t.measured_mah from public.battery_capacity_tests t
                         where t.battery_id = b.id and t.test_date <= f.flight_date
                         order by t.test_date desc, t.created_at desc limit 1)
      ) order by b.position)
      from public.batteries b
      left join public.battery_packs bp on bp.id = b.pack_id
      where b.id in (f.battery_1_id, f.battery_2_id)
    ), '[]'::jsonb),
    'parts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', p.code, 'type_name', t.name, 'slot_label', coalesce(ds.label, i.zone),
        'hours_after', round(p.initial_hours + coalesce(u.flown_min, 0) / 60.0, 2),
        'max_hours', coalesce(p.max_hours, t.default_max_hours)
      ) order by p.code)
      from public.part_installations i
      join public.parts p on p.id = i.part_id
      join public.part_types t on t.code = p.type_code
      left join public.drone_slots ds on ds.model = d.model and ds.code = i.slot
      left join lateral (
        select sum(public.flight_minutes(y.takeoff_time, y.landing_time)) as flown_min
        from public.part_installations j
        join public.flights y on y.drone_id = j.drone_id
         and (y.flight_date + y.takeoff_time) >= j.installed_at
         and (j.removed_at is null or (y.flight_date + y.takeoff_time) < j.removed_at)
         and (y.flight_date + y.takeoff_time, y.created_at, y.id) <= (v_start, f.created_at, f.id)
        where j.part_id = p.id
      ) u on true
      where i.drone_id = f.drone_id
        and i.installed_at <= v_start
        and (i.removed_at is null or i.removed_at > v_start)
    ), '[]'::jsonb)
  );
  return v_result;
end;
$$;

revoke all on function public.crm_flight(uuid) from public, anon;
grant execute on function public.crm_flight(uuid) to authenticated;

comment on function public.crm_flight(uuid) is
  'Compte rendu matériel : potentiel du drone, cycles batteries et heures des pièces montées, calculés juste après le vol.';
