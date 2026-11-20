-- Historique technique : les heures des mouvements de pièces (timestamp en heure de Madagascar)
-- étaient interprétées comme UTC, d'où un décalage de +3 h à l'affichage. Même correction pour les dates de visite et de clôture.
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
         nullif(e.reason, ''), null::text, null::text, a.name, '/pieces/' || p.id, p.code, coalesce(ds.label, e.slot),
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

