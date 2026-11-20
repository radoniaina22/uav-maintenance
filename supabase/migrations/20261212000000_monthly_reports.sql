-- =====================================================================
-- Rapports mensuels (étape 1 : calcul à la demande, consultation dans l'application)
--
--  * monthly_tech_report(mois, drone port)  : rapport technique des pilotes (un par drone port)
--      - pilote : uniquement son drone port ; administrateur : n'importe quel port, ou tous (null)
--  * monthly_admin_report(mois)              : rapport technique consolidé de l'administrateur
--      (tous les drone ports, volet technique par CSB, points d'attention, conformité)
--  * monthly_delivery_report(mois)           : rapport livraisons / efficacité pour l'équipe UNFPA
--      (basé sur le poids livré : payload_kg des livraisons non QRF)
--
-- Les fonctions internes mr_* ne sont pas exposées à l'API (droit d'exécution retiré) :
-- elles ne filtrent pas elles-mêmes le périmètre, ce sont les trois fonctions publiques qui le font.
-- « Livraison » = vol de type livraison non QRF (même règle que drone_ranking / statistiques).
-- Seuils alignés sur src/lib/format.ts (THRESHOLDS) : visite à 25 h, cycles 90 %, capacité 85 / 75 %.
-- Les appels avec la clé service-role (future Edge Function d'envoi) sont acceptés.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilitaires
-- ---------------------------------------------------------------------
create or replace function public.mr_today()
returns date language sql stable as $$
  select (now() at time zone 'Indian/Antananarivo')::date
$$;

create or replace function public.mr_is_service()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
$$;

create or replace function public.mr_period(p_from date, p_to date)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'month', to_char(p_from, 'YYYY-MM'),
    'from', p_from,
    'to', p_to,
    'provisional', p_to >= public.mr_today(),
    'generated_at', now())
$$;

-- ---------------------------------------------------------------------
-- Activité de vol
-- ---------------------------------------------------------------------
create or replace function public.mr_flight_summary(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'flights', count(*),
    'deliveries', count(*) filter (where f.flight_type = 'livraison' and not f.qrf),
    'controls', count(*) filter (where f.flight_type = 'controle' and not f.qrf),
    'qrf', count(*) filter (where f.qrf),
    'minutes', coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)), 0),
    'km', coalesce(sum(f.distance_km), 0),
    'kg', coalesce(sum(f.payload_kg) filter (where f.flight_type = 'livraison' and not f.qrf), 0),
    'open_flights', count(*) filter (where f.status = 'ouvert'),
    'drones_flown', count(distinct f.drone_id))
  from flights f
  where f.flight_date between p_from and p_to
    and (p_port is null or f.drone_port_id = p_port)
$$;

create or replace function public.mr_open_flights(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'flight_id', f.id, 'flight_date', f.flight_date, 'takeoff_time', f.takeoff_time,
      'drone_code', d.code, 'drone_port_name', dp.name, 'destination_name', hf.name)
    order by f.flight_date, f.takeoff_time), '[]'::jsonb)
  from flights f
  join drones d on d.id = f.drone_id
  left join drone_ports dp on dp.id = f.drone_port_id
  left join health_facilities hf on hf.id = f.destination_id
  where f.status = 'ouvert' and f.flight_date between p_from and p_to
    and (p_port is null or f.drone_port_id = p_port)
$$;

create or replace function public.mr_qrf(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with q as (
    select f.*, d.code as drone_code, hf.name as destination_name
    from flights f
    join drones d on d.id = f.drone_id
    left join health_facilities hf on hf.id = f.destination_id
    where f.qrf and f.flight_date between p_from and p_to
      and (p_port is null or f.drone_port_id = p_port)
  )
  select jsonb_build_object(
    'total', (select count(*) from q),
    'by_cause', (select jsonb_build_object(
        'meteo', count(*) filter (where qrf_cause = 'meteo'),
        'technique', count(*) filter (where qrf_cause = 'technique'),
        'autre', count(*) filter (where qrf_cause = 'autre')) from q),
    'by_condition', (select coalesce(jsonb_object_agg(x.c, x.n), '{}'::jsonb)
                     from (select c.c, count(*) as n from q cross join lateral unnest(q.qrf_conditions) as c(c) group by c.c) x),
    'retried', (select count(*) from q where exists (select 1 from flights r where r.retry_of_flight_id = q.id)),
    'list', (select coalesce(jsonb_agg(jsonb_build_object(
        'flight_id', q.id, 'flight_date', q.flight_date, 'drone_code', q.drone_code, 'destination_name', q.destination_name,
        'cause', q.qrf_cause, 'conditions', to_jsonb(coalesce(q.qrf_conditions, '{}'::text[])), 'details', q.qrf_details)
      order by q.flight_date, q.takeoff_time), '[]'::jsonb) from q))
$$;

create or replace function public.mr_pilots(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with crew as (
    select fp.pilot_id, count(*) as n,
           sum(flight_minutes(f.takeoff_time, f.landing_time)) as m,
           coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)) filter (where fp.role = 'pilote'), 0) as pic
    from flight_pilots fp
    join flights f on f.id = fp.flight_id
    where f.flight_date between p_from and p_to
    group by fp.pilot_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'drone_port_name', dp.name, 'active', p.active,
      'flights', coalesce(c.n, 0), 'minutes', coalesce(c.m, 0), 'pic_minutes', coalesce(c.pic, 0),
      'has_account', exists (select 1 from profiles pr where pr.pilot_id = p.id))
    order by coalesce(c.m, 0) desc, p.full_name), '[]'::jsonb)
  from pilots p
  left join drone_ports dp on dp.id = p.drone_port_id
  left join crew c on c.pilot_id = p.id
  where (p_port is null or p.drone_port_id = p_port)
    and (p.active or c.n > 0)
