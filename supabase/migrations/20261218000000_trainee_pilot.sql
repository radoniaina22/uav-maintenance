-- =====================================================================
-- Pilote en formation : 3e membre d'équipage facultatif (sessions d'apprentissage)
--  * rôle « stagiaire » sur le vol (au plus un commandant de bord, un copilote, un pilote en formation)
--  * inscrit au carnet de vol à la clôture, mais compté à part : ses heures n'entrent pas dans le total
--    d'heures (qualifiantes), le cumul du carnet, les classements ni les heures des rapports mensuels
--  * ne signe pas le CRM (visas inchangés : commandant de bord, copilote, rapports)
--  * n'importe quel pilote du drone port du vol peut être choisi
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Rôles autorisés et nombre de membres d'équipage
-- ---------------------------------------------------------------------
alter table public.flight_pilots drop constraint flight_pilots_role_check;
alter table public.flight_pilots add constraint flight_pilots_role_check check (role in ('pilote', 'copilote', 'stagiaire'));
create unique index flight_pilots_one_per_role on public.flight_pilots (flight_id, role);

alter table public.logbook_entries drop constraint logbook_entries_role_check;
alter table public.logbook_entries add constraint logbook_entries_role_check check (role in ('pilote', 'copilote', 'stagiaire'));

comment on column public.flight_pilots.role is 'pilote : commandant de bord ; copilote ; stagiaire : pilote en formation (facultatif)';

-- 3 membres au plus (le nom de la fonction est conservé : déclencheur existant)
create or replace function public.check_max_two_pilots()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.flight_pilots where flight_id = new.flight_id) >= 3 then
    raise exception 'Un vol ne peut avoir que 3 membres d''équipage au maximum (pilote, copilote, pilote en formation)';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Enregistrement d'un vol : pilote en formation facultatif (p_trainee_id)
--    (version précédente : 20261124000000_cruise_altitude.sql)
-- ---------------------------------------------------------------------
drop function if exists public.save_flight(uuid, jsonb, uuid[]);

create or replace function public.save_flight(p_id uuid, p_data jsonb, p_pilot_ids uuid[], p_trainee_id uuid default null)
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
    raise exception 'Un vol ne peut avoir que 2 pilotes au maximum (plus un pilote en formation)';
  elsif v_n = 2 and p_pilot_ids[1] = p_pilot_ids[2] then
    raise exception 'Les deux pilotes doivent être différents';
  end if;
  if p_trainee_id is not null and p_trainee_id = any (p_pilot_ids) then
    raise exception 'Le pilote en formation doit être différent du pilote et du copilote';
  end if;

  if p_id is null then
    insert into flights (drone_id, destination_id, flight_date, takeoff_time, drop_time, landing_time,
                         flight_type, organization, organization_other, distance_km, cruise_altitude_m,
                         payload_kg, avg_wind_ms, wind_direction_deg, consumption_mah,
                         voltage_start_v, voltage_end_v,
                         battery_pack_id, battery_1_id, battery_2_id, observation,
                         qrf, qrf_cause, qrf_conditions, qrf_time, qrf_details, retry_of_flight_id)
    select r.drone_id, r.destination_id, r.flight_date, r.takeoff_time,
           case when coalesce(r.qrf, false) then null else r.drop_time end, r.landing_time,
           coalesce(r.flight_type, 'livraison'), coalesce(r.organization, 'UNFPA'),
           case when r.organization = 'AUTRE' then r.organization_other end, r.distance_km, r.cruise_altitude_m,
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
      distance_km = r.distance_km, cruise_altitude_m = r.cruise_altitude_m,
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

  if p_trainee_id is not null then
    insert into flight_pilots (flight_id, pilot_id, role) values (v_id, p_trainee_id, 'stagiaire');
  end if;

  return v_id;
end;
$$;
revoke all on function public.save_flight(uuid, jsonb, uuid[], uuid) from public, anon;
grant execute on function public.save_flight(uuid, jsonb, uuid[], uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Vue des vols : pilot_names = commandant de bord puis copilote ; trainee_name ajouté en fin de vue
--    (version précédente : 20261124000000_cruise_altitude.sql)
-- ---------------------------------------------------------------------
create or replace view public.v_flights as
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
    where fp.flight_id = f.id and fp.role in ('pilote', 'copilote')) as pilot_names,
  (select count(*) from public.technical_reports tr where tr.flight_id = f.id) as report_count,
  (select count(*) from public.technical_reports tr where tr.flight_id = f.id and tr.status <> 'clos') as open_report_count,
  (select count(*) from public.flights rt where rt.retry_of_flight_id = f.id) as retry_count,
  (select p.full_name from public.flight_pilots fp join public.pilots p on p.id = fp.pilot_id
    where fp.flight_id = f.id and fp.role = 'stagiaire') as trainee_name
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

