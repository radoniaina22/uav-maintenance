-- =====================================================================
-- Droits explicites sur le schéma public
-- Les projets Supabase récents ne donnent plus de droits par défaut aux rôles anon / authenticated /
-- service_role sur les nouvelles tables (contrairement à la base locale). Les tables dont les migrations
-- n'accordaient pas leurs droits explicitement étaient donc inaccessibles en ligne :
--   journal d'audit, ordres de travail, et tout pour la clé de service (fonction d'envoi des rapports).
-- La sécurité reste assurée par la RLS (policies) et les fonctions security definer.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Clé de service (serveur uniquement : fonction d'envoi des rapports) : tous les droits, comme en local
-- ---------------------------------------------------------------------
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- ---------------------------------------------------------------------
-- Utilisateurs connectés : droits jusqu'ici fournis implicitement par la base locale
-- ---------------------------------------------------------------------
-- journal d'audit : lecture réservée aux administrateurs par la policy audit_admin_read ; écriture par trigger uniquement
grant select on public.audit_log to authenticated;

-- ordres de travail : périmètre et verrous assurés par les policies wo_* / wol_all et les triggers
grant select, insert, update, delete on public.work_orders, public.work_order_links to authenticated;
grant select on public.v_work_orders to authenticated;

-- régions / districts : l'administrateur peut en ajouter (droits de table déjà accordés)
grant usage, select on sequence public.mg_regions_id_seq, public.mg_districts_id_seq to authenticated;
