-- =====================================================================
-- Reprise de l'ancien registre des pièces (fichiers Excel pièces + historique)
--  * parts.legacy_code : ancien code (numérotation globale MOV000038…), conservé pour
--    la traçabilité et lu par le scan tant que les anciennes étiquettes sont en place
--  * part_events.imported / editor_name : opérations reprises de l'ancien registre,
--    avec le nom de la personne qui les a saisies (sans compte dans l'application)
--  * type CMR (connecteur MR30M) ; sondes de tension (SOT) en pièces multiples
-- =====================================================================

alter table public.parts add column legacy_code text;
alter table public.parts add constraint parts_legacy_code_key unique (legacy_code);
comment on column public.parts.legacy_code is 'Ancien code de la pièce (registre antérieur à l''application, ex. MOV000038)';

alter table public.part_events
  add column imported boolean not null default false,
  add column editor_name text;
comment on column public.part_events.imported is 'Opération reprise de l''ancien registre des pièces';
comment on column public.part_events.editor_name is 'Auteur de l''opération dans l''ancien registre (sans compte utilisateur)';

-- Nouveau type : connecteur MR30M
insert into public.part_types (code, category, name, multi, sort)
values ('CMR', 'Composant électronique', 'Connecteur MR30M', true, 65)
on conflict (code) do nothing;

-- Sondes de tension : plusieurs par drone (2 à 3 sur les Tango 4) -> pièce multiple, sans emplacement unique
update public.part_types set multi = true where code = 'SOT';
update public.part_installations set slot = null where slot = 'SOT';
delete from public.drone_slots where code = 'SOT';

-- L'ancien code ne se modifie pas (sauf administrateur, pour corriger une reprise)
-- (version précédente : 20261125000000_parts.sql)
create or replace function public.parts_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.code is distinct from old.code then raise exception 'Le code d''une pièce ne peut pas être modifié'; end if;
  if new.type_code is distinct from old.type_code then raise exception 'Le type d''une pièce ne peut pas être modifié'; end if;
  if new.legacy_code is distinct from old.legacy_code and auth.uid() is not null and not is_admin() then
    raise exception 'Seul un administrateur peut modifier l''ancien code d''une pièce';
  end if;
  if coalesce(current_setting('app.part_op', true), '') <> 'on'
     and (new.status is distinct from old.status or new.drone_port_id is distinct from old.drone_port_id) then
    raise exception 'Utilisez les actions (monter, démonter, quarantaine, transfert) pour changer le statut ou le drone port d''une pièce';
  end if;
  return new;
end;
$$;

-- Vues recréées pour exposer les nouvelles colonnes (p.* / e.* sont figés à la création)
-- (version précédente : 20261125000000_parts.sql)
drop view if exists public.v_parts;
create view public.v_parts as
select
  p.*,
  t.category,
  t.name as type_name,
  t.multi,
  coalesce(p.max_hours, t.default_max_hours) as max_hours_effective,
  ci.drone_id,
  d.code as drone_code,
  ci.slot,
  ci.zone,
  ci.installed_at,
  ds.label as slot_label,
  dp.name as drone_port_name,
  coalesce(u.flight_count, 0) as flight_count,
  round(p.initial_hours + coalesce(u.flown_min, 0) / 60.0, 2) as total_hours,
  case when coalesce(p.max_hours, t.default_max_hours) is null then null
       else round(100.0 * (p.initial_hours + coalesce(u.flown_min, 0) / 60.0) / coalesce(p.max_hours, t.default_max_hours), 1)
  end as potential_pct
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
where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id());

drop view if exists public.v_part_events;
create view public.v_part_events as
select e.*, p.code as part_code, p.legacy_code as part_legacy_code, p.type_code, t.name as type_name, d.code as drone_code,
       fp.name as from_port_name, tp.name as to_port_name,
       coalesce(nullif(trim(pl.full_name), ''), u.email::text, e.editor_name) as actor_name
from public.part_events e
join public.parts p on p.id = e.part_id
join public.part_types t on t.code = p.type_code
left join public.drones d on d.id = e.drone_id
left join public.drone_ports fp on fp.id = e.from_port_id
left join public.drone_ports tp on tp.id = e.to_port_id
left join auth.users u on u.id = e.created_by
left join public.profiles pr on pr.user_id = e.created_by
left join public.pilots pl on pl.id = pr.pilot_id
where (select public.is_admin())
   or p.drone_port_id = (select public.my_drone_port_id())
   or e.from_port_id = (select public.my_drone_port_id())
   or e.to_port_id = (select public.my_drone_port_id());

