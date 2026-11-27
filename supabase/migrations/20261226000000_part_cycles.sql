-- =====================================================================
-- Potentiel des pièces en cycles (moteurs VTOL)
--  * 1 cycle = 1 décollage + 1 atterrissage = 1 vol effectué pendant le montage
--  * part_types.default_max_cycles : potentiel par défaut du type (cycles)
--  * parts.max_cycles : potentiel propre à la pièce ; parts.initial_cycles : cycles avant suivi
--  * v_parts : total_cycles, max_cycles_effective, hours_pct, cycle_pct ;
--    potential_pct = le plus élevé des deux (heures / cycles), lu par les alertes,
--    le tableau de bord et les rapports mensuels
-- =====================================================================

alter table public.part_types add column default_max_cycles integer check (default_max_cycles > 0);
comment on column public.part_types.default_max_cycles is 'Potentiel par défaut en cycles (1 cycle = 1 décollage + 1 atterrissage)';

alter table public.parts
  add column max_cycles integer check (max_cycles > 0),
  add column initial_cycles integer not null default 0 check (initial_cycles >= 0);
comment on column public.parts.max_cycles is 'Potentiel propre à la pièce en cycles (sinon celui du type)';
comment on column public.parts.initial_cycles is 'Cycles effectués avant le suivi dans l''application';

-- (version précédente : 20261223000000_parts_legacy_codes.sql)
drop view if exists public.v_parts;
create view public.v_parts as
select
  x.*,
  case when x.max_hours_effective is null then null
       else round(100.0 * x.total_hours / x.max_hours_effective, 1) end as hours_pct,
  case when x.max_cycles_effective is null then null
       else round(100.0 * x.total_cycles / x.max_cycles_effective, 1) end as cycle_pct,
  -- greatest() ignore les null : potentiel défini par l'un, l'autre ou les deux
  greatest(case when x.max_hours_effective is null then null else round(100.0 * x.total_hours / x.max_hours_effective, 1) end,
           case when x.max_cycles_effective is null then null else round(100.0 * x.total_cycles / x.max_cycles_effective, 1) end) as potential_pct
from (
  select
    p.*,
    t.category,
    t.name as type_name,
    t.multi,
    coalesce(p.max_hours, t.default_max_hours) as max_hours_effective,
    coalesce(p.max_cycles, t.default_max_cycles) as max_cycles_effective,
    ci.drone_id,
    d.code as drone_code,
    ci.slot,
    ci.zone,
    ci.installed_at,
    ds.label as slot_label,
    dp.name as drone_port_name,
    coalesce(u.flight_count, 0) as flight_count,
    round(p.initial_hours + coalesce(u.flown_min, 0) / 60.0, 2) as total_hours,
    p.initial_cycles + coalesce(u.flight_count, 0)::integer as total_cycles
  from public.parts p
  join public.part_types t on t.code = p.type_code
  left join public.part_installations ci on ci.part_id = p.id and ci.removed_at is null
  left join public.drones d on d.id = ci.drone_id
  left join public.drone_slots ds on ds.model = d.model and ds.code = ci.slot
  left join public.drone_ports dp on dp.id = p.drone_port_id
  left join lateral (
    select count(f.id) as flight_count, sum(public.flight_minutes(f.takeoff_time, f.landing_time)) as flown_min
    from public.part_installations i
    join public.flights f on f.drone_id = i.drone_id
     and (f.flight_date + f.takeoff_time) >= i.installed_at
     and (i.removed_at is null or (f.flight_date + f.takeoff_time) < i.removed_at)
    where i.part_id = p.id
  ) u on true
  where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id())
) x;

revoke all on public.v_parts from anon;
grant select on public.v_parts to authenticated;
grant select, update on public.parts to authenticated;
grant select, insert, update on public.part_types to authenticated;

-- Alertes : le texte des pièces indique les heures et/ou les cycles
-- (version précédente : 20261224000000_email_alerts.sql)
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
         concat_ws(' ; ',
           case when p.max_hours_effective is not null then
             fr_num(p.total_hours) || ' h sur ' || fr_num(p.max_hours_effective, 0) || ' h de potentiel (' || fr_num(p.hours_pct, 0) || ' %)' end,
           case when p.max_cycles_effective is not null then
             p.total_cycles || ' cycles sur ' || p.max_cycles_effective || ' (' || fr_num(p.cycle_pct, 0) || ' %)' end)
           || coalesce(', emplacement ' || p.slot_label, ''),
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