-- ---------------------------------------------------------------------
-- 4. Statistiques pilotes : heures en formation à part (colonnes ajoutées en fin de vue)
--    (version précédente : 20261211000000_maintenance_lead.sql)
-- ---------------------------------------------------------------------
create or replace view public.v_pilot_stats as
select p.id, p.full_name, p.license_number, p.phone, p.active, p.created_at, p.updated_at, p.drone_port_id, p.initial_flight_minutes,
  dp.name as drone_port_name,
  count(l.id) filter (where l.role <> 'stagiaire') as flight_count,
  round((p.initial_flight_minutes + coalesce(sum(l.duration_min) filter (where l.role <> 'stagiaire'), 0)) / 60.0, 1) as total_hours,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'pilote'), 0) / 60.0, 1) as pic_hours,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'copilote'), 0) / 60.0, 1) as copilot_hours,
  max(l.entry_date) as last_flight_date,
  (select count(*) from public.flight_pilots fp join public.flights f on f.id = fp.flight_id where fp.pilot_id = p.id and f.status = 'ouvert') as open_flight_count,
  (exists (select 1 from public.profiles pr where pr.pilot_id = p.id)) as has_account,
  p.maintenance_lead,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'stagiaire'), 0) / 60.0, 1) as trainee_hours,
  count(l.id) filter (where l.role = 'stagiaire') as trainee_flight_count
from public.pilots p
left join public.drone_ports dp on dp.id = p.drone_port_id
left join public.logbook_entries l on l.pilot_id = p.id
where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id()) or p.id = (select public.my_pilot_id())
group by p.id, dp.name;

-- ---------------------------------------------------------------------
-- 5. Carnet de vol : le cumul ne compte pas les heures en formation
--    (version précédente : 20261121000000_flight_type_org_voltage.sql)
-- ---------------------------------------------------------------------
create or replace view public.v_logbook as
select
  l.*,
  p.full_name as pilot_name,
  round((p.initial_flight_minutes
         + sum(case when l.role = 'stagiaire' then 0 else l.duration_min end)
             over (partition by l.pilot_id order by l.entry_date, l.takeoff_time, l.created_at rows unbounded preceding)) / 60.0, 2) as cumulative_hours
from public.logbook_entries l
join public.pilots p on p.id = l.pilot_id
where (select public.is_admin()) or l.pilot_id = (select public.my_pilot_id());

-- ---------------------------------------------------------------------
-- 6. Classement des pilotes : heures qualifiantes uniquement
--    (version précédente : 20261202000000_pilot_ranking.sql)
-- ---------------------------------------------------------------------
create or replace function public.pilot_ranking(p_from date default null, p_to date default null, p_port uuid default null)
returns table (pilot_id uuid, full_name text, license_number text, active boolean, drone_port_id uuid, drone_port_name text,
               has_account boolean, flights bigint, minutes numeric, pic_minutes numeric, copilot_minutes numeric,
               initial_minutes numeric, career_hours numeric, first_flight date, last_flight date)
language sql stable security definer set search_path = public as $$
  with scope as (
    select p.* from pilots p
    where case when is_admin() then (p_port is null or p.drone_port_id = p_port)
               else p.drone_port_id = my_drone_port_id() end
  ),
  career as (
    select l.pilot_id, sum(l.duration_min) as m from logbook_entries l where l.role <> 'stagiaire' group by l.pilot_id
  ),
  period as (
    select l.pilot_id,
           count(*) as flights,
           sum(l.duration_min) as minutes,
           sum(l.duration_min) filter (where l.role = 'pilote') as pic,
           sum(l.duration_min) filter (where l.role = 'copilote') as cop,
           min(l.entry_date) as first_flight,
           max(l.entry_date) as last_flight
    from logbook_entries l
    where l.role <> 'stagiaire'
      and (p_from is null or l.entry_date >= p_from) and (p_to is null or l.entry_date <= p_to)
    group by l.pilot_id
  )
  select s.id, s.full_name, s.license_number, s.active, s.drone_port_id, dp.name,
         exists (select 1 from profiles pr where pr.pilot_id = s.id),
         coalesce(pe.flights, 0),
         coalesce(pe.minutes, 0) + case when p_from is null and p_to is null then s.initial_flight_minutes else 0 end,
         coalesce(pe.pic, 0), coalesce(pe.cop, 0),
         case when p_from is null and p_to is null then s.initial_flight_minutes else 0 end,
         round((s.initial_flight_minutes + coalesce(c.m, 0)) / 60.0, 2),
         pe.first_flight, pe.last_flight
  from scope s
  left join drone_ports dp on dp.id = s.drone_port_id
  left join career c on c.pilot_id = s.id
  left join period pe on pe.pilot_id = s.id
  order by 9 desc, s.full_name;
