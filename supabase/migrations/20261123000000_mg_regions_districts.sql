-- =====================================================================
-- Découpage administratif de Madagascar : 24 régions, 114 districts
-- (lois 2021-010 : Vatovavy / Fitovinany ; 2023-012 : Ambatosoa ;
--  décret 2015-593 modifié). Remplace les champs texte commune / district / région
-- des CSB et des drone ports.
-- =====================================================================

create table public.mg_regions (
  id   integer generated always as identity primary key,
  name text not null unique
);

create table public.mg_districts (
  id        integer generated always as identity primary key,
  region_id integer not null references public.mg_regions(id) on delete restrict,
  name      text not null,
  unique (region_id, name),
  unique (region_id, id)  -- cible de la clé étrangère composite (région, district)
);

with data(region, districts) as (values
  ('Alaotra-Mangoro',     array['Ambatondrazaka','Amparafaravola','Andilamena','Anosibe An''ala','Moramanga']),
  ('Ambatosoa',           array['Mananara Avaratra','Maroantsetra']),
  ('Amoron''i Mania',     array['Ambatofinandrahana','Ambositra','Fandriana','Manandriana']),
  ('Analamanga',          array['Ambohidratrimo','Andramasina','Anjozorobe','Ankazobe','Antananarivo Atsimondrano','Antananarivo Avaradrano','Antananarivo Renivohitra','Manjakandriana']),
  ('Analanjirofo',        array['Fenoarivo Atsinanana','Nosy Boraha','Soanierana Ivongo','Vavatenina']),
  ('Androy',              array['Ambovombe Androy','Bekily','Beloha','Tsihombe']),
  ('Anosy',               array['Amboasary Atsimo','Betroka','Taolagnaro']),
  ('Atsimo-Andrefana',    array['Ampanihy','Ankazoabo','Benenitra','Beroroha','Betioky Atsimo','Morombe','Sakaraha','Toliara I','Toliara II']),
  ('Atsimo-Atsinanana',   array['Befotaka','Farafangana','Midongy Atsimo','Vangaindrano','Vondrozo']),
  ('Atsinanana',          array['Antanambao Manampotsy','Mahanoro','Marolambo','Toamasina I','Toamasina II','Vatomandry','Vohibinany']),
  ('Betsiboka',           array['Kandreho','Maevatanana','Tsaratanana']),
  ('Boeny',               array['Ambato Boeny','Mahajanga I','Mahajanga II','Marovoay','Mitsinjo','Soalala']),
  ('Bongolava',           array['Fenoarivobe','Tsiroanomandidy']),
  ('Diana',               array['Ambanja','Ambilobe','Antsiranana I','Antsiranana II','Nosy Be']),
  ('Fitovinany',          array['Ikongo','Manakara','Vohipeno']),
  ('Haute Matsiatra',     array['Ambalavao','Ambohimahasoa','Fianarantsoa I','Ikalamavony','Isandra','Lalangina','Vohibato']),
  ('Ihorombe',            array['Iakora','Ihosy','Ivohibe']),
  ('Itasy',               array['Arivonimamo','Miarinarivo','Soavinandriana']),
  ('Melaky',              array['Ambatomainty','Antsalova','Besalampy','Maintirano','Morafenobe']),
  ('Menabe',              array['Belon''i Tsiribihina','Mahabo','Manja','Miandrivazo','Morondava']),
  ('Sava',                array['Andapa','Antalaha','Sambava','Vohemar']),
  ('Sofia',               array['Analalava','Antsohihy','Bealanana','Befandriana Avaratra','Boriziny','Mampikony','Mandritsara']),
  ('Vakinankaratra',      array['Ambatolampy','Antanifotsy','Antsirabe I','Antsirabe II','Betafo','Faratsiho','Mandoto']),
  ('Vatovavy',            array['Ifanadiana','Mananjary','Nosy Varika'])
),
ins_regions as (
  insert into public.mg_regions (name) select region from data order by region returning id, name
)
insert into public.mg_districts (region_id, name)
select r.id, unnest(d.districts) from data d join ins_regions r on r.name = d.region;

-- ---------------------------------------------------------------------
-- CSB et drone ports : région + district (district cohérent avec la région)
-- ---------------------------------------------------------------------
alter table public.health_facilities
  add column region_id   integer references public.mg_regions(id) on delete restrict,
  add column district_id integer,
  add constraint hf_district_in_region foreign key (region_id, district_id)
    references public.mg_districts(region_id, id) on delete restrict,
  add constraint hf_district_needs_region check (district_id is null or region_id is not null);

alter table public.drone_ports
  add column region_id   integer references public.mg_regions(id) on delete restrict,
  add column district_id integer,
  add constraint dp_district_in_region foreign key (region_id, district_id)
    references public.mg_districts(region_id, id) on delete restrict,
  add constraint dp_district_needs_region check (district_id is null or region_id is not null);

-- Reprise des anciennes saisies texte quand elles correspondent à un nom officiel
update public.health_facilities h
   set district_id = d.id, region_id = d.region_id
  from public.mg_districts d
 where h.district is not null and lower(btrim(h.district)) = lower(d.name);

update public.drone_ports p
   set district_id = d.id, region_id = d.region_id
  from public.mg_districts d
 where p.district is not null and lower(btrim(p.district)) = lower(d.name);

update public.drone_ports p
   set region_id = r.id
  from public.mg_regions r
 where p.region_id is null and p.region is not null and lower(btrim(p.region)) = lower(r.name);

alter table public.health_facilities drop column commune, drop column district;
alter table public.drone_ports drop column region, drop column district;

create index hf_region_idx on public.health_facilities(region_id, district_id);
create index dp_region_idx on public.drone_ports(region_id, district_id);

-- ---------------------------------------------------------------------
-- Droits : lecture pour tous les connectés, modification par les admins
-- ---------------------------------------------------------------------
alter table public.mg_regions   enable row level security;
alter table public.mg_districts enable row level security;

create policy sel on public.mg_regions   for select to authenticated using (true);
create policy sel on public.mg_districts for select to authenticated using (true);
create policy ins on public.mg_regions   for insert to authenticated with check ((select public.is_admin()));
create policy upd on public.mg_regions   for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy del on public.mg_regions   for delete to authenticated using ((select public.is_admin()));
create policy ins on public.mg_districts for insert to authenticated with check ((select public.is_admin()));
create policy upd on public.mg_districts for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy del on public.mg_districts for delete to authenticated using ((select public.is_admin()));

revoke all on public.mg_regions, public.mg_districts from anon;
grant select, insert, update, delete on public.mg_regions, public.mg_districts to authenticated;
