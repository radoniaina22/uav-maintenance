-- Classement des drones par nombre de vols et heures de vol.
-- Tous les vols comptent (ouverts et clôturés), comme pour le potentiel du drone.
-- Périmètre : administrateur = tous les drone ports (ou celui demandé) ; pilote = drones de son drone port.
-- p_from / p_to null : carrière (heures antérieures du drone comprises).

create or replace function public.drone_ranking(p_from date default null, p_to date default null, p_port uuid default null)
returns table (drone_id uuid, code text, model text, status text, drone_port_name text,
               flights bigint, deliveries bigint, controls bigint, qrf bigint,
               minutes numeric, delivery_minutes numeric, control_minutes numeric, qrf_minutes numeric, initial_minutes numeric,
               km numeric, kg numeric, career_hours numeric, hours_to_next_visit numeric, last_flight date)
language sql stable security definer set search_path = public as $$
  with scope as (
    select d.* from drones d
    where case when is_admin() then (p_port is null or d.drone_port_id = p_port)
               else d.drone_port_id = my_drone_port_id() end
  ),
  fl as (
    select f.drone_id, f.flight_date, f.flight_type, f.qrf, f.distance_km, f.payload_kg,
           flight_minutes(f.takeoff_time, f.landing_time) as m
    from flights f
  ),
  period as (
    select drone_id,
           count(*) as flights,
           count(*) filter (where flight_type = 'livraison' and not qrf) as deliveries,
           count(*) filter (where flight_type = 'controle' and not qrf) as controls,
           count(*) filter (where qrf) as qrf,
           sum(m) as minutes,
           coalesce(sum(m) filter (where flight_type = 'livraison' and not qrf), 0) as dm,
           coalesce(sum(m) filter (where flight_type = 'controle' and not qrf), 0) as cm,
           coalesce(sum(m) filter (where qrf), 0) as qm,
           coalesce(sum(distance_km), 0) as km,
           coalesce(sum(payload_kg) filter (where flight_type = 'livraison' and not qrf), 0) as kg,
           max(flight_date) as last_flight
    from fl
    where (p_from is null or flight_date >= p_from) and (p_to is null or flight_date <= p_to)
    group by drone_id
  ),
  career as (select drone_id, sum(m) as m from fl group by drone_id)
  select s.id, s.code, s.model, s.status, dp.name,
         coalesce(p.flights, 0), coalesce(p.deliveries, 0), coalesce(p.controls, 0), coalesce(p.qrf, 0),
         coalesce(p.minutes, 0) + case when p_from is null and p_to is null then s.initial_flight_minutes else 0 end,
         coalesce(p.dm, 0), coalesce(p.cm, 0), coalesce(p.qm, 0),
         case when p_from is null and p_to is null then s.initial_flight_minutes else 0 end,
         coalesce(p.km, 0), coalesce(p.kg, 0),
         round((s.initial_flight_minutes + coalesce(c.m, 0)) / 60.0, 2),
         vs.hours_to_next_visit,
         p.last_flight
  from scope s
  left join drone_ports dp on dp.id = s.drone_port_id
  left join period p on p.drone_id = s.id
  left join career c on c.drone_id = s.id
  left join v_drone_status vs on vs.id = s.id
  order by 10 desc, s.code;
$$;

revoke all on function public.drone_ranking(date, date, uuid) from public, anon;
grant execute on function public.drone_ranking(date, date, uuid) to authenticated;
comment on function public.drone_ranking(date, date, uuid) is
  'Classement des drones par vols et heures de vol sur une période, ou en carrière si aucune date';
