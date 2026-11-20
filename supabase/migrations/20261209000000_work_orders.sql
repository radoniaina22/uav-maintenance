-- Ordres de travail (OT) : regroupent les visites, comptes rendus et mouvements de pièces d'une intervention
-- sur un drone, et sont signés par le responsable maintenance (pilote du drone port ou administrateur).

create table public.work_orders (
  id               uuid primary key default gen_random_uuid(),
  number           text unique,
  drone_id         uuid not null references public.drones(id) on delete restrict,
  drone_port_id    uuid references public.drone_ports(id) on delete set null,
  title            text not null check (btrim(title) <> ''),
  kind             text not null default 'corrective' check (kind in ('visite', 'corrective', 'remplacement', 'inspection', 'autre')),
  priority         text not null default 'normale' check (priority in ('normale', 'haute', 'urgente')),
  status           text not null default 'ouvert' check (status in ('ouvert', 'en_cours', 'termine', 'cloture')),
  description      text,
  work_done        text,
  due_date         date,
  hours_at_opening numeric(10, 2),
  opened_by        uuid default auth.uid(),
  opened_by_name   text,
  opened_at        timestamptz not null default now(),
  signed_by        uuid,
  signed_by_name   text,
  signed_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index work_orders_drone_idx on public.work_orders (drone_id, opened_at desc);
create trigger trg_work_orders_updated before update on public.work_orders for each row execute function public.set_updated_at();

create table public.work_order_links (
  id            uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  kind          text not null check (kind in ('visite', 'rapport', 'piece')),
  ref_id        uuid not null,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  unique (kind, ref_id)
);
create index work_order_links_wo_idx on public.work_order_links (work_order_id);

-- Numéro OT-AAAA-0001, drone port et compteur horaire du drone à l'ouverture
create or replace function public.work_orders_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_year text := to_char(coalesce(new.opened_at, now()) at time zone 'Indian/Antananarivo', 'YYYY');
begin
  select drone_port_id into new.drone_port_id from public.drones where id = new.drone_id;
  select total_hours into new.hours_at_opening from public.v_drone_status where id = new.drone_id;
  new.opened_by_name := public.audit_actor_name(coalesce(new.opened_by, auth.uid()));
  new.number := 'OT-' || v_year || '-' || lpad((
    select coalesce(max(substring(number from 9)::int), 0) + 1 from public.work_orders where number like 'OT-' || v_year || '-%')::text, 4, '0');
  if new.status = 'cloture' then raise exception 'Un OT se clôture par la signature du responsable maintenance'; end if;
  new.signed_by := null; new.signed_by_name := null; new.signed_at := null;
  return new;
end;
$$;
create trigger trg_work_orders_insert before insert on public.work_orders for each row execute function public.work_orders_before_insert();

-- Verrou : un OT clôturé n'est modifiable que par un administrateur ; la clôture passe par sign_work_order
create or replace function public.work_orders_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'cloture' and not public.is_admin() then raise exception 'OT clôturé : seul un administrateur peut le supprimer'; end if;
    return old;
  end if;
  new.number := old.number; new.drone_id := old.drone_id; new.drone_port_id := old.drone_port_id;
  if old.status = 'cloture' and not public.is_admin() then
    raise exception 'OT clôturé : seul un administrateur peut le modifier';
  end if;
  if coalesce(current_setting('app.wo_sign', true), '') <> 'on' then
    if new.status = 'cloture' and old.status <> 'cloture' then raise exception 'La clôture d''un OT se fait par la signature du responsable maintenance'; end if;
    new.signed_by := old.signed_by; new.signed_by_name := old.signed_by_name; new.signed_at := old.signed_at;
  end if;
  return new;
end;
$$;
create trigger trg_work_orders_guard before update or delete on public.work_orders for each row execute function public.work_orders_guard();

-- Éléments rattachés : même drone, OT non clôturé
create or replace function public.work_order_links_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wo public.work_orders;
  ok boolean;
begin
  select * into wo from public.work_orders where id = coalesce(new.work_order_id, old.work_order_id);
  if wo.status = 'cloture' and not public.is_admin() then raise exception 'OT clôturé : éléments non modifiables'; end if;
  if tg_op = 'DELETE' then return old; end if;
  ok := case new.kind
    when 'visite' then exists (select 1 from public.maintenance_visits v where v.id = new.ref_id and v.drone_id = wo.drone_id)
    when 'rapport' then exists (select 1 from public.technical_reports r join public.flights f on f.id = r.flight_id where r.id = new.ref_id and f.drone_id = wo.drone_id)
    when 'piece' then exists (select 1 from public.part_events e where e.id = new.ref_id and e.drone_id = wo.drone_id)
  end;
  if not ok then raise exception 'Cet élément ne concerne pas le drone de l''OT'; end if;
  return new;
end;
$$;
create trigger trg_work_order_links_guard before insert or delete on public.work_order_links for each row execute function public.work_order_links_guard();

-- Droits : administrateur, ou utilisateur du drone port du drone
alter table public.work_orders enable row level security;
alter table public.work_order_links enable row level security;
create policy wo_select on public.work_orders for select to authenticated using (public.is_admin() or drone_port_id = public.my_drone_port_id());
create policy wo_insert on public.work_orders for insert to authenticated
  with check (public.is_admin() or exists (select 1 from public.drones d where d.id = drone_id and d.drone_port_id = public.my_drone_port_id()));
create policy wo_update on public.work_orders for update to authenticated using (public.is_admin() or drone_port_id = public.my_drone_port_id());
create policy wo_delete on public.work_orders for delete to authenticated using (public.is_admin() or drone_port_id = public.my_drone_port_id());
create policy wol_all on public.work_order_links for all to authenticated
  using (exists (select 1 from public.work_orders w where w.id = work_order_id and (public.is_admin() or w.drone_port_id = public.my_drone_port_id())))
  with check (exists (select 1 from public.work_orders w where w.id = work_order_id and (public.is_admin() or w.drone_port_id = public.my_drone_port_id())));

-- Signature du responsable maintenance : clôture l'OT
create or replace function public.sign_work_order(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  wo public.work_orders;
  v_name text;
begin
  select * into wo from public.work_orders where id = p_id for update;
  if not found then raise exception 'OT introuvable'; end if;
  if not (public.is_admin() or (wo.drone_port_id = public.my_drone_port_id() and public.my_pilot_id() is not null)) then
    raise exception 'Seul un pilote du drone port ou un administrateur peut signer cet OT' using errcode = '42501';
  end if;
  if wo.status = 'cloture' then raise exception 'OT déjà clôturé'; end if;
  if wo.status <> 'termine' then raise exception 'Passez l''OT au statut « Terminé » avant de le signer'; end if;
  if nullif(btrim(wo.work_done), '') is null then raise exception 'Décrivez les travaux réalisés avant de signer'; end if;
  v_name := public.audit_actor_name(auth.uid());
  perform set_config('app.wo_sign', 'on', true);
  update public.work_orders set status = 'cloture', signed_by = auth.uid(), signed_by_name = v_name, signed_at = now() where id = p_id;
end;
$$;

-- Réouverture (administrateur) : annule la signature
create or replace function public.reopen_work_order(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  perform set_config('app.wo_sign', 'on', true);
  update public.work_orders set status = 'termine', signed_by = null, signed_by_name = null, signed_at = null where id = p_id and status = 'cloture';
end;
$$;
revoke all on function public.sign_work_order(uuid), public.reopen_work_order(uuid) from public, anon;
grant execute on function public.sign_work_order(uuid), public.reopen_work_order(uuid) to authenticated;

-- Vue : OT avec drone et nombre d'éléments
create view public.v_work_orders with (security_invoker = true) as
select w.*, d.code as drone_code, dp.name as drone_port_name,
       (select count(*) from public.work_order_links l where l.work_order_id = w.id) as link_count
from public.work_orders w
join public.drones d on d.id = w.drone_id
left join public.drone_ports dp on dp.id = w.drone_port_id;
grant select on public.v_work_orders to authenticated;

-- Journal d'audit
create trigger trg_audit after insert or update or delete on public.work_orders for each row execute function public.audit_trigger();
create trigger trg_audit after insert or update or delete on public.work_order_links for each row execute function public.audit_trigger();

comment on table public.work_orders is 'Ordres de travail de maintenance, signés par le responsable maintenance';
