-- Enregistrement atomique d'un vol + de ses pilotes (1 à 2)
create or replace function public.save_flight(p_id uuid, p_data jsonb, p_pilot_ids uuid[])
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := coalesce(array_length(p_pilot_ids, 1), 0);
begin
  if v_n = 0 then
    raise exception 'Au moins un pilote est requis';
  elsif v_n > 2 then
    raise exception 'Un vol ne peut avoir que 2 pilotes au maximum';
  elsif v_n = 2 and p_pilot_ids[1] = p_pilot_ids[2] then
    raise exception 'Les deux pilotes doivent être différents';
  end if;

  if p_id is null then
    insert into flights (drone_id, destination_id, flight_date, takeoff_time, drop_time, landing_time,
                         payload_kg, avg_wind_ms, consumption_mah, battery_1_id, battery_2_id, observation)
    select r.drone_id, r.destination_id, r.flight_date, r.takeoff_time, r.drop_time, r.landing_time,
           r.payload_kg, r.avg_wind_ms, r.consumption_mah, r.battery_1_id, r.battery_2_id, r.observation
    from jsonb_populate_record(null::flights, p_data) r
    returning id into v_id;
  else
    update flights f set
      drone_id = r.drone_id, destination_id = r.destination_id, flight_date = r.flight_date,
      takeoff_time = r.takeoff_time, drop_time = r.drop_time, landing_time = r.landing_time,
      payload_kg = r.payload_kg, avg_wind_ms = r.avg_wind_ms, consumption_mah = r.consumption_mah,
      battery_1_id = r.battery_1_id, battery_2_id = r.battery_2_id, observation = r.observation
    from jsonb_populate_record(null::flights, p_data) r
    where f.id = p_id
    returning f.id into v_id;

    if v_id is null then
      raise exception 'Vol introuvable';
    end if;
    delete from flight_pilots where flight_id = v_id;
  end if;

  insert into flight_pilots (flight_id, pilot_id, role)
  select v_id, t.pid, case when t.ord = 1 then 'pilote' else 'copilote' end
  from unnest(p_pilot_ids) with ordinality as t(pid, ord);

  return v_id;
end;
$$;

revoke all on function public.save_flight(uuid, jsonb, uuid[]) from public, anon;
grant execute on function public.save_flight(uuid, jsonb, uuid[]) to authenticated;
