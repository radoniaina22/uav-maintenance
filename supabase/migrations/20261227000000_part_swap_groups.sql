-- =====================================================================
-- Pièces interchangeables : servo d'aileron <-> servo de gouverne
--  * part_types.swap_group : deux types du même groupe peuvent être montés
--    l'un à la place de l'autre (dans les deux sens). La pièce garde son
--    code, son type, son potentiel et son historique.
--  * mount_part (et donc replace_part) accepte un type du même groupe.
--  * part_mount_warnings : avertissements non bloquants avant le montage
--    (montage croisé, marque différente de la pièce précédente ou de la
--    pièce symétrique gauche / droite, marque non renseignée).
-- =====================================================================

alter table public.part_types add column if not exists swap_group text;
comment on column public.part_types.swap_group is
  'Groupe d''interchangeabilité : les types du même groupe peuvent être montés l''un à la place de l''autre';

update public.part_types set swap_group = 'servo_gouverne' where code in ('SEA', 'SEG');

grant select, insert, update on public.part_types to authenticated;

-- Montage d'une pièce en stock sur un drone
create or replace function public.mount_part(p_part uuid, p_drone uuid, p_slot text, p_zone text, p_at timestamp default null, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_part parts%rowtype;
  v_drone drones%rowtype;
  v_type part_types%rowtype;
  v_slot_type part_types%rowtype;
  v_zone text := p_zone;
  v_slot drone_slots%rowtype;
  v_at timestamp := coalesce(p_at, mg_now());
begin
  select * into v_part from parts where id = p_part for update;
  if not found then raise exception 'Pièce introuvable'; end if;
  select * into v_drone from drones where id = p_drone;
  if not found then raise exception 'Drone introuvable'; end if;
  if not can_manage_port(v_drone.drone_port_id) then raise exception 'Ce drone n''est pas dans votre drone port'; end if;
  if v_part.status <> 'stock' then
    raise exception 'La pièce % n''est pas en stock (statut : %)', v_part.code, v_part.status;
  end if;
  if v_part.drone_port_id is distinct from v_drone.drone_port_id then
    raise exception 'La pièce % est stockée dans un autre drone port : transférez-la d''abord', v_part.code;
  end if;
  select * into v_type from part_types where code = v_part.type_code;
  if p_slot is not null then
    select * into v_slot from drone_slots where model = v_drone.model and code = p_slot;
    if not found then raise exception 'Emplacement % inconnu pour le modèle %', p_slot, v_drone.model; end if;
    if v_slot.type_code <> v_part.type_code then
      -- type interchangeable (même groupe) : accepté
      select * into v_slot_type from part_types where code = v_slot.type_code;
      if v_type.swap_group is null or v_slot_type.swap_group is distinct from v_type.swap_group then
        raise exception 'L''emplacement « % » attend une pièce de type %, pas %', v_slot.label, v_slot.type_code, v_part.type_code;
      end if;
    end if;
    v_zone := v_slot.zone;
  else
    if not v_type.multi then raise exception 'Choisissez l''emplacement de la pièce'; end if;
    if v_zone is null or not exists (select 1 from drone_slots where model = v_drone.model and zone = v_zone) then
      raise exception 'Zone de montage invalide';
    end if;
  end if;
  if exists (select 1 from part_installations i where i.drone_id = p_drone and i.slot is not null and i.slot = p_slot and i.removed_at is null) then
    raise exception 'L''emplacement « % » est déjà occupé : démontez ou remplacez la pièce en place', coalesce(v_slot.label, p_slot);
  end if;

  perform set_config('app.part_op', 'on', true);
  insert into part_installations (part_id, drone_id, slot, zone, installed_at) values (p_part, p_drone, p_slot, v_zone, v_at);
  update parts set status = 'monte', drone_port_id = v_drone.drone_port_id where id = p_part;
  insert into part_events (part_id, event_type, at, drone_id, slot, to_port_id, reason)
  values (p_part, 'montage', v_at, p_drone, coalesce(p_slot, v_zone), v_drone.drone_port_id, p_notes);
end;
$$;

-- Avertissements avant le montage d'une pièce interchangeable (non bloquants).
-- Pièce de référence de l'emplacement : celle en place (cas d'un remplacement),
-- sinon la dernière démontée. Pièce symétrique : emplacement « -G » <-> « -D ».
create or replace function public.part_mount_warnings(p_part uuid, p_drone uuid, p_slot text)
returns text[] language plpgsql stable security invoker set search_path = public as $$
declare
  v_part parts%rowtype;
  v_type part_types%rowtype;
  v_drone drones%rowtype;
  v_slot drone_slots%rowtype;
  v_slot_type part_types%rowtype;
  v_brand text;
  v_prev record;
  v_sib record;
  v_sib_code text;
  v_compared boolean := false;
  v_out text[] := '{}';
