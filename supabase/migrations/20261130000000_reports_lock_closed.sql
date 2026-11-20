-- Un compte rendu technique / incident clôturé est verrouillé :
-- seul un administrateur peut encore le modifier, le rouvrir ou le supprimer.

create or replace function public.technical_reports_lock_closed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'clos' and not is_admin() then
    raise exception 'Rapport clôturé : seul un administrateur peut le modifier ou le supprimer'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger trg_tr_lock_closed before update or delete on public.technical_reports
  for each row execute function public.technical_reports_lock_closed();

comment on function public.technical_reports_lock_closed() is
  'Verrouille les comptes rendus clôturés : modification, réouverture et suppression réservées aux administrateurs';
