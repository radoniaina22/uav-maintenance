-- =====================================================================
-- Rapports mensuels, étape 3 : envoi par e-mail (Edge Function send-monthly-reports + Brevo)
--  * report_settings    : envoi automatique activé ou non (désactivé par défaut), URL de la fonction et de l'application
--  * report_dispatches  : journal des envois (un e-mail = une ligne)
--  * pg_cron            : le 1er du mois à 04:00 UTC (07:00 Madagascar) -> mr_dispatch_cron() -> appel HTTP de la fonction
--  * secret partagé pg_cron -> fonction : généré dans Vault (jamais dans le code)
--  * is_admin() : la clé service-role (fonction d'envoi) a les droits administrateur dans les vues et fonctions
-- =====================================================================

-- ---------------------------------------------------------------------
-- is_admin : les appels service-role (Edge Function) voient tout, comme un administrateur
-- (la clé service-role contourne déjà la RLS ; ceci aligne les vues filtrées par is_admin())
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or coalesce((select role = 'admin' from public.profiles where user_id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------
-- Paramètres d'envoi (une seule ligne)
-- ---------------------------------------------------------------------
create table public.report_settings (
  id            boolean primary key default true check (id),
  auto_send     boolean not null default false,
  functions_url text,
  app_url       text,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);
insert into public.report_settings default values;
create trigger trg_report_settings_updated before update on public.report_settings
  for each row execute function public.set_updated_at();
create trigger trg_audit after insert or update or delete on public.report_settings
  for each row execute function public.audit_trigger();

alter table public.report_settings enable row level security;
create policy sel on public.report_settings for select to authenticated using ((select public.is_admin()));
revoke all on public.report_settings from anon, authenticated;
grant select on public.report_settings to authenticated;

create or replace function public.set_report_settings(p_auto_send boolean, p_functions_url text, p_app_url text default null)
returns public.report_settings language plpgsql security definer set search_path = public as $$
declare r public.report_settings;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  if p_auto_send and nullif(btrim(p_functions_url), '') is null then
    raise exception 'Adresse de la fonction d''envoi manquante';
  end if;
  update report_settings set
    auto_send = p_auto_send,
    functions_url = coalesce(nullif(btrim(p_functions_url), ''), functions_url),
    app_url = coalesce(nullif(btrim(p_app_url), ''), app_url),
    updated_by = auth.uid()
  where id
  returning * into r;
  return r;
end;
$$;
revoke all on function public.set_report_settings(boolean, text, text) from public, anon;
grant execute on function public.set_report_settings(boolean, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Journal des envois
-- ---------------------------------------------------------------------
create table public.report_dispatches (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('pilotes', 'admin', 'unfpa')),
  month         date not null,
  drone_port_id uuid references public.drone_ports(id) on delete set null,
  trigger       text not null check (trigger in ('cron', 'manuel', 'validation', 'test')),
  recipients    text[] not null default '{}',
  status        text not null check (status in ('envoye', 'erreur', 'simule')),
  error         text,
  message_id    text,
  subject       text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index report_dispatches_idx on public.report_dispatches (kind, month, drone_port_id, created_at desc);

alter table public.report_dispatches enable row level security;
create policy sel on public.report_dispatches for select to authenticated using ((select public.is_admin()));
revoke all on public.report_dispatches from anon, authenticated;
grant select on public.report_dispatches to authenticated;

comment on table public.report_dispatches is 'Journal des envois des rapports mensuels par e-mail (écrit par la fonction send-monthly-reports)';

-- ---------------------------------------------------------------------
-- Secret partagé pg_cron -> Edge Function (généré dans Vault)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'monthly_reports_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'monthly_reports_cron_secret',
      'Secret partagé entre pg_cron et la fonction send-monthly-reports');
  end if;
end $$;

-- vérification du secret par la fonction d'envoi (clé service-role uniquement)
create or replace function public.mr_cron_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from vault.decrypted_secrets
                 where name = 'monthly_reports_cron_secret' and decrypted_secret = p_secret and length(p_secret) >= 32)
$$;
revoke all on function public.mr_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.mr_cron_secret_ok(text) to service_role;

-- ---------------------------------------------------------------------
-- Tâche mensuelle
-- ---------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.mr_dispatch_cron()
returns bigint language plpgsql security definer set search_path = public as $$
declare
  s public.report_settings;
  v_secret text;
begin
  select * into s from report_settings where id;
  if not coalesce(s.auto_send, false) or s.functions_url is null then
    return null; -- envoi automatique désactivé
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'monthly_reports_cron_secret';
  return net.http_post(
    url := s.functions_url,
    body := jsonb_build_object('mode', 'monthly'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 60000);
end;
$$;
revoke all on function public.mr_dispatch_cron() from public, anon, authenticated;

select cron.schedule('rapports-mensuels', '0 4 1 * *', 'select public.mr_dispatch_cron()');