begin
  select * into v_part from parts where id = p_part;
  if not found or p_slot is null then return v_out; end if;
  select * into v_type from part_types where code = v_part.type_code;
  if v_type.swap_group is null then return v_out; end if;
  select * into v_drone from drones where id = p_drone;
  if not found then return v_out; end if;
  select * into v_slot from drone_slots where model = v_drone.model and code = p_slot;
  if not found then return v_out; end if;
  v_brand := nullif(btrim(v_part.manufacturer), '');

  if v_slot.type_code <> v_part.type_code then
    select * into v_slot_type from part_types where code = v_slot.type_code;
    v_out := v_out || format('Montage croisé : %s (%s) sur l''emplacement « %s », prévu pour un(e) %s.',
      v_part.code, lower(v_type.name), v_slot.label, lower(v_slot_type.name));
  end if;

  select p.code, nullif(btrim(p.manufacturer), '') as brand, i.removed_at is null as current
    into v_prev
    from part_installations i join parts p on p.id = i.part_id
   where i.drone_id = p_drone and i.slot = p_slot and i.part_id <> p_part
   order by coalesce(i.removed_at, 'infinity'::timestamp) desc, i.installed_at desc
   limit 1;
  if found and v_prev.brand is not null then
    v_compared := true;
    if v_brand is not null and lower(v_brand) <> lower(v_prev.brand) then
      v_out := v_out || format('Marque différente : le servo %s de cet emplacement (%s) est de marque %s, %s est de marque %s.',
        case when v_prev.current then 'en place' else 'précédent' end, v_prev.code, v_prev.brand, v_part.code, v_brand);
    end if;
  end if;

  v_sib_code := case when p_slot ~ '-G$' then regexp_replace(p_slot, '-G$', '-D')
                     when p_slot ~ '-D$' then regexp_replace(p_slot, '-D$', '-G') end;
  if v_sib_code is not null then
    select p.code, nullif(btrim(p.manufacturer), '') as brand, ds.label
      into v_sib
      from part_installations i
      join parts p on p.id = i.part_id
      join drone_slots ds on ds.model = v_drone.model and ds.code = i.slot
     where i.drone_id = p_drone and i.slot = v_sib_code and i.removed_at is null and i.part_id <> p_part
     limit 1;
    if found and v_sib.brand is not null then
      v_compared := true;
      if v_brand is not null and lower(v_brand) <> lower(v_sib.brand) then
        v_out := v_out || format('Marque différente du côté opposé : « %s » porte %s de marque %s, %s est de marque %s.',
          v_sib.label, v_sib.code, v_sib.brand, v_part.code, v_brand);
      end if;
    end if;
  end if;

  if v_brand is null and v_compared then
    v_out := v_out || format('Marque de %s non renseignée : impossible de la comparer aux autres servos du drone.', v_part.code);
  end if;
  return v_out;
end;
$$;

revoke all on function public.part_mount_warnings(uuid, uuid, text) from public, anon;
grant execute on function public.part_mount_warnings(uuid, uuid, text) to authenticated;
grant execute on function public.mount_part(uuid, uuid, text, text, timestamp, text) to authenticated;