revoke all on public.v_parts, public.v_part_events from anon;
grant select on public.v_parts, public.v_part_events to authenticated;
grant select, update on public.parts to authenticated;
grant select on public.part_events to authenticated;
grant select, insert, update on public.part_types to authenticated;
grant select on public.drone_slots, public.part_installations to authenticated;

-- Historique technique du drone : auteur = utilisateur, sinon éditeur de l'ancien registre
-- (version précédente : 20261209100000_drone_history_timezone.sql)
create or replace function public.drone_history(p_drone uuid)
returns table (at timestamptz, category text, event text, title text, detail text, note text,
               severity text, status text, actor text, link text, part_code text, slot_label text, hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  d public.drones;
begin
  select * into d from drones where id = p_drone;
  if not found then raise exception 'Drone introuvable'; end if;
  if not (is_admin() or d.drone_port_id = my_drone_port_id()) then
    raise exception 'Drone non accessible depuis votre drone port' using errcode = '42501';
  end if;

  return query
  with actor as (
    select u.id, coalesce(nullif(trim(p.full_name), ''), u.email::text) as name
    from auth.users u left join profiles pr on pr.user_id = u.id left join pilots p on p.id = pr.pilot_id
  )
  -- pièces : montage, démontage, quarantaine (événements liés à ce drone)
  select e.at at time zone 'Indian/Antananarivo', 'piece'::text, e.event_type,
         case e.event_type when 'montage' then 'Montage' when 'demontage' then 'Démontage'
              when 'quarantaine' then 'Mise en quarantaine' else initcap(replace(e.event_type, '_', ' ')) end
           || ' · ' || p.code,
         t.name || coalesce(' · ' || coalesce(ds.label, e.slot), ''),
         nullif(e.reason, ''), null::text, null::text, coalesce(a.name, e.editor_name), '/pieces/' || p.id, p.code, coalesce(ds.label, e.slot),
         -- heures effectuées sur ce drone pendant la période de montage (au démontage)
         case when e.event_type in ('demontage', 'quarantaine') then (
           select round(sum(flight_minutes(f.takeoff_time, f.landing_time)) / 60.0, 2)
           from part_installations i join flights f on f.drone_id = i.drone_id
             and (f.flight_date + f.takeoff_time) >= i.installed_at and (f.flight_date + f.takeoff_time) < coalesce(i.removed_at, e.at)
           where i.part_id = p.id and i.drone_id = p_drone and i.removed_at is not null
             and abs(extract(epoch from (i.removed_at - e.at))) < 120)
         end
  from part_events e
  join parts p on p.id = e.part_id
  join part_types t on t.code = p.type_code
  left join drone_slots ds on ds.model = d.model and ds.code = e.slot
  left join actor a on a.id = e.created_by
  where e.drone_id = p_drone

  union all
  -- comptes rendus techniques / incidents
  select tr.created_at, 'rapport', tr.report_type,
         (case when tr.report_type = 'incident' then 'Incident' else 'Report technique' end) || coalesce(' · ' || tr.component, ''),
         tr.description,
         'Vol du ' || to_char(f.flight_date, 'DD/MM/YYYY') || ' à ' || to_char(f.takeoff_time, 'HH24:MI'),
         tr.severity, tr.status, a.name, '/vols/' || f.id, null, null, null
  from technical_reports tr
  join flights f on f.id = tr.flight_id
  left join actor a on a.id = tr.created_by
  where f.drone_id = p_drone

  union all
  -- mesures correctives (clôture des rapports)
  select coalesce((tr.resolved_on::timestamp + time '12:00') at time zone 'Indian/Antananarivo', tr.updated_at), 'mesure', tr.report_type,
         'Mesure corrective · ' || coalesce(tr.component, case when tr.report_type = 'incident' then 'incident' else 'report technique' end),
         coalesce(tr.corrective_action, '—'),
         'Constat : ' || left(tr.description, 140),
         tr.severity, tr.status, tr.resolved_by_name, '/vols/' || f.id, null, null, null
  from technical_reports tr
  join flights f on f.id = tr.flight_id
  where f.drone_id = p_drone and tr.status = 'clos'

  union all
  -- visites de maintenance
  select (v.visit_date::timestamp + time '12:00') at time zone 'Indian/Antananarivo', 'visite', v.visit_type,
         'Visite ' || case v.visit_type when 'systematique' then 'systématique' when 'corrective' then 'corrective' else 'de maintenance' end
           || ' · ' || round(v.hours_at_visit, 1) || ' h',
         coalesce(v.work_done, '—'), nullif(v.notes, ''), null, null, v.technician, '/drones/' || p_drone, null, null, v.hours_at_visit
  from maintenance_visits v
  where v.drone_id = p_drone

  order by 1 desc;
end;
$$;


revoke all on function public.drone_history(uuid) from public, anon;
grant execute on function public.drone_history(uuid) to authenticated;