$$;

-- ---------------------------------------------------------------------
-- Flotte, batteries, pièces
-- ---------------------------------------------------------------------
create or replace function public.mr_fleet(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with fl as (
    select f.drone_id, count(*) as n, sum(flight_minutes(f.takeoff_time, f.landing_time)) as m,
           count(*) filter (where f.qrf) as qrf
    from flights f
    where f.flight_date between p_from and p_to
    group by f.drone_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'code', d.code, 'model', d.model, 'status', d.status, 'drone_port_name', dp.name,
      'flights', coalesce(fl.n, 0), 'minutes', coalesce(fl.m, 0), 'qrf', coalesce(fl.qrf, 0),
      'total_hours', vs.total_hours,
      'next_visit_hours', vs.next_visit_hours,
      'hours_to_next_visit', vs.hours_to_next_visit,
      'last_visit_date', vs.last_visit_date,
      'visits_in_month', (select count(*) from maintenance_visits mv
                          where mv.drone_id = d.id and mv.visit_date between p_from and p_to),
      'reports_in_month', (select count(*) from technical_reports tr join flights f2 on f2.id = tr.flight_id
                           where f2.drone_id = d.id and f2.flight_date between p_from and p_to),
      'open_reports', vs.open_reports,
      'open_work_orders', (select count(*) from work_orders w where w.drone_id = d.id and w.status <> 'cloture'))
    order by d.code), '[]'::jsonb)
  from drones d
  left join drone_ports dp on dp.id = d.drone_port_id
  left join v_drone_status vs on vs.id = d.id
  left join fl on fl.drone_id = d.id
  where (p_port is null or d.drone_port_id = p_port)
    and (d.status <> 'retire' or fl.n > 0)
$$;

create or replace function public.mr_batteries(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'packs', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', ps.id, 'pack_number', ps.pack_number, 'status', ps.status, 'drone_port_name', ps.drone_port_name,
          'flights_in_month', (select count(*) from flights f
                               where f.battery_pack_id = ps.id and f.flight_date between p_from and p_to),
          'max_total_cycles', ps.max_total_cycles, 'max_cycle_pct', ps.max_cycle_pct, 'min_health_pct', ps.min_health_pct)
        order by ps.pack_number)
      from v_pack_status ps
      where (p_port is null or ps.drone_port_id = p_port) and ps.status <> 'hors_service'), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', b.id, 'code', coalesce(b.code, b.serial_number, '?'), 'drone_port_name', b.drone_port_name,
          'total_cycles', b.total_cycles, 'max_cycles', b.max_cycles, 'cycle_pct', b.cycle_pct, 'health_pct', b.health_pct,
          'level', case when b.cycle_pct >= 100 or b.health_pct < 75 then 'danger' else 'warn' end)
        order by b.cycle_pct desc)
      from v_battery_status b
      where (p_port is null or b.drone_port_id = p_port) and b.status <> 'hors_service'
        and (b.cycle_pct >= 90 or b.health_pct < 85)), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'date', t.transfer_date,
          'battery', coalesce(bp.pack_number::text || b.position, b.serial_number, '?'),
          'from_port', fp.name, 'to_port', tp.name, 'notes', t.notes)
        order by t.transfer_date, t.created_at)
      from battery_transfers t
      join batteries b on b.id = t.battery_id
      left join battery_packs bp on bp.id = t.pack_id
      left join drone_ports fp on fp.id = t.from_port_id
      left join drone_ports tp on tp.id = t.to_port_id
      where t.transfer_date between p_from and p_to
        and (p_port is null or t.from_port_id = p_port or t.to_port_id = p_port)), '[]'::jsonb))
$$;

