-- =====================================================================
-- Vols historiques importés (fichier Excel des vols 2025-2026)
--  * flights.imported : vol repris d'un registre antérieur à l'application
--  * à la création : le drone port du registre est conservé (sinon : drone port actuel du drone)
--  * à la clôture : la date de clôture fournie est conservée (sinon : maintenant)
--  * pas de visa CRM demandé, non compté dans les CRM incomplets (CRM papier de l'époque)
--  * seul un administrateur (ou un import direct en base, sans utilisateur connecté) peut marquer un vol importé
-- =====================================================================

alter table public.flights add column imported boolean not null default false;
comment on column public.flights.imported is 'Vol historique importé (registre antérieur) : pas de visa CRM, drone port et date de clôture d''origine';

-- ---------------------------------------------------------------------
-- Règles sur les vols (version précédente : 20261119000000_drone_ports_scope_logbook.sql)
-- ---------------------------------------------------------------------
create or replace function public.flights_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.imported and auth.uid() is not null and not is_admin() then
      raise exception 'Seul un administrateur peut importer des vols historiques';
    end if;
    new.status := 'ouvert';
    new.closed_at := null;
    new.closed_by := null;
    -- vol importé : drone port du registre ; sinon drone port actuel du drone
    if not new.imported or new.drone_port_id is null then
      select drone_port_id into new.drone_port_id from drones where id = new.drone_id;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'cloture' then
      raise exception 'Vol clôturé : suppression impossible (un administrateur doit d''abord le rouvrir)';
    end if;
    return old;
  end if;

  -- UPDATE
  if new.imported is distinct from old.imported and auth.uid() is not null and not is_admin() then
    raise exception 'Seul un administrateur peut modifier la marque « vol importé »';
  end if;

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
    -- vol importé : date de clôture d'origine si elle est fournie
    new.closed_at := case when new.imported and new.closed_at is not null then new.closed_at else now() end;
    new.closed_by := auth.uid();
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Vue des vols : recréée pour exposer la colonne imported (version précédente : 20261218000000_trainee_pilot.sql)
-- ---------------------------------------------------------------------
drop view if exists public.v_flights;
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

revoke all on public.v_flights from anon;
grant select on public.v_flights to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Tâches CRM : aucune pour les vols importés (version précédente : 20261218000000_trainee_pilot.sql)
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
    where f.status = 'cloture' and f.closed_at > now() - interval '60 days' and not f.imported
  ),
  todo as (
    select f.id, fp.role as kind
    from recent f
    join flight_pilots fp on fp.flight_id = f.id and fp.role in ('pilote', 'copilote')
    join me on me.pilot_id = fp.pilot_id and me.drone_port_id = f.drone_port_id
    where not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = fp.role)
    union all
    select f.id, 'rapports'
    from recent f join me on me.pilot_id is not null and me.drone_port_id = f.drone_port_id
    where exists (select 1 from technical_reports t where t.flight_id = f.id)
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports')
    union all
    select f.id, 'suivi'
    from flights f join me on me.role = 'admin'
    where f.flight_date > current_date - 60 and not f.imported
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
-- Rapports mensuels : CRM des vols saisis uniquement (version précédente : 20261212000000_monthly_reports.sql)
-- ---------------------------------------------------------------------
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
    where f.status = 'cloture' and not f.imported and f.flight_date between p_from and p_to
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
