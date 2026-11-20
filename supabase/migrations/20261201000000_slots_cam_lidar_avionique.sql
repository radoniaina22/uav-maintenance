-- Tango 4 : la caméra Raspi et le Lidar passent de « Soute & largage » à « Avionique ».

update public.drone_slots
set zone = 'avionique',
    sort = case code when 'CAM' then 9 when 'LDR' then 10 end
where model = 'Tango 4' and code in ('CAM', 'LDR');

-- pièces déjà montées (ou historique) sur ces emplacements : même zone
update public.part_installations i
set zone = 'avionique'
from public.drones d
where d.id = i.drone_id and d.model = 'Tango 4' and i.slot in ('CAM', 'LDR') and i.zone <> 'avionique';