create or replace function public.mr_parts(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with ev as (
    select e.*, p.code as part_code, t.name as type_name, d.code as drone_code
    from part_events e
    join parts p on p.id = e.part_id
    join part_types t on t.code = p.type_code
    left join drones d on d.id = e.drone_id
    where e.at >= p_from::timestamp and e.at < (p_to + 1)::timestamp
      and (p_port is null or p.drone_port_id = p_port or d.drone_port_id = p_port
           or e.from_port_id = p_port or e.to_port_id = p_port)
  )
  select jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(x.event_type, x.n), '{}'::jsonb)
               from (select event_type, count(*) as n from ev group by event_type) x),
    'mounted_by_type', (select coalesce(jsonb_agg(jsonb_build_object('type_name', x.type_name, 'n', x.n)
                                        order by x.n desc, x.type_name), '[]'::jsonb)
                        from (select type_name, count(*) as n from ev where event_type = 'montage' group by type_name) x),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                   'at', ev.at, 'event_type', ev.event_type, 'part_code', ev.part_code, 'type_name', ev.type_name,
                   'drone_code', ev.drone_code, 'slot', ev.slot, 'reason', ev.reason)
                 order by ev.at), '[]'::jsonb)
               from ev where ev.event_type in ('montage', 'demontage', 'quarantaine', 'rebut')),
    'stock_low', (select coalesce(jsonb_agg(jsonb_build_object(
                      'drone_port_name', dp.name, 'type_name', t.name, 'min_qty', th.min_qty, 'in_stock', s.n)
                    order by dp.name, t.name), '[]'::jsonb)
                  from part_stock_thresholds th
                  join part_types t on t.code = th.type_code
                  join drone_ports dp on dp.id = th.drone_port_id
                  cross join lateral (select count(*) as n from parts p
                                      where p.drone_port_id = th.drone_port_id and p.type_code = th.type_code
                                        and p.status = 'stock') s
                  where (p_port is null or th.drone_port_id = p_port) and s.n < th.min_qty),
    'near_limit', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', vp.id, 'code', vp.code, 'type_name', vp.type_name, 'drone_code', vp.drone_code,
                       'slot_label', vp.slot_label, 'total_hours', vp.total_hours,
                       'max_hours', vp.max_hours_effective, 'potential_pct', vp.potential_pct)
                     order by vp.potential_pct desc), '[]'::jsonb)
                   from v_parts vp
                   where vp.status = 'monte' and vp.potential_pct >= 90
                     and (p_port is null or vp.drone_port_id = p_port)))
$$;

-- ---------------------------------------------------------------------
-- Rapports techniques, ordres de travail, CRM
-- ---------------------------------------------------------------------
create or replace function public.mr_reports(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with r as (
    select tr.*, f.flight_date, f.destination_id, d.code as drone_code, hf.name as destination_name, dp.name as drone_port_name,
           public.mr_today() - (tr.created_at at time zone 'Indian/Antananarivo')::date as age_days
    from technical_reports tr
    join flights f on f.id = tr.flight_id
    join drones d on d.id = f.drone_id
    left join health_facilities hf on hf.id = f.destination_id
    left join drone_ports dp on dp.id = f.drone_port_id
    where p_port is null or f.drone_port_id = p_port
  ),
  m as (select * from r where r.flight_date between p_from and p_to)
  select jsonb_build_object(
    'month_total', (select count(*) from m),
    'month_incidents', (select count(*) from m where report_type = 'incident'),
    'month_by_severity', (select jsonb_build_object(
        'mineur', count(*) filter (where severity = 'mineur'),
        'majeur', count(*) filter (where severity = 'majeur'),
        'critique', count(*) filter (where severity = 'critique')) from m),
    'closed_in_month', (select count(*) from r where resolved_on between p_from and p_to),
    'avg_resolution_days', (select round(avg(resolved_on - (created_at at time zone 'Indian/Antananarivo')::date), 1)
                            from r where resolved_on between p_from and p_to),
    'components', (select coalesce(jsonb_agg(jsonb_build_object('component', x.component, 'n', x.n)
                                   order by x.n desc, x.component), '[]'::jsonb)
                   from (select coalesce(nullif(btrim(component), ''), 'Non précisé') as component, count(*) as n
                         from m group by 1) x),
    'open_total', (select count(*) from r where status <> 'clos'),
    'open', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', id, 'flight_id', flight_id, 'flight_date', flight_date, 'drone_code', drone_code,
                 'destination_name', destination_name, 'drone_port_name', drone_port_name,
                 'report_type', report_type, 'severity', severity, 'component', component,
                 'description', description, 'status', status, 'age_days', age_days)
               order by case severity when 'critique' then 0 when 'majeur' then 1 else 2 end, age_days desc), '[]'::jsonb)
             from r where status <> 'clos'))
$$;

create or replace function public.mr_work_orders(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with w as (
    select wo.*, d.code as drone_code, dp.name as drone_port_name,
           (wo.opened_at at time zone 'Indian/Antananarivo')::date as opened_on,
           (wo.signed_at at time zone 'Indian/Antananarivo')::date as signed_on,
           coalesce(wo.due_date < public.mr_today(), false) as is_overdue
    from work_orders wo
    join drones d on d.id = wo.drone_id
    left join drone_ports dp on dp.id = wo.drone_port_id
    where p_port is null or wo.drone_port_id = p_port
  )
  select jsonb_build_object(
    'opened_in_month', (select count(*) from w where opened_on between p_from and p_to),
    'closed_in_month', (select count(*) from w where signed_on between p_from and p_to),
    'open_total', (select count(*) from w where status <> 'cloture'),
    'overdue', (select count(*) from w where status <> 'cloture' and is_overdue),
    'open', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', id, 'number', number, 'title', title, 'drone_code', drone_code, 'drone_port_name', drone_port_name,
                 'kind', kind, 'priority', priority, 'status', status, 'due_date', due_date,
                 'opened_on', opened_on, 'overdue', is_overdue)
               order by case priority when 'urgente' then 0 when 'haute' then 1 else 2 end, opened_on), '[]'::jsonb)
             from w where status <> 'cloture'))
