-- Le numéro de série d'une batterie devient facultatif (il peut être renseigné plus tard).
-- L'unicité reste garantie pour les numéros saisis ; une valeur vide est enregistrée comme absente.
alter table public.batteries alter column serial_number drop not null;
update public.batteries set serial_number = null where btrim(serial_number) = '';
alter table public.batteries add constraint batteries_serial_not_blank check (serial_number is null or btrim(serial_number) <> '');
