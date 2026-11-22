-- =====================================================================
-- Alertes par e-mail (Edge Function send-alerts + Brevo)
--  * alert_kinds      : catalogue (mode d'envoi, destinataires, rappel, activation par l'administrateur)
--  * alert_settings   : activation générale, seuils, adresses de la fonction et de l'application
--  * alert_events     : alertes calculées (une ligne par situation ; résolue quand la situation disparaît)
--  * alert_optouts    : alertes que chaque utilisateur ne veut pas recevoir
--  * alert_dispatches : journal des e-mails envoyés
--  * alerts_current() calcule les situations, alerts_refresh() met alert_events à jour,
--    alerts_outbox(mode) donne les alertes à envoyer avec leurs destinataires
--  * pg_cron : alertes immédiates (toutes les 5 min, appel de la fonction seulement s'il y a quelque chose),
--    récapitulatif quotidien 07:00, bilan hebdomadaire lundi 07:15, météo du lendemain 18:00 (heure de Madagascar)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------
create table public.alert_kinds (
  code        text primary key,
  category    text not null check (category in ('maintenance', 'securite', 'suivi')),
  label       text not null,
  description text not null,
  mode        text not null check (mode in ('immediat', 'quotidien', 'hebdomadaire', 'meteo')),
  audience    text not null check (audience in ('port', 'responsables', 'admin', 'personnel')),
  remind_days integer check (remind_days > 0),   -- rappel tant que la situation dure (null = un seul envoi)
  enabled     boolean not null default true,
  sort        integer not null default 0
);

insert into public.alert_kinds (code, category, label, description, mode, audience, remind_days, sort) values
  ('visite_proche',      'maintenance', 'Visite 250 h à prévoir',          'Il reste moins que le seuil d''heures avant la visite systématique du drone', 'quotidien', 'port', 7, 10),
  ('visite_depassee',    'maintenance', 'Visite 250 h dépassée',           'Le compteur du drone a atteint l''échéance de la visite systématique',       'immediat', 'port', 1, 11),
  ('piece_potentiel',    'maintenance', 'Pièce proche du potentiel',       'Pièce montée ayant consommé au moins le seuil de son potentiel',            'quotidien', 'port', 7, 20),
  ('piece_hors_potentiel','maintenance','Pièce au-delà du potentiel',      'Pièce montée ayant dépassé son potentiel',                                  'immediat', 'port', 1, 21),
  ('batterie',           'maintenance', 'Batterie en fin de vie',          'Cycles proches du maximum ou capacité mesurée trop basse',                  'quotidien', 'port', 7, 30),
  ('stock',              'maintenance', 'Stock insuffisant',               'Stock sous le minimum, ou plus aucune pièce de rechange pour un type monté', 'quotidien', 'port', 7, 40),
  ('quarantaine',        'maintenance', 'Pièces en quarantaine sans décision', 'Pièce en quarantaine depuis plus que le délai fixé',                    'hebdomadaire', 'admin', 7, 50),
  ('incident',           'securite',    'Incident déclaré',                'Un incident a été déclaré sur un vol',                                      'immediat', 'responsables', null, 60),
  ('decharge',           'securite',    'Décharge critique d''un pack',    'Tension d''arrivée sous le seuil critique par cellule',                     'immediat', 'port', null, 61),
  ('rapport_ouvert',     'securite',    'Rapport technique non clôturé',   'Rapport ou incident encore ouvert après le délai fixé',                     'quotidien', 'port', 3, 62),
  ('vol_suivi',          'securite',    'Drone en retard ou sans signal',  'Vol suivi en direct : atterrissage en retard ou position plus transmise',  'immediat', 'port', null, 63),
  ('meteo',              'securite',    'Météo défavorable demain',        'Prévision du lendemain au-delà des limites de vol sur le drone port',       'meteo', 'port', null, 64),
  ('crm_a_signer',       'suivi',       'CRM à signer',                    'Visa du CRM manquant après le délai fixé (au pilote concerné)',             'quotidien', 'personnel', 2, 70),
  ('crm_mesures',        'suivi',       'Mesures correctives à viser',     'Visa « mesures correctives » d''un CRM manquant après le délai fixé',       'quotidien', 'responsables', 3, 71),
  ('ordre_travail',      'suivi',       'Ordre de travail en attente',     'Ordre de travail non signé après le délai fixé, ou échéance dépassée',      'quotidien', 'port', 3, 72),
  ('inscription',        'suivi',       'Nouvelle demande d''inscription', 'Un compte attend la validation d''un administrateur',                      'immediat', 'admin', 1, 73),
  ('pilote_inactif',     'suivi',       'Pilote inactif',                  'Aucun vol depuis plus que le délai fixé (maintien des compétences)',        'hebdomadaire', 'admin', 7, 74),
  ('bilan_hebdo',        'suivi',       'Bilan de la semaine',             'Le lundi : vols de la semaine, échéances de la flotte, alertes en cours',   'hebdomadaire', 'port', null, 80);

alter table public.alert_kinds enable row level security;
create policy sel on public.alert_kinds for select to authenticated using (true);
create policy upd on public.alert_kinds for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.alert_kinds from anon;
grant select, update on public.alert_kinds to authenticated;

-- ---------------------------------------------------------------------
-- Paramètres et seuils (une seule ligne)
-- ---------------------------------------------------------------------
create table public.alert_settings (
  id                   boolean primary key default true check (id),
  enabled              boolean not null default false,
  functions_url        text,
  app_url              text,
  visit_warn_hours     numeric(6,1) not null default 25  check (visit_warn_hours > 0),
  part_warn_pct        numeric(5,1) not null default 90  check (part_warn_pct between 1 and 100),
  battery_cycle_pct    numeric(5,1) not null default 90  check (battery_cycle_pct between 1 and 100),
  battery_health_warn  numeric(5,1) not null default 85  check (battery_health_warn between 1 and 100),
  battery_health_danger numeric(5,1) not null default 75 check (battery_health_danger between 1 and 100),
  cell_critical_v      numeric(4,2) not null default 3.30 check (cell_critical_v between 2.5 and 4.2),
  cells                integer not null default 12 check (cells > 0),
  report_open_days     integer not null default 7  check (report_open_days > 0),
  crm_hours            integer not null default 48 check (crm_hours > 0),
  work_order_days      integer not null default 7  check (work_order_days > 0),
  quarantine_days      integer not null default 30 check (quarantine_days > 0),
  pilot_inactive_days  integer not null default 30 check (pilot_inactive_days > 0),
  live_overdue_min     integer not null default 15 check (live_overdue_min > 0),
  live_stale_min       integer not null default 10 check (live_stale_min > 0),
  wind_max_ms          numeric(4,1) not null default 12 check (wind_max_ms > 0),
  gust_max_ms          numeric(4,1) not null default 15 check (gust_max_ms > 0),
  rain_prob_max        integer not null default 60 check (rain_prob_max between 1 and 100),
  updated_by           uuid references auth.users(id) on delete set null,
  updated_at           timestamptz not null default now()
);
insert into public.alert_settings default values;
create trigger trg_alert_settings_updated before update on public.alert_settings
  for each row execute function public.set_updated_at();
create trigger trg_audit after insert or update or delete on public.alert_settings
  for each row execute function public.audit_trigger();

alter table public.alert_settings enable row level security;
create policy sel on public.alert_settings for select to authenticated using (true);
create policy upd on public.alert_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.alert_settings from anon;
grant select on public.alert_settings to authenticated;
grant update (enabled, functions_url, app_url, visit_warn_hours, part_warn_pct, battery_cycle_pct, battery_health_warn,
  battery_health_danger, cell_critical_v, cells, report_open_days, crm_hours, work_order_days, quarantine_days,
  pilot_inactive_days, live_overdue_min, live_stale_min, wind_max_ms, gust_max_ms, rain_prob_max, updated_by)
  on public.alert_settings to authenticated;

-- ---------------------------------------------------------------------
-- Alertes calculées
-- ---------------------------------------------------------------------
create table public.alert_events (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null references public.alert_kinds(code) on delete cascade,
  key           text not null,                 -- identifie la situation (drone, pièce, vol…)
  drone_port_id uuid references public.drone_ports(id) on delete cascade,
  target_user   uuid references auth.users(id) on delete cascade,  -- alertes personnelles
  level         text not null check (level in ('info', 'warn', 'danger')),
  title         text not null,
  detail        text,
  link          text,                          -- chemin dans l'application (#/…)
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  notified_at   timestamptz,
  notify_count  integer not null default 0
);
create unique index alert_events_open_key on public.alert_events(kind, key) where resolved_at is null;
create index alert_events_open_idx on public.alert_events(resolved_at, kind);
create index alert_events_port_idx on public.alert_events(drone_port_id, first_seen_at desc);

alter table public.alert_events enable row level security;
create policy sel on public.alert_events for select to authenticated using (
  (select public.is_admin())
  or target_user = auth.uid()
  or (target_user is null and drone_port_id = (select public.my_drone_port_id())
      and exists (select 1 from public.alert_kinds k where k.code = kind and k.audience in ('port', 'responsables'))));
revoke all on public.alert_events from anon, authenticated;
grant select on public.alert_events to authenticated;

-- Préférences : alertes que l'utilisateur ne veut pas recevoir par e-mail
create table public.alert_optouts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind    text not null references public.alert_kinds(code) on delete cascade,
  primary key (user_id, kind)
);
alter table public.alert_optouts enable row level security;
create policy own on public.alert_optouts for all to authenticated
  using (user_id = auth.uid() or (select public.is_admin())) with check (user_id = auth.uid());