$$;

-- CRM complet : visa du commandant de bord, du copilote s'il y en a un, et visa « rapports » si le vol a des comptes rendus
create or replace function public.mr_crm(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with c as (
    select f.id, f.flight_date, f.takeoff_time, d.code as drone_code, dp.name as drone_port_name,
      exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'pilote') as s_pil,
      exists (select 1 from flight_pilots fp where fp.flight_id = f.id and fp.role = 'copilote') as has_cop,
      exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'copilote') as s_cop,
      exists (select 1 from technical_reports t where t.flight_id = f.id) as has_rep,
      exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports') as s_rep
    from flights f
    join drones d on d.id = f.drone_id
    left join drone_ports dp on dp.id = f.drone_port_id
    where f.status = 'cloture' and f.flight_date between p_from and p_to
      and (p_port is null or f.drone_port_id = p_port)
  ),
  x as (
    select c.*, array_remove(array[
      case when not c.s_pil then 'pilote' end,
      case when c.has_cop and not c.s_cop then 'copilote' end,
      case when c.has_rep and not c.s_rep then 'rapports' end]::text[], null::text) as missing
    from c
  )
  select jsonb_build_object(
    'closed_flights', (select count(*) from x),
    'complete', (select count(*) from x where cardinality(missing) = 0),
    'incomplete', (select coalesce(jsonb_agg(jsonb_build_object(
                       'flight_id', id, 'flight_date', flight_date, 'takeoff_time', takeoff_time,
                       'drone_code', drone_code, 'drone_port_name', drone_port_name, 'missing', to_jsonb(missing))
                     order by flight_date, takeoff_time), '[]'::jsonb)
                   from x where cardinality(missing) > 0))
$$;

-- ---------------------------------------------------------------------
-- Volet technique par CSB (rapport administrateur)
-- « À surveiller » : incident majeur / critique, au moins 2 QRF, consommation ou vent moyens > +20 % du réseau
-- ---------------------------------------------------------------------
create or replace function public.mr_csb_technical(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with f as (
    select fl.*, flight_minutes(fl.takeoff_time, fl.landing_time) as m
    from flights fl
    where fl.flight_date between p_from and p_to and fl.destination_id is not null
  ),
  net as (
    select avg(f.consumption_mah) filter (where not f.qrf) as cons, avg(f.avg_wind_ms) as wind from f
  ),
  rp as (
    select f.destination_id, count(*) as n,
           count(*) filter (where tr.report_type = 'incident') as incidents,
           count(*) filter (where tr.severity in ('majeur', 'critique')) as major_plus,
           count(*) filter (where tr.status <> 'clos') as open_n
    from technical_reports tr join f on f.id = tr.flight_id
    group by f.destination_id
  ),
  per as (
    select hf.id, hf.name, hf.code, hf.category, dt.name as district, rg.name as region,
           string_agg(distinct dp.name, ', ') as drone_ports,
           count(*) as flights,
           count(*) filter (where f.flight_type = 'livraison' and not f.qrf) as deliveries,
           count(*) filter (where f.qrf) as qrf,
           count(*) filter (where f.qrf and f.qrf_cause = 'meteo') as qrf_meteo,
           count(*) filter (where f.qrf and f.qrf_cause = 'technique') as qrf_technique,
           round(avg(f.m), 1) as avg_minutes,
           round(avg(f.avg_wind_ms), 1) as avg_wind,
           round(avg(f.consumption_mah) filter (where not f.qrf)) as avg_consumption,
           round(avg(f.payload_kg) filter (where f.flight_type = 'livraison' and not f.qrf), 2) as avg_payload
    from f
    join health_facilities hf on hf.id = f.destination_id
    left join mg_districts dt on dt.id = hf.district_id
    left join mg_regions rg on rg.id = hf.region_id
    left join drone_ports dp on dp.id = f.drone_port_id
    group by hf.id, dt.name, rg.name
  ),
  scored as (
    select per.*, coalesce(rp.n, 0) as reports, coalesce(rp.incidents, 0) as incidents,
           coalesce(rp.major_plus, 0) as major_plus, coalesce(rp.open_n, 0) as open_reports,
           array_remove(array[
             case when coalesce(rp.major_plus, 0) > 0 then 'incident majeur ou critique' end,
             case when per.qrf >= 2 then per.qrf || ' QRF' end,
             case when net.cons > 0 and per.avg_consumption > net.cons * 1.2
                  then 'consommation +' || round(100 * (per.avg_consumption / net.cons - 1)) || ' %' end,
             case when net.wind > 0 and per.avg_wind > net.wind * 1.2
                  then 'vent moyen +' || round(100 * (per.avg_wind / net.wind - 1)) || ' %' end]::text[], null::text) as reasons
    from per
    cross join net
    left join rp on rp.destination_id = per.id
  )
  select jsonb_build_object(
    'network', (select jsonb_build_object('avg_consumption', round(cons), 'avg_wind', round(wind, 1)) from net),
    'csb', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', s.id, 'name', s.name, 'code', s.code, 'category', s.category,
                         'district', s.district, 'region', s.region, 'drone_ports', s.drone_ports,
                         'flights', s.flights, 'deliveries', s.deliveries, 'qrf', s.qrf,
                         'qrf_meteo', s.qrf_meteo, 'qrf_technique', s.qrf_technique,
                         'avg_minutes', s.avg_minutes, 'avg_wind', s.avg_wind, 'avg_consumption', s.avg_consumption,
                         'avg_payload', s.avg_payload, 'reports', s.reports, 'incidents', s.incidents,
                         'major_reports', s.major_plus, 'open_reports', s.open_reports,
                         'watch', cardinality(s.reasons) > 0, 'reasons', to_jsonb(s.reasons))
                       order by (cardinality(s.reasons) > 0) desc, s.flights desc, s.name)
                     from scored s), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------
