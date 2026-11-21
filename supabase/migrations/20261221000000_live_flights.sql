-- =====================================================================
-- Vols en cours partagés entre les laptops d'un même drone port
--  * live_flights : une ligne par utilisateur (son vol en cours), mise à jour toutes les
--    ~5 s par la page Planification : position recalée WindPath (pas une position GPS),
--    altitude, cap, vitesse, prochain point, écart au plan, route du plan.
--  * Visible par les comptes du même drone port (et les admins), diffusée en temps réel
--    (publication supabase_realtime). Données éphémères : pas de journal d'audit ;
--    la ligne est supprimée à la fin de la mission, les lignes anciennes sont ignorées par l'application.
--  * Le code du drone, le nom du pilote et l'heure de mise à jour sont fixés par la base
--    (un client ne peut pas se faire passer pour un autre drone ou un autre pilote).
-- =====================================================================

create table public.live_flights (
  user_id         uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  drone_id        uuid not null references public.drones(id) on delete cascade,
  drone_port_id   uuid not null references public.drone_ports(id) on delete cascade,
  drone_code      text not null default '',
  pilot_name      text,
  status          text not null default 'sol' check (status in ('sol', 'vol', 'arrive')),
  lat             double precision check (lat is null or lat between -90 and 90),
  lon             double precision check (lon is null or lon between -180 and 180),
  altitude_m      real,
  heading_deg     real check (heading_deg is null or heading_deg between 0 and 360),
  ground_speed_ms real check (ground_speed_ms is null or ground_speed_ms between 0 and 200),
  phase           text check (phase is null or length(phase) <= 40),
  next_label      text check (next_label is null or length(next_label) <= 40),
  next_eta        timestamptz,
  delay_s         integer,
  takeoff_at      timestamptz,
  landing_eta     timestamptz,
  mission_name    text check (mission_name is null or length(mission_name) <= 200),
  -- route du plan : [[lat, lon, altitude], ...] et index du point de largage
  route           jsonb check (route is null or (jsonb_typeof(route) = 'array' and jsonb_array_length(route) <= 500)),
  drop_index      integer,
  updated_at      timestamptz not null default now()
);
comment on table public.live_flights is 'Vol en cours de chaque utilisateur (position recalée WindPath), partagé en temps réel avec son drone port';
create index live_flights_port_idx on public.live_flights (drone_port_id);

-- Code du drone, pilote et horodatage fixés par la base ; le drone doit appartenir au drone port déclaré
create or replace function public.live_flights_fill()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d record;
begin
  select code, drone_port_id into d from public.drones where id = new.drone_id;
  if not found then raise exception 'Drone inconnu'; end if;
  if d.drone_port_id is distinct from new.drone_port_id then
    raise exception 'Le drone % n''appartient pas à ce drone port', d.code;
  end if;
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.drone_code := d.code;
  new.pilot_name := coalesce(
    (select p.full_name from public.pilots p where p.id = public.my_pilot_id()),
    (select nullif(u.raw_user_meta_data ->> 'full_name', '') from auth.users u where u.id = new.user_id),
    new.pilot_name);
  new.updated_at := now();
  return new;
end $$;
create trigger trg_live_flights_fill before insert or update on public.live_flights
  for each row execute function public.live_flights_fill();

alter table public.live_flights enable row level security;
create policy lf_select on public.live_flights for select to authenticated
  using (public.is_admin() or drone_port_id = public.my_drone_port_id());
create policy lf_insert on public.live_flights for insert to authenticated
  with check (user_id = auth.uid() and public.can_manage_port(drone_port_id));
create policy lf_update on public.live_flights for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_manage_port(drone_port_id));
create policy lf_delete on public.live_flights for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
grant select, insert, update, delete on public.live_flights to authenticated;

-- diffusion en temps réel (la publication existe sur Supabase ; ignorée si absente)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.live_flights;
  end if;
end $$;
