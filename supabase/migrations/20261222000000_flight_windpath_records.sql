-- =====================================================================
-- Mission WindPath complète conservée avec le vol
--  * flight_windpath_records : points de passage, estimations, relevés réels (et valeurs
--    appliquées automatiquement, signalées comme estimations), vent et phases, enregistrés
--    au moment du report dans le vol. Sert à produire le « rapport de vol WindPath » joint au
--    CRM (même PDF), sur n'importe quel poste et à tout moment.
--  * Mêmes droits que flight_plan_estimates : lecture = celle du vol, écriture = drone port du vol.
-- =====================================================================

create table public.flight_windpath_records (
  flight_id  uuid primary key references public.flights(id) on delete cascade,
  record     jsonb not null check (jsonb_typeof(record) = 'object' and pg_column_size(record) <= 512000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.flight_windpath_records is 'Mission WindPath complète du vol (points, estimations, relevés) pour le rapport joint au CRM';
create trigger trg_flight_windpath_records_updated before update on public.flight_windpath_records
  for each row execute function public.set_updated_at();

alter table public.flight_windpath_records enable row level security;
create policy fwr_select on public.flight_windpath_records for select to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id));
create policy fwr_insert on public.flight_windpath_records for insert to authenticated
  with check (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)));
create policy fwr_update on public.flight_windpath_records for update to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)))
  with check (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)));
create policy fwr_delete on public.flight_windpath_records for delete to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and public.can_manage_port(f.drone_port_id)));
grant select, insert, update, delete on public.flight_windpath_records to authenticated;