-- Comparaison des drone ports (rapport administrateur)
-- ---------------------------------------------------------------------
create or replace function public.mr_by_port(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(
      jsonb_build_object('id', dp.id, 'name', dp.name)
      || public.mr_flight_summary(p_from, p_to, dp.id)
      || jsonb_build_object(
        'reports_in_month', (select count(*) from technical_reports tr join flights f on f.id = tr.flight_id
                             where f.drone_port_id = dp.id and f.flight_date between p_from and p_to),
        'incidents_in_month', (select count(*) from technical_reports tr join flights f on f.id = tr.flight_id
                               where f.drone_port_id = dp.id and f.flight_date between p_from and p_to
                                 and tr.report_type = 'incident'),
        'open_reports', (select count(*) from technical_reports tr join flights f on f.id = tr.flight_id
                         where f.drone_port_id = dp.id and tr.status <> 'clos'),
        'qrf_technique', (select count(*) from flights f where f.drone_port_id = dp.id and f.qrf
                            and f.qrf_cause = 'technique' and f.flight_date between p_from and p_to),
        'open_work_orders', (select count(*) from work_orders w where w.drone_port_id = dp.id and w.status <> 'cloture'),
        'overdue_work_orders', (select count(*) from work_orders w where w.drone_port_id = dp.id
                                  and w.status <> 'cloture' and w.due_date < public.mr_today()),
        'crm_incomplete', jsonb_array_length(public.mr_crm(p_from, p_to, dp.id) -> 'incomplete'),
        'drones', (select count(*) from drones d where d.drone_port_id = dp.id and d.status <> 'retire'),
        'drones_unavailable', (select count(*) from drones d where d.drone_port_id = dp.id
                                 and d.status in ('maintenance', 'immobilise')))
    order by dp.name), '[]'::jsonb)
  from drone_ports dp
  where dp.active or exists (select 1 from flights f where f.drone_port_id = dp.id and f.flight_date between p_from and p_to)
$$;

