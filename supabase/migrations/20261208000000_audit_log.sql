-- Journal d'audit : qui a créé, modifié ou supprimé quoi, et quand.
-- Un trigger générique enregistre chaque opération sur les tables métier, avec le détail des champs modifiés.

create table public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  actor       text,
  table_name  text not null,
  record_id   text,
  label       text,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changes     jsonb,
  drone_port_id uuid
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_table_idx on public.audit_log (table_name, record_id);
create index audit_log_user_idx on public.audit_log (user_id);

alter table public.audit_log enable row level security;
-- lecture : administrateurs uniquement ; écriture : uniquement par le trigger (security definer)
create policy audit_admin_read on public.audit_log for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.audit_log from anon, authenticated;

-- Nom lisible de l'auteur (fiche pilote, sinon email)
create or replace function public.audit_actor_name(p_user uuid)
returns text language sql stable security definer set search_path = public, auth as $$
  select coalesce(
    (select p.full_name from public.profiles pr join public.pilots p on p.id = pr.pilot_id where pr.user_id = p_user),
    (select email::text from auth.users where id = p_user))
$$;

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  j_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  j     jsonb := coalesce(j_new, j_old);
  diff  jsonb := '{}'::jsonb;
  k     text;
  v_label text;
begin
  -- champs techniques ignorés
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(j_new) loop
      if k in ('updated_at', 'created_at') then continue; end if;
      if (j_old -> k) is distinct from (j_new -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', j_old -> k, 'new', j_new -> k));
      end if;
    end loop;
    if diff = '{}'::jsonb then return new; end if;
  elsif tg_op = 'INSERT' then
    diff := (select coalesce(jsonb_object_agg(key, jsonb_build_object('new', value)), '{}') from jsonb_each(j_new)
             where key not in ('updated_at', 'created_at') and value <> 'null'::jsonb);
  else
    diff := (select coalesce(jsonb_object_agg(key, jsonb_build_object('old', value)), '{}') from jsonb_each(j_old)
             where key not in ('updated_at', 'created_at') and value <> 'null'::jsonb);
  end if;

  v_label := coalesce(j ->> 'number', j ->> 'code', j ->> 'name', j ->> 'full_name', j ->> 'serial_number', j ->> 'title',
                      case when j ? 'flight_date' then 'Vol du ' || to_char((j ->> 'flight_date')::date, 'DD/MM/YYYY') || coalesce(' ' || left(j ->> 'takeoff_time', 5), '') end,
                      case when j ? 'visit_date' then 'Visite du ' || to_char((j ->> 'visit_date')::date, 'DD/MM/YYYY') end,
                      j ->> 'kind', j ->> 'role');

  insert into public.audit_log (user_id, actor, table_name, record_id, label, action, changes, drone_port_id)
  values (auth.uid(), public.audit_actor_name(auth.uid()), tg_table_name,
          coalesce(j ->> 'id', j ->> 'user_id', j ->> 'flight_id'), v_label, tg_op, diff,
          nullif(j ->> 'drone_port_id', '')::uuid);
  return coalesce(new, old);
end;
$$;

-- Tables suivies
do $$
declare t text;
begin
  foreach t in array array[
    'flights', 'flight_pilots', 'technical_reports', 'crm_signatures', 'maintenance_visits',
    'drones', 'pilots', 'profiles', 'drone_ports', 'health_facilities',
    'batteries', 'battery_packs', 'battery_capacity_tests',
    'parts', 'part_types', 'part_stock_thresholds'
  ] loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

comment on table public.audit_log is 'Journal d''audit : opérations sur les tables métier (auteur, date, champs modifiés)';
