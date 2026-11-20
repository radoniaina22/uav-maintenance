-- Rôle « pilote et responsable de maintenance », signature électronique du CRM
-- et liste des CRM à signer (notifications).

-- ---------------------------------------------------------------------
-- 1. Nouveau rôle
-- ---------------------------------------------------------------------
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'pilote', 'pilote_maintenance'));

comment on column public.profiles.role is
  'admin : tous les drone ports ; pilote : son drone port ; pilote_maintenance : pilote + responsable de maintenance de son drone port (vise les CRM)';

create or replace function public.is_maintenance()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'pilote_maintenance' from public.profiles where user_id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------
-- 2. Signatures du CRM
-- ---------------------------------------------------------------------
create table public.crm_signatures (
  id          uuid primary key default gen_random_uuid(),
  flight_id   uuid not null references public.flights(id) on delete cascade,
  kind        text not null check (kind in ('pilote', 'maintenance')),
  user_id     uuid references auth.users(id) on delete set null,
  signer_name text not null,
  airworthy   boolean,
  signed_at   timestamptz not null default now(),
  unique (flight_id, kind),
  constraint crm_signatures_airworthy check ((kind = 'maintenance') = (airworthy is not null))
);
comment on table public.crm_signatures is 'Visas électroniques du compte rendu matériel (pilote commandant de bord, responsable de maintenance)';
comment on column public.crm_signatures.signer_name is 'Nom complet au moment de la signature (figé)';
comment on column public.crm_signatures.airworthy is 'Décision du responsable de maintenance : apte (true) / inapte (false) au vol';

alter table public.crm_signatures enable row level security;
create policy crm_signatures_select on public.crm_signatures for select to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id
                 and ((select public.is_admin()) or f.drone_port_id = (select public.my_drone_port_id()))));
-- écriture uniquement via les fonctions ci-dessous
grant select on public.crm_signatures to authenticated;

create or replace function public.sign_crm(p_flight uuid, p_kind text, p_airworthy boolean default null)
returns public.crm_signatures
language plpgsql security definer set search_path = public as $$
declare
  f public.flights;
  v_pilot uuid;
  v_name text;
  r public.crm_signatures;
begin
  select * into f from flights where id = p_flight;
  if not found then raise exception 'Vol introuvable'; end if;
  if f.status <> 'cloture' then raise exception 'Le vol doit être clôturé avant de signer le CRM'; end if;

  select pr.pilot_id into v_pilot from profiles pr where pr.user_id = auth.uid();
  select coalesce(nullif(trim(p.full_name), ''), u.email) into v_name
  from auth.users u left join pilots p on p.id = v_pilot where u.id = auth.uid();

  if p_kind = 'pilote' then
    if v_pilot is null or not exists (select 1 from flight_pilots fp
        where fp.flight_id = p_flight and fp.pilot_id = v_pilot and fp.role = 'pilote') then
      raise exception 'Seul le pilote commandant de bord de ce vol peut signer ce visa';
    end if;
    p_airworthy := null;
  elsif p_kind = 'maintenance' then
    if not is_maintenance() then
      raise exception 'Seul un responsable de maintenance peut signer ce visa';
    end if;
    if f.drone_port_id is distinct from my_drone_port_id() then
      raise exception 'Ce vol ne dépend pas de votre drone port';
    end if;
    if p_airworthy is null then raise exception 'Indiquez si l''aéronef est apte ou inapte au vol'; end if;
  else
    raise exception 'Type de visa inconnu : %', p_kind;
  end if;

  insert into crm_signatures (flight_id, kind, user_id, signer_name, airworthy)
  values (p_flight, p_kind, auth.uid(), v_name, p_airworthy)
  returning * into r;
  return r;
exception when unique_violation then
  raise exception 'Ce visa est déjà signé';
end;
$$;

create or replace function public.unsign_crm(p_flight uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from crm_signatures
  where flight_id = p_flight and kind = p_kind and (user_id = auth.uid() or is_admin());
  if not found then raise exception 'Signature introuvable, ou vous n''en êtes pas l''auteur'; end if;
end;
$$;

revoke all on function public.sign_crm(uuid, text, boolean) from public, anon;
revoke all on function public.unsign_crm(uuid, text) from public, anon;
grant execute on function public.sign_crm(uuid, text, boolean) to authenticated;
grant execute on function public.unsign_crm(uuid, text) to authenticated;

-- Réouverture d'un vol : les données peuvent changer, les visas sont annulés.
create or replace function public.flights_clear_crm_signatures()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'cloture' and new.status = 'ouvert' then
    delete from crm_signatures where flight_id = new.id;
  end if;
  return new;
end;
$$;
create trigger trg_flights_clear_crm_signatures after update of status on public.flights
  for each row execute function public.flights_clear_crm_signatures();

-- ---------------------------------------------------------------------
-- 3. CRM à signer par l'utilisateur connecté (notifications)
--    Vols clôturés depuis moins de 60 jours.
-- ---------------------------------------------------------------------
create or replace function public.my_crm_tasks()
returns table (flight_id uuid, kind text, flight_date date, takeoff_time time, closed_at timestamptz,
               drone_code text, destination_name text, flight_seq bigint, pilot_signed boolean)
language sql stable security definer set search_path = public as $$
  with me as (
    select pr.role, pr.pilot_id, p.drone_port_id
    from profiles pr left join pilots p on p.id = pr.pilot_id
    where pr.user_id = auth.uid()
  ),
  todo as (
    -- visa pilote : vols dont je suis commandant de bord
    select f.id, 'pilote'::text as kind
    from flights f join flight_pilots fp on fp.flight_id = f.id and fp.role = 'pilote'
    join me on me.pilot_id = fp.pilot_id
    where f.status = 'cloture' and f.closed_at > now() - interval '60 days'
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'pilote')
    union all
    -- visa maintenance : vols de mon drone port
    select f.id, 'maintenance'
    from flights f join me on me.role = 'pilote_maintenance' and f.drone_port_id = me.drone_port_id
    where f.status = 'cloture' and f.closed_at > now() - interval '60 days'
      and not exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'maintenance')
  )
  select f.id, t.kind, f.flight_date, f.takeoff_time, f.closed_at, d.code, hf.name,
         (select count(*) from flights x where x.drone_id = f.drone_id
            and (x.flight_date + x.takeoff_time, x.created_at, x.id) <= (f.flight_date + f.takeoff_time, f.created_at, f.id)),
         exists (select 1 from crm_signatures s where s.flight_id = f.id and s.kind = 'pilote')
  from todo t
  join flights f on f.id = t.id
  join drones d on d.id = f.drone_id
  left join health_facilities hf on hf.id = f.destination_id
  order by f.closed_at desc;
$$;
revoke all on function public.my_crm_tasks() from public, anon;
grant execute on function public.my_crm_tasks() to authenticated;
