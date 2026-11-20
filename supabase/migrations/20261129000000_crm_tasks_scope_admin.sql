-- Notifications du CRM :
--  * les demandes de signature ne concernent que les pilotes du drone port du vol ;
--  * l'administrateur est notifié des comptes rendus techniques / incidents de tous les drone ports
--    tant qu'ils ne sont pas traités et visés (« suivi »).

-- ---------------------------------------------------------------------
-- 1. Signature : l'équipage doit aussi appartenir au drone port du vol
-- ---------------------------------------------------------------------
create or replace function public.sign_crm(p_flight uuid, p_kind text)
returns public.crm_signatures
language plpgsql security definer set search_path = public as $$
declare
  f public.flights;
  v_pilot uuid;
  v_name text;
  v_reports int;
  v_open int;
  r public.crm_signatures;
begin
  select * into f from flights where id = p_flight;
  if not found then raise exception 'Vol introuvable'; end if;
  if f.status <> 'cloture' then raise exception 'Le vol doit être clôturé avant de signer le CRM'; end if;

  select pr.pilot_id into v_pilot from profiles pr where pr.user_id = auth.uid();
  if v_pilot is null then raise exception 'Votre compte n''est relié à aucune fiche pilote'; end if;
  if f.drone_port_id is distinct from my_drone_port_id() then
    raise exception 'Seul un pilote du drone port de ce vol peut signer son CRM';
  end if;
  select coalesce(nullif(trim(p.full_name), ''), u.email) into v_name
  from auth.users u left join pilots p on p.id = v_pilot where u.id = auth.uid();

  if p_kind in ('pilote', 'copilote') then
    if not exists (select 1 from flight_pilots fp where fp.flight_id = p_flight and fp.pilot_id = v_pilot and fp.role = p_kind) then
      raise exception '%', case when p_kind = 'pilote' then 'Seul le commandant de bord de ce vol peut signer ce visa'
                                else 'Seul le copilote de ce vol peut signer ce visa' end;
    end if;
  elsif p_kind = 'rapports' then
    select count(*), count(*) filter (where status <> 'clos') into v_reports, v_open
    from technical_reports where flight_id = p_flight;
    if v_reports = 0 then raise exception 'Ce vol n''a aucun compte rendu technique ou incident'; end if;
    if v_open > 0 then raise exception 'Clôturez d''abord les % compte(s) rendu(s) encore ouvert(s)', v_open; end if;
  else
    raise exception 'Type de visa inconnu : %', p_kind;
  end if;

  insert into crm_signatures (flight_id, kind, user_id, signer_name)
  values (p_flight, p_kind, auth.uid(), v_name)
  returning * into r;
  return r;
exception when unique_violation then
  raise exception 'Ce visa est déjà signé';
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Tâches / notifications
--    kind : pilote | copilote | rapports (à signer) ; suivi (administrateur, information)
-- ---------------------------------------------------------------------
drop function if exists public.my_crm_tasks();

create or replace function public.my_crm_tasks()
returns table (flight_id uuid, kind text, flight_date date, takeoff_time time, closed_at timestamptz,
               flight_status text, drone_code text, drone_port_name text, destination_name text,
               flight_seq bigint, report_count bigint, open_reports bigint)
language sql stable security definer set search_path = public as $$
  with me as (
    select pr.role, pr.pilot_id, p.drone_port_id
    from profiles pr left join pilots p on p.id = pr.pilot_id
    where pr.user_id = auth.uid()
  ),
  recent as (
    select f.* from flights f
    where f.status = 'cloture' and f.closed_at > now() - interval '60 days'
  ),
  todo as (
    -- visas de l'équipage : uniquement si le pilote est du drone port du vol
    select f.id, fp.role as kind
    from recent f
    join flight_pilots fp on fp.flight_id = f.id
    join me on me.pilot_id = fp.pilot_id and me.drone_port_id = f.drone_port_id
    where not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = fp.role)
    union all
    -- comptes rendus à traiter puis viser : pilotes du drone port du vol
    select f.id, 'rapports'
    from recent f join me on me.pilot_id is not null and me.drone_port_id = f.drone_port_id
    where exists (select 1 from technical_reports t where t.flight_id = f.id)
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports')
    union all
    -- administrateur : comptes rendus de tous les drone ports non encore traités et visés
    -- (vols ouverts ou clôturés, des 60 derniers jours)
    select f.id, 'suivi'
    from flights f join me on me.role = 'admin'
    where f.flight_date > current_date - 60
      and exists (select 1 from technical_reports t where t.flight_id = f.id)
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports')
  )
  select f.id, t.kind, f.flight_date, f.takeoff_time, f.closed_at, f.status, d.code, dp.name, hf.name,
         (select count(*) from flights x where x.drone_id = f.drone_id
            and (x.flight_date + x.takeoff_time, x.created_at, x.id) <= (f.flight_date + f.takeoff_time, f.created_at, f.id)),
         (select count(*) from technical_reports tr where tr.flight_id = f.id),
         (select count(*) from technical_reports tr where tr.flight_id = f.id and tr.status <> 'clos')
  from todo t
  join flights f on f.id = t.id
  join drones d on d.id = f.drone_id
  left join drone_ports dp on dp.id = f.drone_port_id
  left join health_facilities hf on hf.id = f.destination_id
  order by coalesce(f.closed_at, f.created_at) desc, t.kind;
$$;
revoke all on function public.my_crm_tasks() from public, anon;
grant execute on function public.my_crm_tasks() to authenticated;
