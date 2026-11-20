-- =====================================================================
-- Gestion des pièces : types (potentiel), pièces codées, emplacements Tango 4,
-- montages / démontages, quarantaine, stock par drone port, historique
-- =====================================================================

-- ---------------------------------------------------------------------
-- Types de pièces (sous-catégories, code à 3 lettres)
-- ---------------------------------------------------------------------
create table public.part_types (
  code              text primary key check (code ~ '^[A-Z]{3}$'),
  category          text not null,
  name              text not null,
  default_max_hours numeric(8,1) check (default_max_hours > 0), -- potentiel par défaut (heures)
  multi             boolean not null default false,             -- plusieurs exemplaires par drone (connecteurs, fils)
  sort              integer not null default 0,
  active            boolean not null default true
);

insert into public.part_types (code, category, name, multi, sort) values
  ('MOV', 'Moteur',                 'Moteur vertical',      false, 10),
  ('MOH', 'Moteur',                 'Moteur horizontal',    false, 11),
  ('ESV', 'ESC',                    'ESC vertical',         false, 20),
  ('ESH', 'ESC',                    'ESC horizontal',       false, 21),
  ('HEV', 'Hélice',                 'Hélice verticale',     false, 30),
  ('HEH', 'Hélice',                 'Hélice horizontale',   false, 31),
  ('SEA', 'Servo moteur',           'Servo d''aileron',     false, 40),
  ('SEG', 'Servo moteur',           'Servo de gouverne',    false, 41),
  ('SEP', 'Servo moteur',           'Servo de poussée',     false, 42),
  ('SEL', 'Servo moteur',           'Servo de largage',     false, 43),
  ('CAP', 'Capteur et émetteur',    'Capteur de pression',  false, 50),
  ('SOT', 'Capteur et émetteur',    'Sonde de tension',     false, 51),
  ('GPS', 'Capteur et émetteur',    'GPS',                  false, 52),
  ('LDR', 'Capteur et émetteur',    'Lidar',                false, 53),
  ('ADS', 'Capteur et émetteur',    'ADS-B',                false, 54),
  ('TLM', 'Capteur et émetteur',    'Télémétrie',           false, 55),
  ('CNT', 'Composant électronique', 'Connecteur',           true,  60),
  ('FLE', 'Composant électronique', 'Fil électrique',       true,  61),
  ('PIZ', 'Composant électronique', 'Pi Zero',              false, 62),
  ('BEC', 'Composant électronique', 'BEC',                  false, 63),
  ('CAM', 'Composant électronique', 'Caméra Raspi',         false, 64),
  ('APT', 'Autopilote',             'Autopilote',           false, 70),
  ('TRD', 'Composant structure',    'Trappe droite',        false, 80),
  ('TRG', 'Composant structure',    'Trappe gauche',        false, 81);

-- ---------------------------------------------------------------------
-- Emplacements par modèle de drone (zones de la vue visuelle)
-- ---------------------------------------------------------------------
create table public.drone_slots (
  model     text not null,
  code      text not null,
  zone      text not null,
  label     text not null,
  type_code text not null references public.part_types(code),
  sort      integer not null default 0,
  primary key (model, code)
);

