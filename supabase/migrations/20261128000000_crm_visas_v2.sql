-- Visas du CRM, version 2 :
--  * suppression du rôle « pilote et responsable de maintenance » ;
--  * visas : commandant de bord, copilote (s'il y en a un) et, si le vol a des comptes rendus
--    techniques / incidents, visa du pilote qui a traité les mesures correctives et clôturé les rapports
--    (n'importe quel pilote du drone port, pas forcément de l'équipage).

-- ---------------------------------------------------------------------
-- 1. Rôles : retour à admin / pilote
-- ---------------------------------------------------------------------
update public.profiles set role = 'pilote' where role = 'pilote_maintenance';
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'pilote'));
comment on column public.profiles.role is 'admin : tous les drone ports ; pilote : son drone port';
drop function if exists public.is_maintenance();

-- ---------------------------------------------------------------------
-- 2. Types de visa
-- ---------------------------------------------------------------------
delete from public.crm_signatures where kind = 'maintenance';
alter table public.crm_signatures drop constraint crm_signatures_airworthy;
alter table public.crm_signatures drop column airworthy;
alter table public.crm_signatures drop constraint crm_signatures_kind_check;
alter table public.crm_signatures add constraint crm_signatures_kind_check check (kind in ('pilote', 'copilote', 'rapports'));
comment on column public.crm_signatures.kind is
  'pilote : commandant de bord ; copilote ; rapports : pilote ayant traité les mesures correctives et clôturé les comptes rendus';

-- ---------------------------------------------------------------------
-- 3. Traçabilité de la clôture des rapports
-- ---------------------------------------------------------------------
alter table public.technical_reports
  add column resolved_by uuid references auth.users(id) on delete set null,
  add column resolved_by_name text;
comment on column public.technical_reports.resolved_by_name is 'Pilote ayant clôturé le rapport (nom figé)';

create or replace function public.technical_reports_resolution()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'clos' and coalesce(trim(new.corrective_action), '') = '' then
    raise exception 'Renseignez la mesure corrective avant de clôturer le rapport';
  end if;
  if new.status = 'clos' and (tg_op = 'INSERT' or old.status is distinct from 'clos') then
    new.resolved_on := coalesce(new.resolved_on, current_date);
    new.resolved_by := auth.uid();
    select coalesce(nullif(trim(p.full_name), ''), u.email) into new.resolved_by_name
    from auth.users u
    left join profiles pr on pr.user_id = u.id
    left join pilots p on p.id = pr.pilot_id
    where u.id = auth.uid();
  elsif new.status <> 'clos' then
    new.resolved_on := null;
    new.resolved_by := null;
    new.resolved_by_name := null;
  end if;
  return new;
end;
$$;
create trigger trg_tr_resolution before insert or update of status, corrective_action on public.technical_reports
  for each row execute function public.technical_reports_resolution();

-- Toute modification des rapports après le visa « rapports » l'annule (il faut resigner).
create or replace function public.technical_reports_clear_crm_visa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from crm_signatures
  where kind = 'rapports' and flight_id = coalesce(new.flight_id, old.flight_id);
  if tg_op = 'UPDATE' and new.flight_id <> old.flight_id then
    delete from crm_signatures where kind = 'rapports' and flight_id = old.flight_id;
  end if;
  return null;
end;
$$;
create trigger trg_tr_clear_crm_visa after insert or delete or update of status, description, corrective_action, severity, report_type, component, flight_id
  on public.technical_reports for each row execute function public.technical_reports_clear_crm_visa();

-- ---------------------------------------------------------------------
-- 4. Signature
-- ---------------------------------------------------------------------
drop function if exists public.sign_crm(uuid, text, boolean);

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
  select coalesce(nullif(trim(p.full_name), ''), u.email) into v_name
  from auth.users u left join pilots p on p.id = v_pilot where u.id = auth.uid();

  if p_kind in ('pilote', 'copilote') then
    if not exists (select 1 from flight_pilots fp where fp.flight_id = p_flight and fp.pilot_id = v_pilot and fp.role = p_kind) then
      raise exception '%', case when p_kind = 'pilote' then 'Seul le commandant de bord de ce vol peut signer ce visa'
                                else 'Seul le copilote de ce vol peut signer ce visa' end;
    end if;
  elsif p_kind = 'rapports' then
    if f.drone_port_id is distinct from my_drone_port_id() then
      raise exception 'Seul un pilote du drone port de ce vol peut signer ce visa';
    end if;
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
revoke all on function public.sign_crm(uuid, text) from public, anon;
grant execute on function public.sign_crm(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. CRM à signer (notifications)
-- ---------------------------------------------------------------------
drop function if exists public.my_crm_tasks();

create or replace function public.my_crm_tasks()
returns table (flight_id uuid, kind text, flight_date date, takeoff_time time, closed_at timestamptz,
               drone_code text, destination_name text, flight_seq bigint, report_count bigint, open_reports bigint)
language sql stable security definer set search_path = public as $$
  with me as (
    select pr.pilot_id, p.drone_port_id
    from profiles pr join pilots p on p.id = pr.pilot_id
    where pr.user_id = auth.uid()
  ),
  recent as (
    select f.* from flights f
    where f.status = 'cloture' and f.closed_at > now() - interval '60 days'
  ),
  todo as (
    -- visas de l'équipage
    select f.id, fp.role as kind
    from recent f join flight_pilots fp on fp.flight_id = f.id
    join me on me.pilot_id = fp.pilot_id
    where not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = fp.role)
    union all
    -- comptes rendus à traiter puis viser : tout pilote du drone port
    select f.id, 'rapports'
    from recent f join me on f.drone_port_id = me.drone_port_id
    where exists (select 1 from technical_reports t where t.flight_id = f.id)
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'rapports')
  )
  select f.id, t.kind, f.flight_date, f.takeoff_time, f.closed_at, d.code, hf.name,
         (select count(*) from flights x where x.drone_id = f.drone_id
            and (x.flight_date + x.takeoff_time, x.created_at, x.id) <= (f.flight_date + f.takeoff_time, f.created_at, f.id)),
         (select count(*) from technical_reports tr where tr.flight_id = f.id),
         (select count(*) from technical_reports tr where tr.flight_id = f.id and tr.status <> 'clos')
  from todo t
  join flights f on f.id = t.id
  join drones d on d.id = f.drone_id
  left join health_facilities hf on hf.id = f.destination_id
  order by f.closed_at desc, t.kind;
$$;
revoke all on function public.my_crm_tasks() from public, anon;
grant execute on function public.my_crm_tasks() to authenticated;