-- ---------------------------------------------------------------------
-- Points d'attention (rapport administrateur), du plus grave au moins grave
-- ---------------------------------------------------------------------
create or replace function public.mr_attention(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with items(level, category, label, link) as (
    select 'warn', 'Vols', count(*) || ' vol(s) du mois encore ouvert(s), à clôturer avant de valider le rapport UNFPA', '/vols?statut=ouvert'
      from flights where status = 'ouvert' and flight_date between p_from and p_to having count(*) > 0
    union all
    select 'danger', 'Rapports', count(*) || ' rapport(s) critique(s) non clos', '/rapports'
      from technical_reports where status <> 'clos' and severity = 'critique' having count(*) > 0
    union all
    select 'warn', 'Rapports', count(*) || ' rapport(s) majeur(s) non clos', '/rapports'
      from technical_reports where status <> 'clos' and severity = 'majeur' having count(*) > 0
    union all
    select 'warn', 'Rapports', count(*) || ' rapport(s) ouvert(s) depuis plus de 15 jours', '/rapports'
      from technical_reports
      where status <> 'clos' and (created_at at time zone 'Indian/Antananarivo')::date < public.mr_today() - 15
      having count(*) > 0
    union all
    select case when vs.hours_to_next_visit <= 0 then 'danger' else 'warn' end, 'Drones',
           vs.code || case when vs.hours_to_next_visit <= 0
                           then ' : visite ' || replace(vs.next_visit_hours::text, '.', ',') || ' h dépassée'
                           else ' : visite ' || replace(vs.next_visit_hours::text, '.', ',') || ' h dans '
                                || replace(vs.hours_to_next_visit::text, '.', ',') || ' h' end,
           '/drones/' || vs.id
      from v_drone_status vs where vs.status <> 'retire' and vs.hours_to_next_visit <= 25
    union all
    select 'danger', 'Batteries', count(*) || ' batterie(s) en fin de vie (cycles max atteints ou capacité < 75 %)', '/batteries'
      from v_battery_status where status <> 'hors_service' and (cycle_pct >= 100 or health_pct < 75) having count(*) > 0
    union all
    select 'warn', 'Batteries', count(*) || ' batterie(s) à surveiller (≥ 90 % des cycles ou capacité < 85 %)', '/batteries'
      from v_battery_status
      where status <> 'hors_service' and (cycle_pct >= 90 or health_pct < 85)
        and not (cycle_pct >= 100 or coalesce(health_pct < 75, false))
      having count(*) > 0
    union all
    select case when vp.potential_pct >= 100 then 'danger' else 'warn' end, 'Pièces',
           vp.code || ' (' || vp.type_name || coalesce(', ' || vp.drone_code, '') || ') : '
           || replace(vp.potential_pct::text, '.', ',') || ' % du potentiel', '/pieces/' || vp.id
      from v_parts vp where vp.status = 'monte' and vp.potential_pct >= 90
    union all
    select 'warn', 'Pièces', jsonb_array_length(s.j) || ' type(s) de pièce sous le stock minimum', '/pieces?onglet=stock'
      from (select public.mr_parts(p_from, p_to, null) -> 'stock_low' as j) s where jsonb_array_length(s.j) > 0
    union all
    select 'danger', 'Ordres de travail', count(*) || ' OT urgent(s) non clôturé(s)', '/ordres-travail'
      from work_orders where status <> 'cloture' and priority = 'urgente' having count(*) > 0
    union all
    select 'warn', 'Ordres de travail', count(*) || ' OT en retard (échéance dépassée)', '/ordres-travail'
      from work_orders where status <> 'cloture' and due_date < public.mr_today() having count(*) > 0
    union all
    select 'warn', 'CRM', jsonb_array_length(s.j) || ' CRM du mois incomplet(s) (visas manquants)', '/crm/export'
      from (select public.mr_crm(p_from, p_to, null) -> 'incomplete' as j) s where jsonb_array_length(s.j) > 0
    union all
    select 'info', 'CSB', count(*) || ' CSB à surveiller (voir le volet par CSB)', null
      from jsonb_array_elements(public.mr_csb_technical(p_from, p_to) -> 'csb') c
      where (c ->> 'watch')::boolean having count(*) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('level', level, 'category', category, 'label', label, 'link', link)
                  order by case level when 'danger' then 0 when 'warn' then 1 else 2 end, category, label), '[]'::jsonb)
  from items
$$;

-- ---------------------------------------------------------------------
-- Indicateurs de livraison (rapport UNFPA), sur une période quelconque
-- kg/heure : kg livrés / heures des vols de livraison (QRF compris : coût réel de la livraison)
-- ---------------------------------------------------------------------
create or replace function public.mr_delivery_kpis(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
  with f as (
    select fl.*, flight_minutes(fl.takeoff_time, fl.landing_time) as m,
           case when fl.drop_time is not null then flight_minutes(fl.takeoff_time, fl.drop_time) end as to_drop
    from flights fl
    where fl.flight_date between p_from and p_to
  ),
  a as (
    select count(*) as flights,
           count(*) filter (where flight_type = 'livraison') as attempts,
           count(*) filter (where flight_type = 'livraison' and not qrf) as deliveries,
           count(*) filter (where flight_type = 'livraison' and qrf) as qrf_deliveries,
           coalesce(sum(payload_kg) filter (where flight_type = 'livraison' and not qrf), 0) as kg,
           coalesce(sum(distance_km) filter (where flight_type = 'livraison' and not qrf), 0) as km,
           coalesce(sum(m), 0) as minutes,
           coalesce(sum(m) filter (where flight_type = 'livraison'), 0) as delivery_minutes,
           avg(to_drop) filter (where flight_type = 'livraison' and not qrf) as avg_to_drop,
           avg(m) filter (where flight_type = 'livraison' and not qrf) as avg_minutes,
           count(distinct destination_id) filter (where flight_type = 'livraison' and not qrf) as csb_served
    from f
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'flights', a.flights, 'attempts', a.attempts, 'deliveries', a.deliveries, 'qrf_deliveries', a.qrf_deliveries,
    'success_rate', case when a.attempts > 0 then round(100.0 * a.deliveries / a.attempts, 1) end,
    'kg', a.kg, 'km', a.km, 'minutes', a.minutes, 'delivery_minutes', a.delivery_minutes,
    'kg_per_delivery', case when a.deliveries > 0 then round(a.kg / a.deliveries, 2) end,
    'kg_per_hour', case when a.delivery_minutes > 0 then round(a.kg / (a.delivery_minutes / 60.0), 2) end,
    'avg_time_to_drop', round(a.avg_to_drop, 1),
    'avg_minutes', round(a.avg_minutes, 1),
    'csb_served', a.csb_served,
    'districts_served', (select count(distinct hf.district_id)
                         from f join health_facilities hf on hf.id = f.destination_id
                         where f.flight_type = 'livraison' and not f.qrf and hf.district_id is not null))
  from a
$$;

-- =====================================================================
-- 1. Rapport technique des pilotes (par drone port)
-- =====================================================================
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
    'pilots', public.mr_pilots(v_from, v_to, v_port));