insert into public.drone_slots (model, code, zone, label, type_code, sort) values
  ('Tango 4', 'MOV-AVG', 'vtol_avg', 'Moteur vertical avant gauche',  'MOV', 1),
  ('Tango 4', 'ESV-AVG', 'vtol_avg', 'ESC vertical avant gauche',     'ESV', 2),
  ('Tango 4', 'HEV-AVG', 'vtol_avg', 'Hélice verticale avant gauche', 'HEV', 3),
  ('Tango 4', 'MOV-ARG', 'vtol_arg', 'Moteur vertical arrière gauche',  'MOV', 1),
  ('Tango 4', 'ESV-ARG', 'vtol_arg', 'ESC vertical arrière gauche',     'ESV', 2),
  ('Tango 4', 'HEV-ARG', 'vtol_arg', 'Hélice verticale arrière gauche', 'HEV', 3),
  ('Tango 4', 'MOV-AVD', 'vtol_avd', 'Moteur vertical avant droit',  'MOV', 1),
  ('Tango 4', 'ESV-AVD', 'vtol_avd', 'ESC vertical avant droit',     'ESV', 2),
  ('Tango 4', 'HEV-AVD', 'vtol_avd', 'Hélice verticale avant droite', 'HEV', 3),
  ('Tango 4', 'MOV-ARD', 'vtol_ard', 'Moteur vertical arrière droit',  'MOV', 1),
  ('Tango 4', 'ESV-ARD', 'vtol_ard', 'ESC vertical arrière droit',     'ESV', 2),
  ('Tango 4', 'HEV-ARD', 'vtol_ard', 'Hélice verticale arrière droite', 'HEV', 3),
  ('Tango 4', 'MOH',     'propulsion', 'Moteur horizontal (propulsion)', 'MOH', 1),
  ('Tango 4', 'ESH',     'propulsion', 'ESC horizontal',                 'ESH', 2),
  ('Tango 4', 'HEH',     'propulsion', 'Hélice horizontale',             'HEH', 3),
  ('Tango 4', 'SEP',     'propulsion', 'Servo de poussée',               'SEP', 4),
  ('Tango 4', 'SEA-G',   'aile_g', 'Servo d''aileron gauche', 'SEA', 1),
  ('Tango 4', 'SEA-D',   'aile_d', 'Servo d''aileron droit',  'SEA', 1),
  ('Tango 4', 'SEG-G',   'empennage', 'Servo de gouverne gauche', 'SEG', 1),
  ('Tango 4', 'SEG-D',   'empennage', 'Servo de gouverne droite', 'SEG', 2),
  ('Tango 4', 'APT',     'avionique', 'Autopilote',          'APT', 1),
  ('Tango 4', 'GPS',     'avionique', 'GPS',                 'GPS', 2),
  ('Tango 4', 'TLM',     'avionique', 'Télémétrie',          'TLM', 3),
  ('Tango 4', 'ADS',     'avionique', 'ADS-B',               'ADS', 4),
  ('Tango 4', 'CAP',     'avionique', 'Capteur de pression', 'CAP', 5),
  ('Tango 4', 'SOT',     'avionique', 'Sonde de tension',    'SOT', 6),
  ('Tango 4', 'PIZ',     'avionique', 'Pi Zero',             'PIZ', 7),
  ('Tango 4', 'BEC',     'avionique', 'BEC',                 'BEC', 8),
  ('Tango 4', 'SEL',     'soute', 'Servo de largage', 'SEL', 1),
  ('Tango 4', 'TRD',     'soute', 'Trappe droite',    'TRD', 2),
  ('Tango 4', 'TRG',     'soute', 'Trappe gauche',    'TRG', 3),
  ('Tango 4', 'CAM',     'soute', 'Caméra Raspi',     'CAM', 4),
  ('Tango 4', 'LDR',     'soute', 'Lidar',            'LDR', 5);

-- ---------------------------------------------------------------------
-- Pièces
-- ---------------------------------------------------------------------
create table public.part_code_counters (
  type_code  text primary key references public.part_types(code),
  last_value integer not null default 0
);

