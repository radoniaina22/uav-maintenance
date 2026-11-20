-- Qualification « Responsable maintenance » sur la fiche pilote.
-- Seuls les responsables maintenance du drone port (et l'administrateur) signent et clôturent les ordres de travail.
-- (La qualification n'est modifiable que par un administrateur : la table pilots n'est modifiable que par lui.)

alter table public.pilots add column maintenance_lead boolean not null default false;
comment on column public.pilots.maintenance_lead is 'Responsable maintenance : peut signer et clôturer les ordres de travail de son drone port';

-- Vue des pilotes : ajoute la qualification (colonne ajoutée en fin de vue)
create or replace view public.v_pilot_stats as
select p.id, p.full_name, p.license_number, p.phone, p.active, p.created_at, p.updated_at, p.drone_port_id, p.initial_flight_minutes,
  dp.name as drone_port_name,
  count(l.id) as flight_count,
  round((p.initial_flight_minutes + coalesce(sum(l.duration_min), 0)) / 60.0, 1) as total_hours,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'pilote'), 0) / 60.0, 1) as pic_hours,
  round(coalesce(sum(l.duration_min) filter (where l.role = 'copilote'), 0) / 60.0, 1) as copilot_hours,
  max(l.entry_date) as last_flight_date,
  (select count(*) from public.flight_pilots fp join public.flights f on f.id = fp.flight_id where fp.pilot_id = p.id and f.status = 'ouvert') as open_flight_count,
  (exists (select 1 from public.profiles pr where pr.pilot_id = p.id)) as has_account,
  p.maintenance_lead
from public.pilots p
left join public.drone_ports dp on dp.id = p.drone_port_id
left join public.logbook_entries l on l.pilot_id = p.id
where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id()) or p.id = (select public.my_pilot_id())
group by p.id, dp.name;

-- Signature d'un OT : administrateur, ou responsable maintenance actif du drone port du drone
create or replace function public.sign_work_order(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  wo public.work_orders;
  v_name text;
begin
  select * into wo from public.work_orders where id = p_id for update;
  if not found then raise exception 'OT introuvable'; end if;
  if not (public.is_admin() or exists (
      select 1 from public.pilots pl
      where pl.id = public.my_pilot_id() and pl.maintenance_lead and pl.active and pl.drone_port_id = wo.drone_port_id)) then
    raise exception 'Seul un responsable maintenance du drone port (ou un administrateur) peut signer cet OT' using errcode = '42501';
  end if;
  if wo.status = 'cloture' then raise exception 'OT déjà clôturé'; end if;
  if wo.status <> 'termine' then raise exception 'Passez l''OT au statut « Terminé » avant de le signer'; end if;
  if nullif(btrim(wo.work_done), '') is null then raise exception 'Décrivez les travaux réalisés avant de signer'; end if;
  v_name := public.audit_actor_name(auth.uid());
  perform set_config('app.wo_sign', 'on', true);
  update public.work_orders set status = 'cloture', signed_by = auth.uid(), signed_by_name = v_name, signed_at = now() where id = p_id;
end;
$$;