end;
$$;

-- =====================================================================
-- 2. Rapport technique de l'administrateur (consolidé)
-- =====================================================================
create or replace function public.monthly_admin_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, public.mr_today()))::date;
  v_to   date := (date_trunc('month', coalesce(p_month, public.mr_today())) + interval '1 month - 1 day')::date;
begin
  if not (public.is_admin() or public.mr_is_service()) then
    raise exception 'Rapport réservé aux administrateurs' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'kind', 'admin',
    'period', public.mr_period(v_from, v_to),
    'summary', public.mr_flight_summary(v_from, v_to, null),
    'previous', public.mr_flight_summary((v_from - interval '1 month')::date, v_from - 1, null),
    'attention', public.mr_attention(v_from, v_to),
    'by_port', public.mr_by_port(v_from, v_to),
    'open_flights', public.mr_open_flights(v_from, v_to, null),
    'fleet', public.mr_fleet(v_from, v_to, null),
    'batteries', public.mr_batteries(v_from, v_to, null),
    'parts', public.mr_parts(v_from, v_to, null),
    'reports', public.mr_reports(v_from, v_to, null),
    'work_orders', public.mr_work_orders(v_from, v_to, null),
    'crm', public.mr_crm(v_from, v_to, null),
    'qrf', public.mr_qrf(v_from, v_to, null),
    'csb', public.mr_csb_technical(v_from, v_to),
    'pilots', public.mr_pilots(v_from, v_to, null),
    'audit', (select jsonb_build_object(
        'entries', count(*),
        'deletions', count(*) filter (where a.action = 'DELETE'),
        'flights_reopened', count(*) filter (where a.table_name = 'flights' and a.action = 'UPDATE'
                                               and a.changes -> 'status' ->> 'old' = 'cloture'
                                               and a.changes -> 'status' ->> 'new' = 'ouvert'),
        'work_orders_reopened', count(*) filter (where a.table_name = 'work_orders' and a.action = 'UPDATE'
                                                   and a.changes -> 'status' ->> 'old' = 'cloture'))
      from audit_log a
      where (a.at at time zone 'Indian/Antananarivo')::date between v_from and v_to));
end;
$$;

-- =====================================================================
-- 3. Rapport livraisons et efficacité (équipe UNFPA)
-- =====================================================================
create or replace function public.monthly_delivery_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, public.mr_today()))::date;
  v_to   date := (date_trunc('month', coalesce(p_month, public.mr_today())) + interval '1 month - 1 day')::date;
  v_ly_from date;
  v_ly_to   date;
