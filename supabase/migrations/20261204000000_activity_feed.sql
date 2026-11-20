-- Fil d'activité du tableau de bord : derniers événements (vols, rapports, pièces, batteries, signatures, visites).
-- Périmètre : administrateur = tous les drone ports (ou celui demandé) ; pilote = son drone port.

create or replace function public.activity_feed(p_port uuid default null, p_limit int default 25)
returns table (at timestamptz, kind text, title text, detail text, link text)
language sql stable security definer set search_path = public as $$
  with port as (
    select case when is_admin() then p_port else my_drone_port_id() end as id, is_admin() as admin
  ),
  vis_flights as (
    select f.*, d.code as drone_code, hf.name as dest
    from flights f
    join drones d on d.id = f.drone_id
    left join health_facilities hf on hf.id = f.destination_id
    cross join port
    where (port.admin and port.id is null) or f.drone_port_id = port.id
  ),
  ev as (
    -- vols saisis
    select f.created_at as at, 'vol'::text as kind,
           'Vol saisi · ' || f.drone_code || coalesce(' → ' || f.dest, '') as title,
           to_char(f.flight_date, 'DD/MM') || ' ' || to_char(f.takeoff_time, 'HH24:MI') ||
             case when f.qrf then ' · QRF' else '' end as detail,
           '/vols/' || f.id as link
    from vis_flights f
    union all
    -- vols clôturés
    select f.closed_at, 'cloture', 'Vol clôturé · ' || f.drone_code || coalesce(' → ' || f.dest, ''),
           'CRM disponible', '/vols/' || f.id || '/crm'
    from vis_flights f where f.status = 'cloture' and f.closed_at is not null
    union all
    -- rapports ouverts / clôturés
    select t.created_at, case when t.report_type = 'incident' then 'incident' else 'rapport' end,
           (case when t.report_type = 'incident' then 'Incident' else 'Report technique' end) || ' · ' || f.drone_code,
           coalesce('[' || t.component || '] ', '') || left(t.description, 90), '/vols/' || f.id
    from technical_reports t join vis_flights f on f.id = t.flight_id
    union all
    select t.updated_at, 'rapport_clos', 'Rapport clôturé · ' || f.drone_code,
           coalesce('par ' || t.resolved_by_name || ' · ', '') || left(coalesce(t.corrective_action, ''), 90), '/vols/' || f.id
    from technical_reports t join vis_flights f on f.id = t.flight_id where t.status = 'clos'
    union all
    -- signatures du CRM
    select s.signed_at, 'signature',
           'CRM signé · ' || f.drone_code,
           s.signer_name || ' · ' || case s.kind when 'pilote' then 'commandant de bord' when 'copilote' then 'copilote' else 'mesures correctives' end,
           '/vols/' || f.id || '/crm'
    from crm_signatures s join vis_flights f on f.id = s.flight_id
    union all
    -- mouvements de pièces
    select e.at, 'piece',
           case e.event_type when 'montage' then 'Pièce montée' when 'demontage' then 'Pièce démontée'
                when 'quarantaine' then 'Pièce en quarantaine' when 'transfert' then 'Pièce transférée'
                when 'entree_stock' then 'Entrée en stock' when 'rebut' then 'Pièce mise au rebut' else 'Pièce' end
             || ' · ' || p.code,
           concat_ws(' · ', d.code, nullif(e.reason, '')), '/pieces/' || p.id
    from part_events e
    join parts p on p.id = e.part_id
    left join drones d on d.id = e.drone_id
    cross join port
    where (port.admin and port.id is null) or p.drone_port_id = port.id or e.from_port_id = port.id or e.to_port_id = port.id
    union all
    -- transferts de batteries
    select bt.created_at, 'batterie',
           'Batterie transférée · ' || coalesce(bp.pack_number::text || b.position, b.serial_number),
           coalesce(fp.name, '—') || ' → ' || coalesce(tp.name, '—'), '/batteries/' || b.id
    from battery_transfers bt
    join batteries b on b.id = bt.battery_id
    left join battery_packs bp on bp.id = b.pack_id
    left join drone_ports fp on fp.id = bt.from_port_id
    left join drone_ports tp on tp.id = bt.to_port_id
    cross join port
    where (port.admin and port.id is null) or bt.from_port_id = port.id or bt.to_port_id = port.id
    union all
    -- visites de maintenance
    select v.created_at, 'visite',
           'Visite ' || case v.visit_type when 'systematique' then 'systématique' when 'corrective' then 'corrective' else '' end || ' · ' || d.code,
           'à ' || round(v.hours_at_visit, 1) || ' h' || coalesce(' · ' || v.technician, ''), '/drones/' || d.id
    from maintenance_visits v join drones d on d.id = v.drone_id
    cross join port
    where (port.admin and port.id is null) or d.drone_port_id = port.id
  )
  select at, kind, title, detail, link from ev
  where at is not null and at > now() - interval '60 days'
  order by at desc
  limit greatest(1, least(p_limit, 100));
$$;

revoke all on function public.activity_feed(uuid, int) from public, anon;
grant execute on function public.activity_feed(uuid, int) to authenticated;
comment on function public.activity_feed(uuid, int) is 'Fil d''activité du tableau de bord (60 derniers jours)';
