-- Inscription libre des pilotes, validée par un administrateur.
-- Le compte créé a le rôle « pilote » (trigger handle_new_user) et reste sans fiche pilote,
-- donc sans accès aux données, jusqu'à sa validation.

-- Drone ports proposés dans le formulaire d'inscription (visiteur non connecté)
create or replace function public.signup_ports()
returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select id, name from public.drone_ports where active order by name
$$;
revoke all on function public.signup_ports() from public;
grant execute on function public.signup_ports() to anon, authenticated;

-- Liste des comptes : ajoute les informations saisies à l'inscription
drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table (user_id uuid, email text, role text, pilot_id uuid, pilot_name text,
               last_sign_in_at timestamptz, created_at timestamptz, signup jsonb)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'Réservé aux administrateurs';
  end if;
  return query
    select u.id, u.email::text, pr.role, pr.pilot_id, p.full_name, u.last_sign_in_at, u.created_at,
           case when u.raw_user_meta_data ? 'full_name' then u.raw_user_meta_data else null end
    from auth.users u
    left join public.profiles pr on pr.user_id = u.id
    left join public.pilots p on p.id = pr.pilot_id
    order by u.email;
end;
$$;
revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- Validation d'une inscription : crée la fiche pilote (ou reprend une fiche existante libre) et la relie au compte
create or replace function public.admin_approve_signup(
  p_user uuid, p_port uuid, p_full_name text, p_license text default null, p_phone text default null, p_existing_pilot uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_pilot uuid;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if not exists (select 1 from public.profiles where user_id = p_user) then raise exception 'Compte introuvable'; end if;
  if exists (select 1 from public.profiles where user_id = p_user and pilot_id is not null) then
    raise exception 'Ce compte est déjà relié à une fiche pilote';
  end if;
  if p_existing_pilot is not null then
    if exists (select 1 from public.profiles where pilot_id = p_existing_pilot) then
      raise exception 'Cette fiche pilote est déjà reliée à un autre compte';
    end if;
    v_pilot := p_existing_pilot;
    update public.pilots set drone_port_id = coalesce(p_port, drone_port_id), active = true where id = v_pilot;
  else
    if nullif(btrim(p_full_name), '') is null then raise exception 'Indiquez le nom du pilote'; end if;
    if p_port is null then raise exception 'Choisissez le drone port du pilote'; end if;
    insert into public.pilots (full_name, license_number, phone, drone_port_id, active)
    values (btrim(p_full_name), nullif(btrim(p_license), ''), nullif(btrim(p_phone), ''), p_port, true)
    returning id into v_pilot;
  end if;
  update public.profiles set pilot_id = v_pilot, role = 'pilote' where user_id = p_user;
  return v_pilot;
end;
$$;
revoke all on function public.admin_approve_signup(uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.admin_approve_signup(uuid, uuid, text, text, text, uuid) to authenticated;

-- Refus d'une inscription : supprime le compte (seulement un pilote sans fiche, jamais soi-même)
create or replace function public.admin_reject_signup(p_user uuid)
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_user = auth.uid() then raise exception 'Vous ne pouvez pas supprimer votre propre compte'; end if;
  if exists (select 1 from public.profiles where user_id = p_user and (role = 'admin' or pilot_id is not null)) then
    raise exception 'Seule une inscription en attente (pilote sans fiche) peut être refusée';
  end if;
  delete from auth.users where id = p_user;
end;
$$;
revoke all on function public.admin_reject_signup(uuid) from public, anon;
grant execute on function public.admin_reject_signup(uuid) to authenticated;

comment on function public.admin_approve_signup(uuid, uuid, text, text, text, uuid) is 'Valide une inscription : fiche pilote créée ou reprise, reliée au compte';
comment on function public.admin_reject_signup(uuid) is 'Refuse une inscription en attente (supprime le compte)';