revoke all on public.alert_optouts from anon;
grant select, insert, delete on public.alert_optouts to authenticated;

-- Journal des e-mails d'alerte
create table public.alert_dispatches (
  id          uuid primary key default gen_random_uuid(),
  mode        text not null check (mode in ('immediat', 'quotidien', 'hebdomadaire', 'meteo', 'test')),
  trigger     text not null check (trigger in ('cron', 'manuel', 'test')),
  recipient   text not null,
  alert_count integer not null default 0,
  status      text not null check (status in ('envoye', 'erreur', 'simule')),
  error       text,
  message_id  text,
  subject     text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index alert_dispatches_idx on public.alert_dispatches(created_at desc);
alter table public.alert_dispatches enable row level security;
create policy sel on public.alert_dispatches for select to authenticated using ((select public.is_admin()));
revoke all on public.alert_dispatches from anon, authenticated;
grant select on public.alert_dispatches to authenticated;

grant all on public.alert_kinds, public.alert_settings, public.alert_events, public.alert_optouts, public.alert_dispatches to service_role;

-- Nombre au format français (virgule décimale), indépendant de la configuration du serveur
create or replace function public.fr_num(v numeric, d integer default 1)
returns text language sql immutable set search_path = public as $$
  select case when v is null then null
              else replace(to_char(round(v, d), 'FM9999990' || case when d > 0 then '.' || repeat('0', d) else '' end), '.', ',') end
$$;
grant execute on function public.fr_num(numeric, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Calcul des situations (vue d'ensemble, comme un administrateur)
-- ---------------------------------------------------------------------
create or replace function public.alerts_current()
returns table (kind text, key text, drone_port_id uuid, target_user uuid, level text, title text, detail text, link text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare s public.alert_settings;
begin
  select * into s from alert_settings where id;
  return query
  -- visites 250 h (drones non retirés)
  select case when ds.hours_to_next_visit <= 0 then 'visite_depassee' else 'visite_proche' end,
         ds.id::text, ds.drone_port_id, null::uuid,
         case when ds.hours_to_next_visit <= 0 then 'danger' else 'warn' end,
         case when ds.hours_to_next_visit <= 0
              then 'Visite 250 h dépassée · ' || ds.code
              else 'Visite 250 h à prévoir · ' || ds.code end,
         'Compteur ' || fr_num(ds.total_hours) || ' h, échéance ' || fr_num(ds.next_visit_hours) || ' h'
           || case when ds.hours_to_next_visit <= 0 then ' (dépassée de ' || fr_num(-ds.hours_to_next_visit) || ' h)'
                   else ' : reste ' || fr_num(ds.hours_to_next_visit) || ' h' end
           || coalesce(case when ds.hours_to_next_visit > 0 and r.h_per_day > 0
                then ', soit environ ' || ceil(ds.hours_to_next_visit / r.h_per_day)::int || ' jour(s) au rythme des 30 derniers jours' end, ''),
         '/drones/' || ds.id
  from v_drone_status ds
  left join lateral (
    select sum(flight_minutes(f.takeoff_time, f.landing_time)) / 60.0 / 30 as h_per_day
    from flights f where f.drone_id = ds.id and f.flight_date > current_date - 30
  ) r on true
  where ds.status <> 'retire' and ds.hours_to_next_visit <= s.visit_warn_hours

  union all
  -- pièces montées proches du potentiel / au-delà
  select case when p.potential_pct >= 100 then 'piece_hors_potentiel' else 'piece_potentiel' end,
         p.id::text, p.drone_port_id, null,
         case when p.potential_pct >= 100 then 'danger' else 'warn' end,
         p.code || ' · ' || p.type_name || ' sur ' || p.drone_code,
         fr_num(p.total_hours) || ' h sur ' || fr_num(p.max_hours_effective, 0) || ' h de potentiel ('
           || fr_num(p.potential_pct, 0) || ' %)' || coalesce(', emplacement ' || p.slot_label, ''),
         '/pieces/' || p.id
  from v_parts p
  where p.status = 'monte' and p.potential_pct >= s.part_warn_pct

  union all
  -- batteries en service : cycles ou capacité
  select 'batterie', b.id::text, b.drone_port_id, null,
         case when b.cycle_pct >= 100 or b.health_pct < s.battery_health_danger then 'danger' else 'warn' end,
         'Batterie ' || coalesce(b.code, b.serial_number, '?') || coalesce(' (pack ' || b.pack_number || ')', ''),
         concat_ws(' · ',
           case when b.cycle_pct >= s.battery_cycle_pct then b.total_cycles || ' cycles sur ' || b.max_cycles || ' (' || fr_num(b.cycle_pct, 0) || ' %)' end,
           case when b.health_pct < s.battery_health_warn then 'capacité mesurée ' || fr_num(b.health_pct, 0) || ' % de la nominale le '
                  || to_char(b.last_test_date, 'DD/MM/YYYY') end),
         '/batteries/' || b.id
  from v_battery_status b
  where b.status = 'en_service' and (b.cycle_pct >= s.battery_cycle_pct or b.health_pct < s.battery_health_warn)

  union all
  -- stock : sous le minimum fixé, ou aucune pièce de rechange d'un type monté
  select 'stock', st.port_id || ':' || st.type_code, st.port_id, null,
         case when st.qty = 0 then 'danger' else 'warn' end,
         'Stock ' || t.name || ' · ' || dp.name,
         case when st.min_qty is not null then st.qty || ' en stock pour un minimum de ' || st.min_qty
              else 'Aucune pièce de rechange en stock (' || st.mounted || ' montée(s) sur les drones)' end,
         '/pieces?onglet=stock'
  from (
    select coalesce(th.drone_port_id, m.port_id) as port_id, coalesce(th.type_code, m.type_code) as type_code,
           th.min_qty, coalesce(m.mounted, 0) as mounted,
           (select count(*) from parts x where x.status = 'stock' and x.drone_port_id = coalesce(th.drone_port_id, m.port_id)
              and x.type_code = coalesce(th.type_code, m.type_code))::int as qty
    from part_stock_thresholds th
    full join (
      select p.drone_port_id as port_id, p.type_code, count(*) as mounted
      from parts p join part_types pt on pt.code = p.type_code and not pt.multi
      where p.status = 'monte' group by 1, 2
    ) m on m.port_id = th.drone_port_id and m.type_code = th.type_code
    where th.min_qty is null or th.min_qty > 0
  ) st
  join part_types t on t.code = st.type_code
  join drone_ports dp on dp.id = st.port_id
  where (st.min_qty is not null and st.qty < st.min_qty) or (st.min_qty is null and st.qty = 0)

  union all
  -- pièces en quarantaine depuis longtemps
  select 'quarantaine', p.id::text, p.drone_port_id, null, 'warn',
         p.code || ' · ' || t.name || ' en quarantaine depuis ' || (current_date - q.at::date) || ' jours',
         coalesce('Motif : ' || nullif(q.reason, ''), 'Motif non renseigné') || ' — à remettre en stock ou au rebut',
         '/pieces/' || p.id
  from parts p
  join part_types t on t.code = p.type_code
  join lateral (select e.at, e.reason from part_events e where e.part_id = p.id and e.event_type = 'quarantaine' order by e.at desc limit 1) q on true
  where p.status = 'quarantaine' and q.at < (now() at time zone 'Indian/Antananarivo') - make_interval(days => s.quarantine_days)

  union all
  -- incidents récents
  select 'incident', tr.id::text, f.drone_port_id, null,
         case when tr.severity = 'mineur' then 'warn' else 'danger' end,
         'Incident ' || tr.severity || ' · ' || d.code || coalesce(' · ' || tr.component, ''),
         'Vol du ' || to_char(f.flight_date, 'DD/MM/YYYY') || ' à ' || to_char(f.takeoff_time, 'HH24:MI') || ' : ' || left(tr.description, 300),
         '/vols/' || f.id
  from technical_reports tr
  join flights f on f.id = tr.flight_id
  join drones d on d.id = f.drone_id
  where tr.report_type = 'incident' and tr.created_at > now() - interval '3 days' and not f.imported

  union all
  -- décharge critique
  select 'decharge', f.id::text, f.drone_port_id, null, 'danger',
         'Décharge critique · ' || d.code || coalesce(' · pack ' || bp.pack_number, ''),
         'Arrivée à ' || fr_num(f.voltage_end_v, 2) || ' V (' || fr_num(f.voltage_end_v / s.cells, 2)
           || ' V/cellule) au vol du ' || to_char(f.flight_date, 'DD/MM/YYYY') || ' à ' || to_char(f.takeoff_time, 'HH24:MI')
           || ' : contrôler le pack avant de le réutiliser',
         '/vols/' || f.id
  from flights f
  join drones d on d.id = f.drone_id
  left join battery_packs bp on bp.id = f.battery_pack_id
  where f.voltage_end_v is not null and f.voltage_end_v / s.cells < s.cell_critical_v
    and f.created_at > now() - interval '3 days' and not f.imported

  union all
  -- rapports techniques encore ouverts
  select 'rapport_ouvert', tr.id::text, f.drone_port_id, null,
         case when tr.severity = 'mineur' then 'warn' else 'danger' end,
         (case when tr.report_type = 'incident' then 'Incident' else 'Rapport technique' end) || ' ouvert depuis '
           || (current_date - tr.created_at::date) || ' jours · ' || d.code || coalesce(' · ' || tr.component, ''),
         left(tr.description, 300),
         '/vols/' || f.id
  from technical_reports tr
  join flights f on f.id = tr.flight_id
  join drones d on d.id = f.drone_id
  where tr.status <> 'clos' and tr.created_at < now() - make_interval(days => s.report_open_days) and not f.imported

  union all
  -- vols suivis en direct : retard à l'atterrissage, ou plus de position transmise
  select 'vol_suivi', 'retard:' || lf.user_id || ':' || coalesce(lf.takeoff_at::text, ''), lf.drone_port_id, null, 'danger',
         'Drone en retard · ' || lf.drone_code,
         'Atterrissage prévu à ' || to_char(lf.landing_eta at time zone 'Indian/Antananarivo', 'HH24:MI') || ', non signalé'
           || coalesce(' · pilote ' || lf.pilot_name, '') || coalesce(' · mission ' || lf.mission_name, ''),
         '/planification'
  from live_flights lf
  where lf.status = 'vol' and lf.landing_eta is not null and lf.landing_eta < now() - make_interval(mins => s.live_overdue_min)
  union all
  select 'vol_suivi', 'signal:' || lf.user_id || ':' || coalesce(lf.takeoff_at::text, ''), lf.drone_port_id, null, 'danger',
         'Position plus transmise · ' || lf.drone_code,
         'Dernière position reçue à ' || to_char(lf.updated_at at time zone 'Indian/Antananarivo', 'HH24:MI')
           || coalesce(' · pilote ' || lf.pilot_name, '') || ' : vérifier le vol (page de planification fermée ou réseau perdu)',
         '/planification'
  from live_flights lf
  where lf.status = 'vol' and lf.updated_at < now() - make_interval(mins => s.live_stale_min)

  union all
  -- visas pilote / copilote manquants (au pilote concerné)
  select 'crm_a_signer', f.id || ':' || fp.role, f.drone_port_id, pr.user_id, 'warn',
         'CRM à signer · vol du ' || to_char(f.flight_date, 'DD/MM/YYYY') || ' (' || d.code || ')',
         'Visa ' || case fp.role when 'pilote' then 'commandant de bord' else 'copilote' end || ' manquant, vol clôturé le '
           || to_char(f.closed_at at time zone 'Indian/Antananarivo', 'DD/MM/YYYY à HH24:MI'),
         '/vols/' || f.id || '/crm'
  from flights f
  join drones d on d.id = f.drone_id
  join flight_pilots fp on fp.flight_id = f.id and fp.role in ('pilote', 'copilote')
  join profiles pr on pr.pilot_id = fp.pilot_id
  where f.status = 'cloture' and not f.imported
    and f.closed_at < now() - make_interval(hours => s.crm_hours) and f.closed_at > now() - interval '60 days'
    and not exists (select 1 from crm_signatures cs where cs.flight_id = f.id and cs.kind = fp.role)

  union all
  -- visa « mesures correctives » manquant (vols avec rapport)
  select 'crm_mesures', f.id::text, f.drone_port_id, null, 'warn',
         'Mesures correctives à viser · vol du ' || to_char(f.flight_date, 'DD/MM/YYYY') || ' (' || d.code || ')',
         (select count(*) from technical_reports t where t.flight_id = f.id) || ' rapport(s) sur ce vol, visa « mesures correctives » manquant',
         '/vols/' || f.id || '/crm'
  from flights f
  join drones d on d.id = f.drone_id
  where f.status = 'cloture' and not f.imported
    and f.closed_at < now() - make_interval(hours => s.crm_hours) and f.closed_at > now() - interval '60 days'
    and exists (select 1 from technical_reports t where t.flight_id = f.id)
    and not exists (select 1 from crm_signatures cs where cs.flight_id = f.id and cs.kind = 'rapports')

  union all
  -- ordres de travail non signés
  select 'ordre_travail', w.id::text, w.drone_port_id, null,
         case when w.priority = 'urgente' or w.due_date < current_date then 'danger' else 'warn' end,
         'OT ' || w.number || ' · ' || d.code || ' · ' || w.title,
         'Ouvert le ' || to_char(w.opened_at at time zone 'Indian/Antananarivo', 'DD/MM/YYYY')
           || ', statut ' || replace(w.status, '_', ' ') || ', priorité ' || w.priority
           || coalesce(case when w.due_date < current_date then ', échéance dépassée (' || to_char(w.due_date, 'DD/MM/YYYY') || ')'
                            else ', échéance ' || to_char(w.due_date, 'DD/MM/YYYY') end, ''),
         '/ordres-travail/' || w.id
  from work_orders w
  join drones d on d.id = w.drone_id
  where w.status <> 'cloture'
    and (w.opened_at < now() - make_interval(days => s.work_order_days) or w.due_date < current_date or w.priority = 'urgente')

  union all
  -- comptes en attente de validation
  select 'inscription', u.id::text, null, null, 'info',
         'Demande d''inscription · ' || coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), u.email::text),
         concat_ws(' · ', u.email::text, nullif(u.raw_user_meta_data ->> 'phone', ''),
                   'inscrit le ' || to_char(u.created_at at time zone 'Indian/Antananarivo', 'DD/MM/YYYY à HH24:MI')),
         '/utilisateurs'
  from profiles pr
  join auth.users u on u.id = pr.user_id
  where pr.role = 'pilote' and pr.pilot_id is null

  union all
  -- pilotes actifs sans vol récent
  select 'pilote_inactif', p.id::text, p.drone_port_id, null, 'info',
         p.full_name || coalesce(' · ' || dp.name, ''),
         coalesce('Dernier vol le ' || to_char(lv.last_date, 'DD/MM/YYYY') || ' (il y a ' || (current_date - lv.last_date) || ' jours)', 'Aucun vol enregistré'),
         '/carnet/' || p.id
  from pilots p
  left join drone_ports dp on dp.id = p.drone_port_id
  left join lateral (select max(f.flight_date) as last_date from flight_pilots fp join flights f on f.id = fp.flight_id where fp.pilot_id = p.id) lv on true
  where p.active and p.created_at < now() - make_interval(days => s.pilot_inactive_days)
    and (lv.last_date is null or lv.last_date < current_date - s.pilot_inactive_days);
end;
$$;
revoke all on function public.alerts_current() from public, anon, authenticated;
grant execute on function public.alerts_current() to service_role;

-- vues filtrées par is_admin() : les calculs d'alertes se font comme la clé service-role
create or replace function public.alerts_as_service()
returns void language sql volatile set search_path = public as $$
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
revoke all on function public.alerts_as_service() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Mise à jour des alertes (nouvelles, toujours actives, résolues)
-- ---------------------------------------------------------------------
create or replace function public.alerts_refresh()
returns integer language plpgsql security definer set search_path = public as $$
declare v_new integer;
begin
  perform alerts_as_service();
  create temp table if not exists _alerts_cur (kind text, key text, drone_port_id uuid, target_user uuid, level text, title text, detail text, link text) on commit drop;
  truncate _alerts_cur;
  insert into _alerts_cur select * from alerts_current();

  -- situations disparues : résolues (la météo se résout le lendemain de la date prévue)
  update alert_events e set resolved_at = now()
  where e.resolved_at is null and e.kind <> 'meteo'
    and not exists (select 1 from _alerts_cur c where c.kind = e.kind and c.key = e.key);
  update alert_events e set resolved_at = now()
  where e.resolved_at is null and e.kind = 'meteo' and split_part(e.key, ':', 2)::date < current_date;

  -- situations toujours là : mises à jour ; une aggravation (passage en danger) relance l'envoi
  update alert_events e set
    level = c.level, title = c.title, detail = c.detail, link = c.link, drone_port_id = c.drone_port_id,
    target_user = c.target_user, last_seen_at = now(),
    notified_at = case when c.level = 'danger' and e.level <> 'danger' then null else e.notified_at end
  from _alerts_cur c
  where e.resolved_at is null and e.kind = c.kind and e.key = c.key;

  insert into alert_events (kind, key, drone_port_id, target_user, level, title, detail, link)
  select c.kind, c.key, c.drone_port_id, c.target_user, c.level, c.title, c.detail, c.link
  from _alerts_cur c
  where not exists (select 1 from alert_events e where e.resolved_at is null and e.kind = c.kind and e.key = c.key);
  get diagnostics v_new = row_count;
  return v_new;
end;
$$;
revoke all on function public.alerts_refresh() from public, anon;
grant execute on function public.alerts_refresh() to authenticated, service_role;

-- Prévision défavorable du lendemain (écrite par la fonction send-alerts, qui interroge Open-Meteo)
create or replace function public.alerts_set_weather(p_port uuid, p_date date, p_level text, p_title text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.mr_is_service() then raise exception 'Réservé à la fonction d''envoi' using errcode = '42501'; end if;
  if p_level is null then
    update alert_events set resolved_at = now() where resolved_at is null and kind = 'meteo' and key = p_port || ':' || p_date;
    return;
  end if;
  insert into alert_events (kind, key, drone_port_id, level, title, detail, link)
  values ('meteo', p_port || ':' || p_date, p_port, p_level, p_title, p_detail, '/planification')
  on conflict (kind, key) where resolved_at is null
  do update set level = excluded.level, title = excluded.title, detail = excluded.detail, last_seen_at = now();
end;
$$;
revoke all on function public.alerts_set_weather(uuid, date, text, text, text) from public, anon, authenticated;
grant execute on function public.alerts_set_weather(uuid, date, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Destinataires et boîte d'envoi
-- ---------------------------------------------------------------------
-- comptes pouvant recevoir des alertes
create or replace function public.alert_accounts()
returns table (user_id uuid, email text, full_name text, is_admin boolean, drone_port_id uuid, maintenance_lead boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.email::text, coalesce(nullif(trim(p.full_name), ''), u.email::text), pr.role = 'admin',
         p.drone_port_id, coalesce(p.maintenance_lead, false)
  from profiles pr
  join auth.users u on u.id = pr.user_id
  left join pilots p on p.id = pr.pilot_id
  where u.email is not null and (pr.role = 'admin' or (p.id is not null and p.active))
$$;
revoke all on function public.alert_accounts() from public, anon, authenticated;
grant execute on function public.alert_accounts() to service_role;

-- alertes à envoyer pour un mode (une ligne par alerte et par destinataire), préférences comprises
--   immediat     : alertes immédiates jamais envoyées
--   quotidien    : alertes immédiates et quotidiennes nouvelles, ou à rappeler
--   hebdomadaire : alertes hebdomadaires nouvelles ou à rappeler
--   meteo        : prévisions défavorables jamais envoyées
--   tout         : toutes les alertes en cours (aperçu de test)
create or replace function public.alerts_outbox(p_mode text, p_only_user uuid default null)
returns table (event_id uuid, kind text, kind_label text, category text, level text, title text, detail text, link text,
               drone_port_id uuid, drone_port_name text, first_seen_at timestamptz, reminder boolean,
               user_id uuid, email text, full_name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.kind, k.label, k.category, e.level, e.title, e.detail, e.link, e.drone_port_id, dp.name, e.first_seen_at,
         e.notified_at is not null, a.user_id, a.email, a.full_name
  from alert_events e
  join alert_kinds k on k.code = e.kind
  left join drone_ports dp on dp.id = e.drone_port_id
  join alert_accounts() a on
       (k.audience = 'personnel' and a.user_id = e.target_user)
    or (k.audience = 'admin' and a.is_admin)
    or (k.audience = 'port' and (a.is_admin or a.drone_port_id = e.drone_port_id))
    or (k.audience = 'responsables' and (a.is_admin or (a.maintenance_lead and a.drone_port_id = e.drone_port_id)))
  where e.resolved_at is null and k.enabled and k.code <> 'bilan_hebdo'
    and (p_only_user is null or a.user_id = p_only_user)
    and not exists (select 1 from alert_optouts o where o.user_id = a.user_id and o.kind = e.kind)
    and case p_mode
      when 'tout' then true
      when 'immediat' then k.mode = 'immediat' and e.notified_at is null
      when 'quotidien' then k.mode in ('immediat', 'quotidien')
        and (e.notified_at is null or (k.remind_days is not null and e.notified_at < now() - make_interval(days => k.remind_days) + interval '2 hours'))
      when 'hebdomadaire' then k.mode = 'hebdomadaire'
        and (e.notified_at is null or (k.remind_days is not null and e.notified_at < now() - make_interval(days => k.remind_days) + interval '2 hours'))
      when 'meteo' then k.mode = 'meteo' and e.notified_at is null
      else false end
  order by a.email, k.category, case e.level when 'danger' then 0 when 'warn' then 1 else 2 end, k.sort, e.title
$$;
revoke all on function public.alerts_outbox(text, uuid) from public, anon, authenticated;
grant execute on function public.alerts_outbox(text, uuid) to service_role;

create or replace function public.alerts_mark_notified(p_ids uuid[])
returns void language sql security definer set search_path = public as $$
  update alert_events set notified_at = now(), notify_count = notify_count + 1 where id = any(p_ids)
$$;
revoke all on function public.alerts_mark_notified(uuid[]) from public, anon, authenticated;
grant execute on function public.alerts_mark_notified(uuid[]) to service_role;

-- destinataires du bilan hebdomadaire (administrateurs : tous les drone ports ; pilotes : le leur)
create or replace function public.alerts_digest_recipients(p_only_user uuid default null)
returns table (user_id uuid, email text, full_name text, is_admin boolean, drone_port_id uuid)
language sql stable security definer set search_path = public as $$
  select a.user_id, a.email, a.full_name, a.is_admin, a.drone_port_id
  from alert_accounts() a
  where (select enabled from alert_kinds where code = 'bilan_hebdo')
    and (p_only_user is null or a.user_id = p_only_user)
    and not exists (select 1 from alert_optouts o where o.user_id = a.user_id and o.kind = 'bilan_hebdo')
    and (a.is_admin or a.drone_port_id is not null)
$$;
revoke all on function public.alerts_digest_recipients(uuid) from public, anon, authenticated;
grant execute on function public.alerts_digest_recipients(uuid) to service_role;

-- Bilan des 7 derniers jours par drone port
create or replace function public.alerts_weekly_summary()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v jsonb;
begin
  perform alerts_as_service();
  select coalesce(jsonb_agg(x order by x ->> 'port_name'), '[]') into v from (
    select jsonb_build_object(
      'port_id', dp.id, 'port_name', dp.name,
      'from', current_date - 7, 'to', current_date - 1,
      'flights', (select count(*) from flights f where f.drone_port_id = dp.id and f.flight_date between current_date - 7 and current_date - 1),
      'hours', (select round(coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)), 0) / 60.0, 1) from flights f
                where f.drone_port_id = dp.id and f.flight_date between current_date - 7 and current_date - 1),
      'payload_kg', (select round(coalesce(sum(f.payload_kg) filter (where not f.qrf), 0), 1) from flights f
                where f.drone_port_id = dp.id and f.flight_date between current_date - 7 and current_date - 1),
      'qrf', (select count(*) from flights f where f.drone_port_id = dp.id and f.qrf and f.flight_date between current_date - 7 and current_date - 1),
      'incidents', (select count(*) from technical_reports tr join flights f on f.id = tr.flight_id
                where f.drone_port_id = dp.id and tr.report_type = 'incident' and f.flight_date between current_date - 7 and current_date - 1),
      'drones', (select coalesce(jsonb_agg(jsonb_build_object('id', ds.id, 'code', ds.code, 'status', ds.status, 'total_hours', ds.total_hours,
                   'next_visit_hours', ds.next_visit_hours, 'hours_to_next_visit', ds.hours_to_next_visit,
                   'week_hours', (select round(coalesce(sum(flight_minutes(f.takeoff_time, f.landing_time)), 0) / 60.0, 1) from flights f
                                  where f.drone_id = ds.id and f.flight_date between current_date - 7 and current_date - 1)) order by ds.code), '[]')
                 from v_drone_status ds where ds.drone_port_id = dp.id and ds.status <> 'retire'),
      'alerts', (select jsonb_build_object('danger', count(*) filter (where e.level = 'danger'), 'warn', count(*) filter (where e.level = 'warn'),
                   'info', count(*) filter (where e.level = 'info'))
                 from alert_events e join alert_kinds k on k.code = e.kind
                 where e.resolved_at is null and e.drone_port_id = dp.id and k.audience <> 'personnel')
    ) as x
    from drone_ports dp where dp.active
  ) t;
  return v;
end;
$$;
revoke all on function public.alerts_weekly_summary() from public, anon, authenticated;
grant execute on function public.alerts_weekly_summary() to service_role;

-- ---------------------------------------------------------------------
-- Réglages (administrateur)
-- ---------------------------------------------------------------------
create or replace function public.set_alert_settings(p_enabled boolean, p_functions_url text, p_app_url text default null)
returns public.alert_settings language plpgsql security definer set search_path = public as $$
declare r public.alert_settings;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  if p_enabled and nullif(btrim(p_functions_url), '') is null then
    raise exception 'Adresse de la fonction d''envoi manquante';
  end if;
  update alert_settings set
    enabled = p_enabled,
    functions_url = coalesce(nullif(btrim(p_functions_url), ''), functions_url),
    app_url = coalesce(nullif(btrim(p_app_url), ''), app_url),
    updated_by = auth.uid()
  where id returning * into r;
  return r;
end;
$$;
revoke all on function public.set_alert_settings(boolean, text, text) from public, anon;
grant execute on function public.set_alert_settings(boolean, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Tâches planifiées
-- ---------------------------------------------------------------------
create or replace function public.alerts_dispatch_cron(p_mode text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  s public.alert_settings;
  v_secret text;
begin
  select * into s from alert_settings where id;
  if not s.enabled or s.functions_url is null then return null; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'monthly_reports_cron_secret';
  return net.http_post(
    url := s.functions_url,
    body := jsonb_build_object('mode', p_mode),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 60000);
end;
$$;
revoke all on function public.alerts_dispatch_cron(text) from public, anon, authenticated;

-- toutes les 5 minutes : mise à jour des alertes, appel de la fonction seulement si une alerte immédiate attend
create or replace function public.alerts_tick()
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not (select enabled from alert_settings where id) then return null; end if;
  perform alerts_refresh();
  if exists (select 1 from alerts_outbox('immediat')) then
    return alerts_dispatch_cron('immediat');
  end if;
  return null;
end;
$$;
revoke all on function public.alerts_tick() from public, anon, authenticated;

select cron.schedule('alertes-immediates', '*/5 * * * *', 'select public.alerts_tick()');
select cron.schedule('alertes-quotidiennes', '0 4 * * *', $$select public.alerts_dispatch_cron('quotidien')$$);
select cron.schedule('alertes-hebdomadaires', '15 4 * * 1', $$select public.alerts_dispatch_cron('hebdomadaire')$$);
select cron.schedule('alertes-meteo', '0 15 * * *', $$select public.alerts_dispatch_cron('meteo')$$);

comment on table public.alert_events is 'Alertes calculées (alerts_refresh) et envoyées par e-mail par la fonction send-alerts';
