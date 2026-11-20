-- =====================================================================
-- Rapports mensuels : destinataires des e-mails
--  * rapport UNFPA     : liste gérée par l'administrateur (table unfpa_recipients)
--  * rapports pilotes  : comptes des pilotes actifs, rattachés au drone port du rapport
--  * rapport admin     : comptes administrateurs
-- (les deux derniers sont déduits des comptes de l'application : fonction report_auto_recipients)
-- =====================================================================

create table public.unfpa_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name  text not null check (btrim(full_name) <> ''),
  job_title  text,
  active     boolean not null default true,
  notes      text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- adresse en minuscules, sans espaces (doublons évités quelle que soit la saisie)
create or replace function public.unfpa_recipients_normalize()
returns trigger language plpgsql set search_path = public as $$
begin
  new.email := lower(btrim(new.email));
  new.full_name := btrim(new.full_name);
  new.job_title := nullif(btrim(new.job_title), '');
  new.notes := nullif(btrim(new.notes), '');
  return new;
end;
$$;
create trigger trg_unfpa_recipients_normalize before insert or update on public.unfpa_recipients
  for each row execute function public.unfpa_recipients_normalize();
create trigger trg_unfpa_recipients_updated before update on public.unfpa_recipients
  for each row execute function public.set_updated_at();
create trigger trg_audit after insert or update or delete on public.unfpa_recipients
  for each row execute function public.audit_trigger();

alter table public.unfpa_recipients enable row level security;
create policy adm_all on public.unfpa_recipients for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.unfpa_recipients from anon, authenticated;
grant select, insert, update, delete on public.unfpa_recipients to authenticated;

comment on table public.unfpa_recipients is 'Destinataires e-mail du rapport mensuel UNFPA (gérés par l''administrateur)';

-- ---------------------------------------------------------------------
-- Destinataires automatiques (rapports pilotes et admin), d'après les comptes
-- ---------------------------------------------------------------------
create or replace function public.report_auto_recipients()
returns table (report text, drone_port_id uuid, drone_port_name text, full_name text, email text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not (public.is_admin() or public.mr_is_service()) then
    raise exception 'Réservé aux administrateurs' using errcode = '42501';
  end if;
  return query
    select 'pilotes'::text, p.drone_port_id, dp.name, p.full_name, u.email::text
    from profiles pr
    join pilots p on p.id = pr.pilot_id
    join drone_ports dp on dp.id = p.drone_port_id
    join auth.users u on u.id = pr.user_id
    where pr.role = 'pilote' and p.active and u.email is not null
    union all
    select 'admin'::text, null::uuid, null::text, coalesce(p.full_name, u.email::text), u.email::text
    from profiles pr
    join auth.users u on u.id = pr.user_id
    left join pilots p on p.id = pr.pilot_id
    where pr.role = 'admin' and u.email is not null
    order by 1, 3, 4;
end;
$$;
revoke all on function public.report_auto_recipients() from public, anon;
grant execute on function public.report_auto_recipients() to authenticated, service_role;