$$;

-- ---------------------------------------------------------------------
-- 7. Tâches CRM : le pilote en formation n'a pas de visa à signer
--    (version précédente : 20261129000000_crm_tasks_scope_admin.sql)
-- ---------------------------------------------------------------------
create or replace function public.my_crm_tasks()
returns table (flight_id uuid, kind text, flight_date date, takeoff_time time, closed_at timestamptz,
               flight_status text, drone_code text, drone_port_name text, destination_name text,
               flight_seq bigint, report_count bigint, open_reports bigint)
language sql stable security definer set search_path = public as $$
  with me as (
    select pr.role, pr.pilot_id, p.drone_port_id
    from profiles pr left join pilots p on p.id = pr.pilot_id
    where pr.user_id = auth.uid()
  ),
  recent as (
    select f.* from flights f
    where f.status = 'cloture' and f.closed_at > now() - interval '60 days'
  ),
  todo as (
    -- visas de l'équipage (commandant de bord, copilote) : uniquement si le pilote est du drone port du vol
    select f.id, fp.role as kind
    from recent f
    join flight_pilots fp on fp.flight_id = f.id and fp.role in ('pilote', 'copilote')
    join me on me.pilot_id = fp.pilot_id and me.drone_port_id = f.drone_port_id
    where not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = fp.role)
    union all
    -- comptes rendus à traiter puis viser : pilotes du drone port du vol
    select f.id, 'rapports'
    from recent f join me on me.pilot_id is not null and me.drone_port_id = f.drone_port_id
    where exists (select 1 from technical_reports t where t.flight_id = f.id)
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports')
    union all
    -- administrateur : comptes rendus de tous les drone ports non encore traités et visés
    select f.id, 'suivi'
    from flights f join me on me.role = 'admin'
    where f.flight_date > current_date - 60
      and exists (select 1 from technical_reports t where t.flight_id = f.id)
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports')
  )
  select f.id, t.kind, f.flight_date, f.takeoff_time, f.closed_at, f.status, d.code, dp.name, hf.name,
         (select count(*) from flights x where x.drone_id = f.drone_id
            and (x.flight_date + x.takeoff_time, x.created_at, x.id) <= (f.flight_date + f.takeoff_time, f.created_at, f.id)),
         (select count(*) from technical_reports tr where tr.flight_id = f.id),
         (select count(*) from technical_reports tr where tr.flight_id = f.id and tr.status <> 'clos')
  from todo t
  join flights f on f.id = t.id
  join drones d on d.id = f.drone_id
  left join drone_ports dp on dp.id = f.drone_port_id
  left join health_facilities hf on hf.id = f.destination_id
  order by coalesce(f.closed_at, f.created_at) desc, t.kind;
$$;

-- ---------------------------------------------------------------------
-- 8. Rapports mensuels : heures d'équipe qualifiantes + heures en formation à part ; nom du stagiaire sur les vols
--    (versions précédentes : 20261212000000_monthly_reports.sql, 20261213000000_monthly_tech_report_flights.sql)
-- ---------------------------------------------------------------------
create or replace function public.mr_pilots(p_from date, p_to date, p_port uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with crew as (
    select fp.pilot_id,
           count(*) filter (where fp.role <> 'stagiaire') as n,
           coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)) filter (where fp.role <> 'stagiaire'), 0) as m,
           coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)) filter (where fp.role = 'pilote'), 0) as pic,
           count(*) filter (where fp.role = 'stagiaire') as tn,
           coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)) filter (where fp.role = 'stagiaire'), 0) as tm
    from flight_pilots fp
    join flights f on f.id = fp.flight_id
    where f.flight_date between p_from and p_to
    group by fp.pilot_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'drone_port_name', dp.name, 'active', p.active,
      'flights', coalesce(c.n, 0), 'minutes', coalesce(c.m, 0), 'pic_minutes', coalesce(c.pic, 0),
      'trainee_flights', coalesce(c.tn, 0), 'trainee_minutes', coalesce(c.tm, 0),
      'has_account', exists (select 1 from profiles pr where pr.pilot_id = p.id))
    order by coalesce(c.m, 0) desc, p.full_name), '[]'::jsonb)
  from pilots p
  left join drone_ports dp on dp.id = p.drone_port_id
  left join crew c on c.pilot_id = p.id
  where (p_port is null or p.drone_port_id = p_port)
    and (p.active or c.n > 0 or c.tn > 0)
$$;

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
                        from flight_pilots fp join pilots p on p.id = fp.pilot_id
                       where fp.flight_id = f.id and fp.role in ('pilote', 'copilote')),
      'trainee_name', (select p.full_name from flight_pilots fp join pilots p on p.id = fp.pilot_id
                        where fp.flight_id = f.id and fp.role = 'stagiaire'),
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
