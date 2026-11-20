-- Les pilotes peuvent ajouter, modifier et supprimer les CSB de leur drone port.
-- Les CSB communs à tous les drone ports (drone_port_id null) restent gérés par l'administrateur.

drop policy if exists ins on public.health_facilities;
drop policy if exists upd on public.health_facilities;
drop policy if exists del on public.health_facilities;

create policy ins on public.health_facilities for insert to authenticated
  with check ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));

create policy upd on public.health_facilities for update to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()))
  with check ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));

create policy del on public.health_facilities for delete to authenticated
  using ((select public.is_admin()) or drone_port_id = (select public.my_drone_port_id()));

-- un CSB déjà utilisé par des vols ne peut pas être supprimé (historique) : message explicite
create or replace function public.health_facilities_guard_delete()
returns trigger language plpgsql set search_path = public as $$
declare n int;
begin
  select count(*) into n from flights where destination_id = old.id;
  if n > 0 then
    raise exception 'Ce CSB est la destination de % vol(s) : il ne peut pas être supprimé. Décochez « Destination active » pour le retirer des listes.', n
      using errcode = '23503';
  end if;
  return old;
end;
$$;
create trigger trg_hf_guard_delete before delete on public.health_facilities
  for each row execute function public.health_facilities_guard_delete();
