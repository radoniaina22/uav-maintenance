-- =====================================================================
-- Rapports mensuels, étape 2 : validation du rapport UNFPA par l'administrateur
--  * brouillon : chiffres calculés à la demande, commentaire « faits marquants » modifiable
--  * validé    : chiffres figés (snapshot) au moment de la validation, commentaire verrouillé
--  * seul un administrateur commente, valide ou rouvre ; écriture uniquement par les fonctions ci-dessous
-- (table générique par type de rapport ; seul le rapport UNFPA est validé pour l'instant)
-- =====================================================================

create table public.monthly_reports (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('unfpa')),
  month             date not null check (month = date_trunc('month', month)::date),
  status            text not null default 'brouillon' check (status in ('brouillon', 'valide')),
  comment           text,
  snapshot          jsonb,
  validated_by      uuid references auth.users(id) on delete set null,
  validated_by_name text,
  validated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (kind, month),
  constraint monthly_reports_validated check (
    (status = 'valide') = (snapshot is not null and validated_at is not null))
);
create trigger trg_monthly_reports_updated before update on public.monthly_reports
  for each row execute function public.set_updated_at();
create trigger trg_audit after insert or update or delete on public.monthly_reports
  for each row execute function public.audit_trigger();

alter table public.monthly_reports enable row level security;
create policy sel on public.monthly_reports for select to authenticated using ((select public.is_admin()));
revoke all on public.monthly_reports from anon, authenticated;
grant select on public.monthly_reports to authenticated;

comment on table public.monthly_reports is
  'Rapports mensuels validés : commentaire « faits marquants » et chiffres figés à la validation (rapport UNFPA)';

-- ---------------------------------------------------------------------
-- Commentaire « faits marquants » (brouillon uniquement)
-- ---------------------------------------------------------------------
create or replace function public.save_monthly_report_comment(p_kind text, p_month date, p_comment text)
returns public.monthly_reports language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  r public.monthly_reports;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  if p_kind is distinct from 'unfpa' then raise exception 'Type de rapport non validable : %', p_kind; end if;
  insert into monthly_reports (kind, month, comment)
  values (p_kind, v_month, nullif(btrim(p_comment), ''))
  on conflict (kind, month) do update set comment = excluded.comment
    where monthly_reports.status = 'brouillon'
  returning * into r;
  if r.id is null then
    raise exception 'Rapport validé : rouvrez-le pour modifier le commentaire';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------
-- Validation : fige les chiffres (mois terminé uniquement)
-- ---------------------------------------------------------------------
create or replace function public.validate_monthly_report(p_kind text, p_month date, p_comment text default null)
returns public.monthly_reports language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  r public.monthly_reports;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  if p_kind is distinct from 'unfpa' then raise exception 'Type de rapport non validable : %', p_kind; end if;
  if v_to >= public.mr_today() then
    raise exception 'Le mois n''est pas terminé : le rapport ne peut être validé qu''à partir du 1er du mois suivant';
  end if;
  if exists (select 1 from monthly_reports where kind = p_kind and month = v_month and status = 'valide') then
    raise exception 'Rapport déjà validé';
  end if;

  insert into monthly_reports (kind, month, status, comment, snapshot, validated_by, validated_by_name, validated_at)
  values (p_kind, v_month, 'valide', nullif(btrim(p_comment), ''), public.monthly_delivery_report(v_month),
          auth.uid(), public.audit_actor_name(auth.uid()), now())
  on conflict (kind, month) do update set
    status = 'valide',
    comment = coalesce(nullif(btrim(p_comment), ''), monthly_reports.comment),
    snapshot = excluded.snapshot,
    validated_by = excluded.validated_by,
    validated_by_name = excluded.validated_by_name,
    validated_at = excluded.validated_at
  returning * into r;
  return r;
end;
$$;

-- ---------------------------------------------------------------------
-- Réouverture : annule la validation (les chiffres redeviennent calculés à la demande)
-- ---------------------------------------------------------------------
create or replace function public.reopen_monthly_report(p_kind text, p_month date)
returns public.monthly_reports language plpgsql security definer set search_path = public as $$
declare r public.monthly_reports;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  update monthly_reports
     set status = 'brouillon', snapshot = null, validated_by = null, validated_by_name = null, validated_at = null
   where kind = p_kind and month = date_trunc('month', p_month)::date and status = 'valide'
  returning * into r;
  if r.id is null then raise exception 'Aucun rapport validé pour ce mois'; end if;
  return r;
end;
$$;

revoke all on function public.save_monthly_report_comment(text, date, text), public.validate_monthly_report(text, date, text),
  public.reopen_monthly_report(text, date) from public, anon;
grant execute on function public.save_monthly_report_comment(text, date, text), public.validate_monthly_report(text, date, text),
  public.reopen_monthly_report(text, date) to authenticated;
