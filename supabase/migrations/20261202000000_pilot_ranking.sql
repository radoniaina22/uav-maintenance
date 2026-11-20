-- Classement des pilotes par heures de vol (vols clôturés, inscrits au carnet).
-- Périmètre : l'administrateur voit tous les drone ports (ou celui demandé) ;
-- un pilote voit les pilotes de son drone port.
-- p_from / p_to null : heures de carrière (heures antérieures comprises).

create or replace function public.pilot_ranking(p_from date default null, p_to date default null, p_port uuid default null)
returns table (pilot_id uuid, full_name text, license_number text, active boolean, drone_port_id uuid, drone_port_name text,
               has_account boolean, flights bigint, minutes numeric, pic_minutes numeric, copilot_minutes numeric,
               initial_minutes numeric, career_hours numeric, first_flight date, last_flight date)
language sql stable security definer set search_path = public as $$
  with scope as (
    select p.* from pilots p
    where case when is_admin() then (p_port is null or p.drone_port_id = p_port)
               else p.drone_port_id = my_drone_port_id() end
  ),
  career as (
    select l.pilot_id, sum(l.duration_min) as m from logbook_entries l group by l.pilot_id
  ),
  period as (
    select l.pilot_id,
           count(*) as flights,
           sum(l.duration_min) as minutes,
           sum(l.duration_min) filter (where l.role = 'pilote') as pic,
           sum(l.duration_min) filter (where l.role = 'copilote') as cop,
           min(l.entry_date) as first_flight,
           max(l.entry_date) as last_flight
    from logbook_entries l
    where (p_from is null or l.entry_date >= p_from) and (p_to is null or l.entry_date <= p_to)
    group by l.pilot_id
  )
  select s.id, s.full_name, s.license_number, s.active, s.drone_port_id, dp.name,
         exists (select 1 from profiles pr where pr.pilot_id = s.id),
         coalesce(pe.flights, 0),
         coalesce(pe.minutes, 0) + case when p_from is null and p_to is null then s.initial_flight_minutes else 0 end,
         coalesce(pe.pic, 0), coalesce(pe.cop, 0),
         case when p_from is null and p_to is null then s.initial_flight_minutes else 0 end,
         round((s.initial_flight_minutes + coalesce(c.m, 0)) / 60.0, 2),
         pe.first_flight, pe.last_flight
  from scope s
  left join drone_ports dp on dp.id = s.drone_port_id
  left join career c on c.pilot_id = s.id
  left join period pe on pe.pilot_id = s.id
  order by 9 desc, s.full_name;
$$;

revoke all on function public.pilot_ranking(date, date, uuid) from public, anon;
grant execute on function public.pilot_ranking(date, date, uuid) to authenticated;
comment on function public.pilot_ranking(date, date, uuid) is
  'Classement des pilotes par heures de vol (carnet) sur une période, ou en heures de carrière si aucune date';
