-- =====================================================================
-- Planification WindPath
--  * flight_plans : bibliothèque de plans de vol (.waypoints / .plan) par drone port,
--    rattachés à une destination (formation sanitaire). Un fichier par route, pas par vol.
--  * flight_plan_estimates : estimation WindPath retenue au moment du report dans le vol
--    (un résumé de quelques valeurs, pas les points), pour comparer le prévu et le réel.
-- =====================================================================

create table public.flight_plans (
  id             uuid primary key default gen_random_uuid(),
  drone_port_id  uuid not null references public.drone_ports(id) on delete cascade,
  destination_id uuid references public.health_facilities(id) on delete set null,
  name           text not null check (length(trim(name)) between 1 and 120),
  file_name      text not null check (length(trim(file_name)) between 1 and 200),
  content        text not null check (length(content) between 1 and 500000),
  waypoint_count integer check (waypoint_count is null or waypoint_count >= 0),
  distance_km    numeric(7,2) check (distance_km is null or distance_km >= 0),
  notes          text,
  active         boolean not null default true,
  created_by     uuid default auth.uid() references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.flight_plans is 'Plans de vol WindPath (Mission Planner .waypoints ou QGroundControl .plan) par drone port et destination';
create index flight_plans_port_idx on public.flight_plans (drone_port_id);
create index flight_plans_destination_idx on public.flight_plans (destination_id);
create trigger trg_flight_plans_updated before update on public.flight_plans for each row execute function public.set_updated_at();

alter table public.flight_plans enable row level security;
create policy fp_select on public.flight_plans for select to authenticated
  using (public.is_admin() or drone_port_id = public.my_drone_port_id());
create policy fp_insert on public.flight_plans for insert to authenticated
  with check (public.can_manage_port(drone_port_id));
create policy fp_update on public.flight_plans for update to authenticated
  using (public.can_manage_port(drone_port_id)) with check (public.can_manage_port(drone_port_id));
create policy fp_delete on public.flight_plans for delete to authenticated
  using (public.can_manage_port(drone_port_id));
grant select, insert, update, delete on public.flight_plans to authenticated;

-- Journal d'audit : même principe que audit_trigger(), mais le fichier du plan (jusqu'à 500 ko)
-- n'est pas recopié dans le journal : seule sa taille y figure.
create or replace function public.flight_plans_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  size_of constant text := ' caractères';
  j_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'content' || jsonb_build_object('content', length(new.content) || size_of) end;
  j_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'content' || jsonb_build_object('content', length(old.content) || size_of) end;
  j     jsonb := coalesce(j_new, j_old);
  diff  jsonb := '{}'::jsonb;
  k     text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(j_new) loop
      if k in ('updated_at', 'created_at') then continue; end if;
      if k = 'content' then
        if old.content is distinct from new.content then
          diff := diff || jsonb_build_object('content', jsonb_build_object('old', j_old -> k, 'new', j_new -> k));
        end if;
        continue;
      end if;
      if (j_old -> k) is distinct from (j_new -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', j_old -> k, 'new', j_new -> k));
      end if;
    end loop;
    if diff = '{}'::jsonb then return new; end if;
  elsif tg_op = 'INSERT' then
    diff := (select coalesce(jsonb_object_agg(key, jsonb_build_object('new', value)), '{}') from jsonb_each(j_new)
             where key not in ('updated_at', 'created_at') and value <> 'null'::jsonb);
  else
    diff := (select coalesce(jsonb_object_agg(key, jsonb_build_object('old', value)), '{}') from jsonb_each(j_old)
             where key not in ('updated_at', 'created_at') and value <> 'null'::jsonb);
  end if;

  insert into public.audit_log (user_id, actor, table_name, record_id, label, action, changes, drone_port_id)
  values (auth.uid(), public.audit_actor_name(auth.uid()), tg_table_name, j ->> 'id', j ->> 'name', tg_op, diff,
          nullif(j ->> 'drone_port_id', '')::uuid);
  return coalesce(new, old);
end $$;

create trigger trg_audit after insert or update or delete on public.flight_plans for each row execute function public.flight_plans_audit();

create table public.flight_plan_estimates (
  flight_id          uuid primary key references public.flights(id) on delete cascade,
  plan_id            uuid references public.flight_plans(id) on delete set null,
  mission_name       text,
  waypoint_count     integer,
  distance_km        numeric(7,2),
  takeoff_time       time,
  drop_time          time,
  landing_time       time,
  duration_min       numeric(6,1),
  consumption_mah    integer,
  voltage_end_v      numeric(5,2),
  margin_pct         numeric(5,1),   -- capacité restante après consommation estimée + réserve de route (20 %)
  wind_ms            numeric(4,1),
  wind_direction_deg integer,
  max_wind_ms        numeric(4,1),
  max_gust_ms        numeric(4,1),
  payload_kg         numeric(5,2),
  capacity_mah       integer,
  wind_checked_at    timestamptz,
  created_by         uuid default auth.uid() references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);
comment on table public.flight_plan_estimates is 'Estimation WindPath retenue pour un vol (prévu), comparée aux valeurs réelles du vol';

alter table public.flight_plan_estimates enable row level security;
-- lecture : celle des vols (RLS de flights) ; écriture : drone port du vol
create policy fpe_select on public.flight_plan_estimates for select to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id));
create policy fpe_insert on public.flight_plan_estimates for insert to authenticated
  with check (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)));
create policy fpe_update on public.flight_plan_estimates for update to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)))
  with check (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)));
create policy fpe_delete on public.flight_plan_estimates for delete to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)));
grant select, insert, update, delete on public.flight_plan_estimates to authenticated;
