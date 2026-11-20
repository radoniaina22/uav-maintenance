-- =====================================================================
-- Rapport technique des pilotes : liste de tous les vols du mois (section en fin de rapport)
-- monthly_tech_report est redéfinie en entier (version précédente : 20261212000000_monthly_reports.sql)
-- =====================================================================

create or replace function public.mr_flights(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'flight_id', f.id, 'flight_date', f.flight_date, 'takeoff_time', f.takeoff_time, 'landing_time', f.landing_time,
      'minutes', flight_minutes(f.takeoff_time, f.landing_time),
      'drone_code', d.code, 'drone_port_name', dp.name, 'destination_name', hf.name,
      'flight_type', f.flight_type, 'qrf', f.qrf, 'qrf_cause', f.qrf_cause,
      'payload_kg', case when f.flight_type = 'livraison' and not f.qrf then f.payload_kg end,
      'distance_km', f.distance_km, 'consumption_mah', f.consumption_mah,
      'pack_number', bp.pack_number, 'status', f.status,
      'pilot_names', (select string_agg(p.full_name, ', ' order by (fp.role = 'copilote'), p.full_name)
                        from flight_pilots fp join pilots p on p.id = fp.pilot_id where fp.flight_id = f.id),
      'reports', (select count(*) from technical_reports tr where tr.flight_id = f.id))
    order by f.flight_date, f.takeoff_time, f.created_at), '[]'::jsonb)
  from flights f
  join drones d on d.id = f.drone_id
  left join drone_ports dp on dp.id = f.drone_port_id
  left join health_facilities hf on hf.id = f.destination_id
  left join battery_packs bp on bp.id = f.battery_pack_id
  where f.flight_date between p_from and p_to
    and (p_port is null or f.drone_port_id = p_port)
$$;

revoke all on function public.mr_flights(date, date, uuid) from public, anon, authenticated;

create or replace function public.monthly_tech_report(p_month date, p_port uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, public.mr_today()))::date;
  v_to   date := (date_trunc('month', coalesce(p_month, public.mr_today())) + interval '1 month - 1 day')::date;
  v_port uuid;
begin
  if public.is_admin() or public.mr_is_service() then
    v_port := p_port;
  else
    v_port := public.my_drone_port_id();
    if v_port is null then
      raise exception 'Votre compte n''est rattaché à aucun drone port' using errcode = '42501';
    end if;
    if p_port is not null and p_port is distinct from v_port then
      raise exception 'Vous ne pouvez consulter que le rapport de votre drone port' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'kind', 'pilotes',
    'period', public.mr_period(v_from, v_to),
    'drone_port', (select jsonb_build_object('id', dp.id, 'name', dp.name) from drone_ports dp where dp.id = v_port),
    'summary', public.mr_flight_summary(v_from, v_to, v_port),
    'previous', public.mr_flight_summary((v_from - interval '1 month')::date, v_from - 1, v_port),
    'open_flights', public.mr_open_flights(v_from, v_to, v_port),
    'fleet', public.mr_fleet(v_from, v_to, v_port),
    'batteries', public.mr_batteries(v_from, v_to, v_port),
    'parts', public.mr_parts(v_from, v_to, v_port),
    'reports', public.mr_reports(v_from, v_to, v_port),
    'work_orders', public.mr_work_orders(v_from, v_to, v_port),
    'crm', public.mr_crm(v_from, v_to, v_port),
    'qrf', public.mr_qrf(v_from, v_to, v_port),
    'pilots', public.mr_pilots(v_from, v_to, v_port),
    'flights', public.mr_flights(v_from, v_to, v_port));
end;
$$;