create table public.parts (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  type_code     text not null references public.part_types(code),
  serial_number text,
  manufacturer  text,
  status        text not null default 'stock' check (status in ('stock','monte','quarantaine','rebut')),
  drone_port_id uuid references public.drone_ports(id) on delete set null,
  initial_hours numeric(8,1) not null default 0 check (initial_hours >= 0),
  max_hours     numeric(8,1) check (max_hours > 0),  -- potentiel propre à la pièce (sinon celui du type)
  acquired_on   date,
  notes         text,
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index parts_port_idx on public.parts(drone_port_id, type_code, status);
create trigger trg_parts_updated before update on public.parts
  for each row execute function public.set_updated_at();

-- Code automatique : 3 lettres du type + numéro séquentiel par type (MOV0001, MOV0002…)
create or replace function public.parts_assign_code()
returns trigger language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  insert into part_code_counters (type_code, last_value) values (new.type_code, 1)
  on conflict (type_code) do update set last_value = part_code_counters.last_value + 1
  returning last_value into v;
  new.code := new.type_code || lpad(v::text, 4, '0');
  return new;
end;
$$;
create trigger trg_parts_code before insert on public.parts
  for each row execute function public.parts_assign_code();

-- Statut, emplacement, code et type ne changent que par les actions (fonctions ci-dessous)
create or replace function public.parts_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.code is distinct from old.code then raise exception 'Le code d''une pièce ne peut pas être modifié'; end if;
  if new.type_code is distinct from old.type_code then raise exception 'Le type d''une pièce ne peut pas être modifié'; end if;
  if coalesce(current_setting('app.part_op', true), '') <> 'on'
     and (new.status is distinct from old.status or new.drone_port_id is distinct from old.drone_port_id) then
    raise exception 'Utilisez les actions (monter, démonter, quarantaine, transfert) pour changer le statut ou le drone port d''une pièce';
  end if;
  return new;
end;
$$;
create trigger trg_parts_guard before update on public.parts
  for each row execute function public.parts_guard();

-- ---------------------------------------------------------------------
-- Montages (historique) et événements
-- ---------------------------------------------------------------------
create table public.part_installations (
  id             uuid primary key default gen_random_uuid(),
  part_id        uuid not null references public.parts(id) on delete cascade,
  drone_id       uuid not null references public.drones(id) on delete restrict,
  slot           text,           -- emplacement (null pour les pièces multiples : connecteurs, fils)
  zone           text not null,
  installed_at   timestamp not null,
  removed_at     timestamp,
  removal_reason text,
  check (removed_at is null or removed_at >= installed_at)
);
create unique index part_installations_open_part on public.part_installations(part_id) where removed_at is null;
create unique index part_installations_open_slot on public.part_installations(drone_id, slot) where removed_at is null and slot is not null;
create index part_installations_drone_idx on public.part_installations(drone_id, installed_at);

create table public.part_events (
  id           uuid primary key default gen_random_uuid(),
  part_id      uuid not null references public.parts(id) on delete cascade,
  event_type   text not null check (event_type in ('entree_stock','montage','demontage','quarantaine','remise_en_stock','rebut','transfert')),
  at           timestamp not null,
  drone_id     uuid references public.drones(id) on delete set null,
  slot         text,
  from_port_id uuid references public.drone_ports(id) on delete set null,
  to_port_id   uuid references public.drone_ports(id) on delete set null,
  reason       text,
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index part_events_part_idx on public.part_events(part_id, at desc);
create index part_events_at_idx on public.part_events(at desc);

-- Seuils de stock minimum par drone port et par type
create table public.part_stock_thresholds (
  drone_port_id uuid not null references public.drone_ports(id) on delete cascade,
  type_code     text not null references public.part_types(code) on delete cascade,
  min_qty       integer not null check (min_qty >= 0),
  primary key (drone_port_id, type_code)
);

-- ---------------------------------------------------------------------
-- Fonctions d'action (security definer + contrôle du périmètre)
-- ---------------------------------------------------------------------
create or replace function public.can_manage_port(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (p is not null and p = public.my_drone_port_id())
$$;

create or replace function public.mg_now()
returns timestamp language sql stable as $$ select (now() at time zone 'Indian/Antananarivo')::timestamp $$;

-- Entrée en stock (création de pièces)
create or replace function public.create_parts(
  p_type text, p_qty integer, p_port uuid, p_serials text[] default null, p_manufacturer text default null,
  p_initial_hours numeric default 0, p_max_hours numeric default null, p_acquired_on date default null, p_notes text default null)
returns setof text language plpgsql security definer set search_path = public as $$
declare
  n integer := coalesce(array_length(p_serials, 1), p_qty);
  i integer;
  v_id uuid;
  v_code text;
begin
  if not can_manage_port(p_port) then raise exception 'Vous ne pouvez gérer le stock que de votre drone port'; end if;
  if n is null or n < 1 or n > 200 then raise exception 'Quantité invalide (1 à 200)'; end if;
  if not exists (select 1 from part_types where code = p_type and active) then raise exception 'Type de pièce inconnu'; end if;
  perform set_config('app.part_op', 'on', true);
  for i in 1..n loop
    insert into parts (type_code, serial_number, manufacturer, status, drone_port_id, initial_hours, max_hours, acquired_on, notes)
    values (p_type, nullif(btrim(p_serials[i]), ''), p_manufacturer, 'stock', p_port, coalesce(p_initial_hours, 0), p_max_hours, p_acquired_on, p_notes)
    returning id, code into v_id, v_code;
    insert into part_events (part_id, event_type, at, to_port_id, reason) values (v_id, 'entree_stock', mg_now(), p_port, p_notes);
    return next v_code;
  end loop;
end;
$$;

-- Montage d'une pièce en stock sur un drone
create or replace function public.mount_part(p_part uuid, p_drone uuid, p_slot text, p_zone text, p_at timestamp default null, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_part parts%rowtype;
  v_drone drones%rowtype;
  v_type part_types%rowtype;
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
      raise exception 'L''emplacement « % » attend une pièce de type %, pas %', v_slot.label, v_slot.type_code, v_part.type_code;
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

-- Démontage (vers le stock ou la quarantaine)
create or replace function public.unmount_part(p_part uuid, p_to text, p_at timestamp default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_part parts%rowtype;
  v_inst part_installations%rowtype;
  v_at timestamp := coalesce(p_at, mg_now());
begin
  if p_to not in ('stock', 'quarantaine') then raise exception 'Destination invalide'; end if;
  if p_to = 'quarantaine' and nullif(btrim(p_reason), '') is null then raise exception 'Indiquez le motif de la mise en quarantaine'; end if;
  select * into v_part from parts where id = p_part for update;
  if not found then raise exception 'Pièce introuvable'; end if;
  if not can_manage_port(v_part.drone_port_id) then raise exception 'Cette pièce n''est pas dans votre drone port'; end if;
  select * into v_inst from part_installations where part_id = p_part and removed_at is null for update;
  if not found or v_part.status <> 'monte' then raise exception 'La pièce % n''est pas montée', v_part.code; end if;
  if v_at < v_inst.installed_at then raise exception 'La date de démontage est antérieure au montage (%)', to_char(v_inst.installed_at, 'DD/MM/YYYY HH24:MI'); end if;

  perform set_config('app.part_op', 'on', true);
  update part_installations set removed_at = v_at, removal_reason = p_reason where id = v_inst.id;
  update parts set status = p_to where id = p_part;
  insert into part_events (part_id, event_type, at, drone_id, slot, reason)
  values (p_part, 'demontage', v_at, v_inst.drone_id, coalesce(v_inst.slot, v_inst.zone), p_reason);
  if p_to = 'quarantaine' then
    insert into part_events (part_id, event_type, at, drone_id, slot, reason)
    values (p_part, 'quarantaine', v_at, v_inst.drone_id, coalesce(v_inst.slot, v_inst.zone), p_reason);
  end if;
end;
$$;

-- Remplacement : démonte la pièce en place et monte une pièce du stock au même emplacement
create or replace function public.replace_part(p_old uuid, p_new uuid, p_old_to text, p_at timestamp default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_inst part_installations%rowtype;
  v_at timestamp := coalesce(p_at, mg_now());
begin
  select * into v_inst from part_installations where part_id = p_old and removed_at is null;
  if not found then raise exception 'La pièce à remplacer n''est pas montée'; end if;
  perform unmount_part(p_old, p_old_to, v_at, p_reason);
  perform mount_part(p_new, v_inst.drone_id, v_inst.slot, v_inst.zone, v_at, coalesce('Remplacement : ' || p_reason, 'Remplacement'));
end;
$$;

-- Changement de statut d'une pièce non montée (quarantaine, remise en stock, rebut)
create or replace function public.set_part_status(p_part uuid, p_status text, p_reason text default null, p_at timestamp default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_part parts%rowtype;
  v_at timestamp := coalesce(p_at, mg_now());
  v_event text;
begin
  select * into v_part from parts where id = p_part for update;
  if not found then raise exception 'Pièce introuvable'; end if;
  if not can_manage_port(v_part.drone_port_id) then raise exception 'Cette pièce n''est pas dans votre drone port'; end if;
  if v_part.status = 'monte' then raise exception 'La pièce % est montée : démontez-la d''abord', v_part.code; end if;
  if v_part.status = 'rebut' then raise exception 'La pièce % est au rebut', v_part.code; end if;
  if p_status = v_part.status then raise exception 'La pièce est déjà dans ce statut'; end if;
  v_event := case p_status when 'quarantaine' then 'quarantaine' when 'stock' then 'remise_en_stock' when 'rebut' then 'rebut' end;
  if v_event is null then raise exception 'Statut invalide'; end if;
  if p_status in ('quarantaine', 'rebut') and nullif(btrim(p_reason), '') is null then raise exception 'Indiquez le motif'; end if;
  perform set_config('app.part_op', 'on', true);
  update parts set status = p_status where id = p_part;
  insert into part_events (part_id, event_type, at, reason) values (p_part, v_event, v_at, p_reason);
end;
$$;

-- Transfert d'une pièce non montée vers un autre drone port
create or replace function public.transfer_part(p_part uuid, p_to_port uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_part parts%rowtype;
begin
  select * into v_part from parts where id = p_part for update;
  if not found then raise exception 'Pièce introuvable'; end if;
  if not can_manage_port(v_part.drone_port_id) then raise exception 'Cette pièce n''est pas dans votre drone port'; end if;
  if v_part.status not in ('stock', 'quarantaine') then raise exception 'Seule une pièce en stock ou en quarantaine peut être transférée'; end if;
  if p_to_port is null or p_to_port = v_part.drone_port_id then raise exception 'Choisissez un autre drone port'; end if;
  perform set_config('app.part_op', 'on', true);
  update parts set drone_port_id = p_to_port where id = p_part;
  insert into part_events (part_id, event_type, at, from_port_id, to_port_id, reason)
  values (p_part, 'transfert', mg_now(), v_part.drone_port_id, p_to_port, p_reason);
end;
$$;

-- Les pièces montées suivent le drone s'il change de drone port
create or replace function public.drones_move_parts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.part_op', 'on', true);
  insert into part_events (part_id, event_type, at, drone_id, from_port_id, to_port_id, reason)
  select p.id, 'transfert', mg_now(), new.id, old.drone_port_id, new.drone_port_id, 'Transfert du drone ' || new.code
  from parts p join part_installations i on i.part_id = p.id and i.removed_at is null
  where i.drone_id = new.id;
  update parts p set drone_port_id = new.drone_port_id
  from part_installations i where i.part_id = p.id and i.removed_at is null and i.drone_id = new.id;
  return null;
end;
$$;
create trigger trg_drones_move_parts after update of drone_port_id on public.drones
  for each row when (old.drone_port_id is distinct from new.drone_port_id)
  execute function public.drones_move_parts();

revoke all on function public.create_parts(text, integer, uuid, text[], text, numeric, numeric, date, text),
  public.mount_part(uuid, uuid, text, text, timestamp, text), public.unmount_part(uuid, text, timestamp, text),
  public.replace_part(uuid, uuid, text, timestamp, text), public.set_part_status(uuid, text, text, timestamp),
  public.transfer_part(uuid, uuid, text), public.can_manage_port(uuid) from public, anon;
grant execute on function public.create_parts(text, integer, uuid, text[], text, numeric, numeric, date, text),
  public.mount_part(uuid, uuid, text, text, timestamp, text), public.unmount_part(uuid, text, timestamp, text),
  public.replace_part(uuid, uuid, text, timestamp, text), public.set_part_status(uuid, text, text, timestamp),
  public.transfer_part(uuid, uuid, text), public.can_manage_port(uuid) to authenticated;

-- =====================================================================
-- Vues
-- =====================================================================
-- Heures d'une pièce = heures antérieures + vols du drone pendant chaque période de montage
create view public.v_parts as
select
  p.*,
  t.category,
  t.name as type_name,
  t.multi,
  coalesce(p.max_hours, t.default_max_hours) as max_hours_effective,
  ci.drone_id,
  d.code as drone_code,
  ci.slot,
  ci.zone,
  ci.installed_at,
  ds.label as slot_label,
  dp.name as drone_port_name,
  coalesce(u.flight_count, 0) as flight_count,
  round(p.initial_hours + coalesce(u.flown_min, 0) / 60.0, 2) as total_hours,
  case when coalesce(p.max_hours, t.default_max_hours) is null then null
       else round(100.0 * (p.initial_hours + coalesce(u.flown_min, 0) / 60.0) / coalesce(p.max_hours, t.default_max_hours), 1)
  end as potential_pct
from public.parts p
join public.part_types t on t.code = p.type_code
left join public.part_installations ci on ci.part_id = p.id and ci.removed_at is null
left join public.drones d on d.id = ci.drone_id
left join public.drone_slots ds on ds.model = d.model and ds.code = ci.slot
left join public.drone_ports dp on dp.id = p.drone_port_id
left join lateral (
  select count(f.id) as flight_count, sum(public.flight_minutes(f.takeoff_time, f.landing_time)) as flown_min
  from public.part_installations i
  join public.flights f on f.drone_id = i.drone_id
   and (f.flight_date + f.takeoff_time) >= i.installed_at
   and (i.removed_at is null or (f.flight_date + f.takeoff_time) < i.removed_at)
  where i.part_id = p.id
) u on true
where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id());

create view public.v_part_events as
select e.*, p.code as part_code, p.type_code, t.name as type_name, d.code as drone_code,
       fp.name as from_port_name, tp.name as to_port_name
from public.part_events e
join public.parts p on p.id = e.part_id
join public.part_types t on t.code = p.type_code
left join public.drones d on d.id = e.drone_id
left join public.drone_ports fp on fp.id = e.from_port_id
left join public.drone_ports tp on tp.id = e.to_port_id
where (select public.is_admin())
   or p.drone_port_id = (select public.my_drone_port_id())
   or e.from_port_id = (select public.my_drone_port_id())
   or e.to_port_id = (select public.my_drone_port_id());

create view public.v_part_installations as
select i.*, p.code as part_code, p.type_code, d.code as drone_code, ds.label as slot_label,
       round(coalesce((
         select sum(public.flight_minutes(f.takeoff_time, f.landing_time)) from public.flights f
         where f.drone_id = i.drone_id and (f.flight_date + f.takeoff_time) >= i.installed_at
           and (i.removed_at is null or (f.flight_date + f.takeoff_time) < i.removed_at)
       ), 0) / 60.0, 2) as hours_on_drone
from public.part_installations i
join public.parts p on p.id = i.part_id
join public.drones d on d.id = i.drone_id
left join public.drone_slots ds on ds.model = d.model and ds.code = i.slot
where (select public.is_admin()) or p.drone_port_id = (select public.my_drone_port_id());

-- =====================================================================
-- RLS & droits
-- =====================================================================
alter table public.part_types            enable row level security;
alter table public.drone_slots           enable row level security;
alter table public.part_code_counters    enable row level security;
alter table public.parts                 enable row level security;
alter table public.part_installations    enable row level security;
alter table public.part_events           enable row level security;
alter table public.part_stock_thresholds enable row level security;

create policy sel on public.part_types  for select to authenticated using (true);
create policy ins on public.part_types  for insert to authenticated with check ((select public.is_admin()));
create policy upd on public.part_types  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy sel on public.drone_slots for select to authenticated using (true);

-- Pièces : lecture et modification des infos descriptives dans son drone port ; création par create_parts()
create policy sel on public.parts for select to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));
create policy upd on public.parts for update to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()))
  with check ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));

create policy sel on public.part_installations for select to authenticated
  using (exists (select 1 from public.parts p where p.id = part_id));
create policy sel on public.part_events for select to authenticated
  using (exists (select 1 from public.parts p where p.id = part_id)
         or (select public.is_admin())
         or from_port_id = (select public.my_drone_port_id())
         or to_port_id = (select public.my_drone_port_id()));

create policy sel on public.part_stock_thresholds for select to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));
create policy wr on public.part_stock_thresholds for all to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()))
  with check ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));

revoke all on public.part_types, public.drone_slots, public.part_code_counters, public.parts,
              public.part_installations, public.part_events, public.part_stock_thresholds from anon;
grant select, insert, update on public.part_types to authenticated;
grant select on public.drone_slots, public.part_installations, public.part_events to authenticated;
grant select, update on public.parts to authenticated;
grant select, insert, update, delete on public.part_stock_thresholds to authenticated;
revoke all on public.part_code_counters from authenticated;

revoke all on public.v_parts, public.v_part_events, public.v_part_installations from anon;
grant select on public.v_parts, public.v_part_events, public.v_part_installations to authenticated;
