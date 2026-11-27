-- =====================================================================
-- Export en lecture seule vers Q.box (gestion logistique UNFPA / MSANP) :
-- écran « Statistiques techniques » (vols, distances, poids, heures de vol).
--
-- Sécurité :
--   * schéma dédié qbox_export avec des vues minimales : colonnes techniques seulement,
--     aucun identifiant de compte, aucun nom de pilote, aucune observation libre ;
--   * rôle qbox_lecteur créé SANS mot de passe (NOLOGIN) : le dépôt est public. La connexion
--     est activée à la main dans l'éditeur SQL du projet en ligne :
--       alter role qbox_lecteur with login password '<mot de passe fort>';
--     et désactivée de la même façon : alter role qbox_lecteur with nologin;
--   * le rôle ne lit que ces vues (aucun droit sur public, auth ni les tables) ;
--     transactions en lecture seule, 2 connexions au plus, requêtes limitées à 30 s.
-- Les vues appartiennent à postgres (security_invoker désactivé) : elles lisent les tables sans
-- passer par la RLS, mais seules les lignes et colonnes listées ici sont visibles.
-- =====================================================================

create schema if not exists qbox_export;
revoke all on schema qbox_export from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qbox_lecteur') then
    create role qbox_lecteur nologin noinherit nocreatedb nocreaterole connection limit 2;
  end if;
end $$;

alter role qbox_lecteur set default_transaction_read_only = on;
alter role qbox_lecteur set statement_timeout = '30s';
alter role qbox_lecteur set idle_in_transaction_session_timeout = '60s';
alter role qbox_lecteur set search_path = qbox_export;

-- Drone ports (coordonnées du port pour la carte).
create or replace view qbox_export.drone_ports as
select p.id, p.name, p.code, p.latitude, p.longitude, p.active,
       r.name as region, d.name as district
from public.drone_ports p
left join public.mg_regions r on r.id = p.region_id
left join public.mg_districts d on d.region_id = p.region_id and d.id = p.district_id;

-- Destinations (CSB) : nom, catégorie, coordonnées, distance et port de rattachement.
create or replace view qbox_export.csb as
select h.id, h.name, h.code, h.category, h.latitude, h.longitude, h.distance_km, h.drone_port_id, h.active,
       r.name as region, d.name as district
from public.health_facilities h
left join public.mg_regions r on r.id = h.region_id
left join public.mg_districts d on d.region_id = h.region_id and d.id = h.district_id;

-- Vols clôturés : données techniques uniquement.
create or replace view qbox_export.vols as
select f.id, f.drone_port_id, f.destination_id, f.flight_date, f.takeoff_time, f.drop_time, f.landing_time,
       f.flight_type, f.organization, f.organization_other,
       f.payload_kg, f.distance_km, f.consumption_mah, f.voltage_start_v, f.voltage_end_v,
       f.avg_wind_ms, f.wind_direction_deg, f.cruise_altitude_m,
       f.qrf, f.qrf_cause, f.qrf_conditions, f.retry_of_flight_id
from public.flights f
where f.status = 'cloture';

revoke all on all tables in schema qbox_export from public, anon, authenticated;
grant usage on schema qbox_export to qbox_lecteur;
grant select on qbox_export.drone_ports, qbox_export.csb, qbox_export.vols to qbox_lecteur;