begin
  if not (public.is_admin() or public.mr_is_service()) then
    raise exception 'Rapport réservé aux administrateurs' using errcode = '42501';
  end if;
  v_ly_from := (v_from - interval '1 year')::date;
  v_ly_to := (date_trunc('month', v_ly_from) + interval '1 month - 1 day')::date;

  return (
    with d as (
      select f.*, dp.name as drone_port_name
      from flights f
      left join drone_ports dp on dp.id = f.drone_port_id
      where f.flight_date between v_from and v_to and f.flight_type = 'livraison' and not f.qrf
    )
    select jsonb_build_object(
      'kind', 'unfpa',
      'period', public.mr_period(v_from, v_to),
      'kpis', public.mr_delivery_kpis(v_from, v_to),
      'previous', public.mr_delivery_kpis((v_from - interval '1 month')::date, v_from - 1),
      'last_year', public.mr_delivery_kpis(v_ly_from, v_ly_to),
      'ytd', public.mr_delivery_kpis(date_trunc('year', v_from)::date, v_to),
      'csb_active', (select count(*) from health_facilities where active),
      'new_csb', (select count(*) from (select distinct destination_id from d) s
                  where not exists (select 1 from flights f2
                                    where f2.destination_id = s.destination_id and f2.flight_type = 'livraison'
                                      and not f2.qrf and f2.flight_date < v_from)),
      'by_port', (select coalesce(jsonb_agg(jsonb_build_object(
                      'id', x.id, 'name', x.name, 'deliveries', x.deliveries, 'kg', x.kg,
                      'csb_served', x.csb_served, 'qrf', x.qrf)
                    order by x.kg desc, x.name), '[]'::jsonb)
                  from (select dp.id, dp.name, count(d.id) as deliveries, coalesce(sum(d.payload_kg), 0) as kg,
                               count(distinct d.destination_id) as csb_served,
                               (select count(*) from flights f where f.drone_port_id = dp.id and f.flight_type = 'livraison'
                                  and f.qrf and f.flight_date between v_from and v_to) as qrf
                        from drone_ports dp
                        left join d on d.drone_port_id = dp.id
                        group by dp.id
                        having dp.active or count(d.id) > 0) x),
      'by_org', (select coalesce(jsonb_agg(jsonb_build_object('organization', x.org, 'deliveries', x.n, 'kg', x.kg)
                                 order by x.kg desc), '[]'::jsonb)
                 from (select case when organization = 'AUTRE' then coalesce(nullif(btrim(organization_other), ''), 'Autre')
                                   else organization end as org,
                              count(*) as n, coalesce(sum(payload_kg), 0) as kg
                       from d group by 1) x),
      'by_district', (select coalesce(jsonb_agg(jsonb_build_object(
                          'region', x.region, 'district', x.district, 'csb_active', x.csb_active,
                          'csb_served', x.csb_served, 'deliveries', x.deliveries, 'kg', x.kg)
                        order by x.kg desc, x.deliveries desc, x.district), '[]'::jsonb)
                      from (select coalesce(rg.name, 'Région non renseignée') as region,
                                   coalesce(dt.name, 'District non renseigné') as district,
                                   count(distinct hf.id) filter (where hf.active) as csb_active,
                                   count(distinct d.destination_id) as csb_served,
                                   count(d.id) as deliveries,
                                   coalesce(sum(d.payload_kg), 0) as kg
                            from health_facilities hf
                            left join mg_districts dt on dt.id = hf.district_id
                            left join mg_regions rg on rg.id = hf.region_id
                            left join d on d.destination_id = hf.id
                            group by rg.name, dt.name
                            having count(d.id) > 0) x),
      'by_csb', (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', x.id, 'name', x.name, 'code', x.code, 'category', x.category,
                     'district', x.district, 'region', x.region, 'drone_ports', x.drone_ports,
                     'deliveries', x.deliveries, 'kg', x.kg, 'last_delivery', x.last_delivery, 'first_time', x.first_time)
                   order by x.kg desc, x.deliveries desc, x.name), '[]'::jsonb)
                 from (select hf.id, hf.name, hf.code, hf.category, dt.name as district, rg.name as region,
                              string_agg(distinct d.drone_port_name, ', ') as drone_ports,
                              count(d.id) as deliveries, coalesce(sum(d.payload_kg), 0) as kg,
                              (select max(f2.flight_date) from flights f2
                                where f2.destination_id = hf.id and f2.flight_type = 'livraison' and not f2.qrf
                                  and f2.flight_date <= v_to) as last_delivery,
                              (count(d.id) > 0 and not exists (
                                 select 1 from flights f3 where f3.destination_id = hf.id and f3.flight_type = 'livraison'
                                   and not f3.qrf and f3.flight_date < v_from)) as first_time
                       from health_facilities hf
                       left join mg_districts dt on dt.id = hf.district_id
                       left join mg_regions rg on rg.id = hf.region_id
                       left join d on d.destination_id = hf.id
                       where hf.active or d.id is not null
                       group by hf.id, dt.name, rg.name) x),
      'daily', (select jsonb_agg(jsonb_build_object('date', g.day::date, 'deliveries', coalesce(x.n, 0), 'kg', coalesce(x.kg, 0))
                                 order by g.day)
                from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as g(day)
                left join (select flight_date, count(*) as n, sum(payload_kg) as kg from d group by flight_date) x
                       on x.flight_date = g.day::date),
      'qrf', public.mr_qrf(v_from, v_to, null)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Droits : seules les trois fonctions de rapport sont appelables
-- ---------------------------------------------------------------------
revoke all on function
  public.mr_today(), public.mr_is_service(), public.mr_period(date, date),
  public.mr_flight_summary(date, date, uuid), public.mr_open_flights(date, date, uuid), public.mr_qrf(date, date, uuid),
  public.mr_pilots(date, date, uuid), public.mr_fleet(date, date, uuid), public.mr_batteries(date, date, uuid),
  public.mr_parts(date, date, uuid), public.mr_reports(date, date, uuid), public.mr_work_orders(date, date, uuid),
  public.mr_crm(date, date, uuid), public.mr_csb_technical(date, date), public.mr_by_port(date, date),
  public.mr_attention(date, date), public.mr_delivery_kpis(date, date)
from public, anon, authenticated;

revoke all on function public.monthly_tech_report(date, uuid), public.monthly_admin_report(date),
  public.monthly_delivery_report(date) from public, anon;
grant execute on function public.monthly_tech_report(date, uuid), public.monthly_admin_report(date),
  public.monthly_delivery_report(date) to authenticated, service_role;

comment on function public.monthly_tech_report(date, uuid) is
  'Rapport mensuel technique des pilotes : pilote = son drone port ; administrateur = port demandé ou tous (null)';
comment on function public.monthly_admin_report(date) is
  'Rapport mensuel technique consolidé de l''administrateur (tous les drone ports, volet par CSB, points d''attention)';
comment on function public.monthly_delivery_report(date) is
  'Rapport mensuel livraisons et efficacité pour l''équipe UNFPA (poids livré, CSB desservis par district)';
