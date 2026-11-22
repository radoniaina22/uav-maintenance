"""
Reprise de l'ancien registre des pièces -> fichier SQL à relire puis exécuter (une transaction).

    python -I scripts/import-old-parts.py backups/old-parts [sortie.sql]

Entrées (export Excel de l'ancien outil) :
  * pièces.xlsx     : inventaire (Serial = ancien code, HDV, Drone, Montage, Disponible, Description…)
  * historique.xlsx : opérations datées (Installation / Remplacement / Désinstallation, « Éditeur : … »)

Règles :
  * nouveaux codes : un compteur par type, dans l'ordre des anciens numéros (MOV000038 -> MOV0001…),
    attribués par le déclencheur parts_assign_code ; l'ancien code va dans parts.legacy_code ;
  * l'historique est rejoué : montages / démontages aux dates d'origine, avec le nom de l'éditeur ;
    heures antérieures = 0 pour les pièces qui ont un historique (heures recalculées depuis les vols),
    = HDV pour les autres ;
  * corrections de saisie : un montage défait en moins de 30 min est ignoré (saisie refaite),
    remplacement sans nouvelle pièce ou entre deux types différents ignoré, réinstallation d'une
    pièce déjà en place ignorée ; une installation sur un emplacement occupé démonte l'occupant ;
  * statut final : montée si l'historique la laisse montée, sinon colonne « Disponible ».
Le SQL refuse de s'exécuter si la table parts n'est pas vide (numérotation à partir de 0001).
Lecture des .xlsx sans dépendance (zip + XML).
"""
import collections
import datetime
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
CORRECTION = datetime.timedelta(minutes=30)
POS = {'1': 'AVD', '2': 'ARG', '3': 'AVG', '4': 'ARD'}  # numérotation des moteurs / ESC / hélices VTOL
MULTI = {'CNT', 'SOT', 'CMR', 'FLE'}                    # pièces multiples : pas d'emplacement unique
MULTI_ZONE = 'avionique'


def read_sheet(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    sheet = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet'))[0]
    rows = []
    for row in ET.fromstring(z.read(sheet)).iter('{%s}row' % NS['m']):
        vals = {}
        for c in row.findall('m:c', NS):
            v = c.find('m:v', NS)
            if c.get('t') == 's' and v is not None:
                val = shared[int(v.text)]
            elif c.get('t') == 'inlineStr':
                val = ''.join(x.text or '' for x in c.iter('{%s}t' % NS['m']))
            else:
                val = v.text if v is not None else ''
            letters = re.match(r'[A-Z]+', c.get('r')).group(0)
            idx = 0
            for ch in letters:
                idx = idx * 26 + ord(ch) - 64
            vals[idx - 1] = val
        rows.append([vals.get(i, '') for i in range(max(vals) + 1)] if vals else [])
    return rows


def xl_datetime(day, frac):
    dt = datetime.datetime(1899, 12, 30) + datetime.timedelta(days=float(day) + float(frac or 0))
    return (dt + datetime.timedelta(seconds=30)).replace(second=0, microsecond=0)


def q(v):
    return 'null' if v is None or v == '' else "'" + str(v).replace("'", "''") + "'"


def clean(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


def slot_for(kind, num, code):
    t = code[:3]
    if t in MULTI:
        return None
    if kind in ('Moteur', 'ESC', 'Hélice'):
        return t if num == '5' else f'{t}-{POS[num]}'
    if kind == 'Servo':
        return f'{t}-{"D" if num == "droite" else "G"}'
    return t


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src / 'import-old-parts.sql'
    inv_rows = read_sheet(src / 'pièces.xlsx')
    head = inv_rows[0]
    inv = [dict(zip(head, r + [''] * (len(head) - len(r)))) for r in inv_rows[1:] if r]
    inv_by = {p['Serial']: p for p in inv}
    hist = [r for r in read_sheet(src / 'historique.xlsx')[1:] if r]

    # ------------------------------------------------------------- rejeu
    notes = []          # journal des corrections appliquées
    intervals = []      # dict(code, drone, slot, a, b, editor_in, reason_in, editor_out, reason_out, quarantine)
    open_by_code = {}
    open_by_slot = {}

    def close(code, at, editor, reason, quarantine=False):
        iv = open_by_code.pop(code)
        open_by_slot.pop((iv['drone'], iv['slot']), None)
        iv.update(b=at, editor_out=editor, reason_out=reason, quarantine=quarantine)

    def install(drone, slot, code, at, editor, text, line):
        if code not in inv_by:
            notes.append(f'L{line} : {code} absent de l\'inventaire, ignoré')
            return
        cur = open_by_code.get(code)
        if cur and cur['drone'] == drone and cur['slot'] == slot:
            notes.append(f'L{line} : {code} déjà en place sur {drone}, réinstallation ignorée')
            return
        if cur:
            close(code, at, editor, f'Déplacée ({text})')
        if slot and (drone, slot) in open_by_slot:
            occ = open_by_slot[(drone, slot)]
            close(occ, at, editor, f'Remplacée sur l\'emplacement ({text})')
        iv = dict(code=code, drone=drone, slot=slot, a=at, b=None, editor_in=editor, reason_in=text,
                  editor_out=None, reason_out=None, quarantine=False)
        intervals.append(iv)
        open_by_code[code] = iv
        if slot:
            open_by_slot[(drone, slot)] = code

    for line, r in enumerate(hist, start=2):
        at = xl_datetime(r[0], r[1])
        drone = r[3].strip()
        desc = r[2]
        m = re.search(r'[ÉE]diteur\s*:\s*(.+)$', desc)
        editor = clean(m.group(1)) if m else None
        text = clean(desc.split('\n')[0])
        if (m := re.match(r'Installation du (Moteur|ESC|Hélice|Servo) (\w+) : (\w+)$', text)):
            install(drone, slot_for(m[1], m[2], m[3]), m[3], at, editor, text, line)
        elif (m := re.match(r'Installation de la pièce : (\w+)$', text)):
            install(drone, slot_for(None, None, m[1]), m[1], at, editor, text, line)
        elif (m := re.match(r'Remplacement du (Moteur|ESC|Hélice|Servo) (\w+) : (\w+) par (\w+)$', text)):
            old, new = m[3], m[4]
            if old[:3] != new[:3]:
                notes.append(f'L{line} : « {text} » ignoré (types différents, saisie erronée)')
                continue
            if old in open_by_code:
                close(old, at, editor, text)
            else:
                notes.append(f'L{line} : {old} n\'était pas monté (remplacement traité comme installation)')
            install(drone, slot_for(m[1], m[2], new), new, at, editor, text, line)
        elif (m := re.match(r'Désinstallation de la pièce : (\w+)( et mise en quarantaine)?$', text)):
            if m[1] in open_by_code:
                close(m[1], at, editor, text, quarantine=bool(m[2]))
            else:
                notes.append(f'L{line} : démontage de {m[1]} non monté, ignoré')
        else:
            notes.append(f'L{line} : « {text} » ignoré (ligne incomplète)')

    # corrections : montages défaits en moins de 30 min, puis fusion des périodes consécutives
    kept = []
    for iv in intervals:
        if iv['b'] is not None and iv['b'] - iv['a'] < CORRECTION:
            notes.append(f'{iv["code"]} sur {iv["drone"]}/{iv["slot"] or "—"} du {iv["a"]:%d/%m/%Y %H:%M} '
                         f'({int((iv["b"] - iv["a"]).total_seconds() // 60)} min) : saisie corrigée, ignorée')
            continue
        kept.append(iv)
    merged = []
    for iv in sorted(kept, key=lambda x: (x['code'], x['a'])):
        prev = merged[-1] if merged else None
        if (prev and prev['code'] == iv['code'] and prev['drone'] == iv['drone'] and prev['slot'] == iv['slot']
                and prev['b'] is not None and iv['a'] - prev['b'] < CORRECTION):
            prev.update(b=iv['b'], editor_out=iv['editor_out'], reason_out=iv['reason_out'], quarantine=iv['quarantine'])
            continue
        merged.append(dict(iv))
    by_code = collections.defaultdict(list)
    for iv in merged:
        by_code[iv['code']].append(iv)

    # contrôle : pas deux pièces sur le même emplacement au même moment
    occ = collections.defaultdict(list)
    for iv in merged:
        if iv['slot']:
            occ[(iv['drone'], iv['slot'])].append(iv)
    for key, lst in occ.items():
        lst.sort(key=lambda x: x['a'])
        for x, y in zip(lst, lst[1:]):
            if x['b'] is None or x['b'] > y['a']:
                raise SystemExit(f'Chevauchement sur {key} : {x["code"]} et {y["code"]}')

    # ------------------------------------------------------------- SQL
    now_note = "Reprise de l'ancien registre des pièces"
    sql = [
        '-- Généré par scripts/import-old-parts.py : reprise de l\'ancien registre des pièces',
        f'-- {len(inv)} pièces, {len(merged)} périodes de montage',
        'begin;',
        "do $$ begin if exists (select 1 from public.parts) then "
        "raise exception 'La table parts n''est pas vide : import annulé (numérotation à partir de 0001)'; end if; end $$;",
        "do $$ begin if (select count(distinct drone_port_id) from public.drones where code in ('MAL1','MAL2','MAL2.2','MAL3')) <> 1 "
        "or (select count(*) from public.drones where code in ('MAL1','MAL2','MAL2.2','MAL3')) <> 4 then "
        "raise exception 'Drones MAL1 / MAL2 / MAL2.2 / MAL3 introuvables ou dans des drone ports différents'; end if; end $$;",
        "create temp table imp_port on commit drop as select drone_port_id as id from public.drones where code = 'MAL1';",
        "select set_config('app.part_op', 'on', true);",
        '',
        '-- 1. Pièces (ordre = ancien numéro, par type : le déclencheur attribue MOV0001, MOV0002…)',
    ]
    inv_sorted = sorted(inv, key=lambda p: (p['Serial'][:3], int(p['Serial'][3:])))
    status_of = {}
    for p in inv_sorted:
        code = p['Serial']
        ivs = by_code.get(code, [])
        mounted = bool(ivs and ivs[-1]['b'] is None)
        status = 'monte' if mounted else ('quarantaine' if 'quarantaine' in p['Disponible'].lower() else 'stock')
        status_of[code] = status
        hours = 0 if ivs else round(float(p['HDV'] or 0), 1)
        sql.append(
            'insert into public.parts (type_code, legacy_code, serial_number, manufacturer, status, drone_port_id, initial_hours, notes) values ('
            f"{q(code[:3])}, {q(code)}, {q(clean(p.get('Serial_constructeur')))}, {q(clean(p['Designation']))}, "
            f"'{status}', (select id from imp_port), {hours}, {q((p['Description'] or '').strip())});")

    sql += ['', '-- 2. Périodes de montage et événements']
    ev = []  # (code, type, at, drone, slot, reason, editor)
    import_at = 'public.mg_now()'
    for p in inv_sorted:
        code = p['Serial']
        ivs = by_code.get(code, [])
        ev.append((code, 'entree_stock', ivs[0]['a'] if ivs else None, None, None,
                   f'{now_note} (ancien code {code})', ivs[0]['editor_in'] if ivs else None))
        state = 'stock'
        for iv in ivs:
            if state == 'quarantaine':
                ev.append((code, 'remise_en_stock', iv['a'], None, None, 'Remise en stock (ancien registre)', iv['editor_in']))
            ev.append((code, 'montage', iv['a'], iv['drone'], iv['slot'], iv['reason_in'], iv['editor_in']))
            if iv['b'] is not None:
                ev.append((code, 'demontage', iv['b'], iv['drone'], iv['slot'], iv['reason_out'], iv['editor_out']))
                state = 'stock'
                if iv['quarantine']:
                    ev.append((code, 'quarantaine', iv['b'], iv['drone'], iv['slot'],
                               clean(p['Description']) if status_of[code] == 'quarantaine' and iv is ivs[-1] and p['Description'].strip()
                               else iv['reason_out'], iv['editor_out']))
                    state = 'quarantaine'
            else:
                state = 'monte'
        final = status_of[code]
        if final == 'quarantaine' and state != 'quarantaine':
            at = ivs[-1]['b'] if ivs else None
            ev.append((code, 'quarantaine', at, ivs[-1]['drone'] if ivs else None, ivs[-1]['slot'] if ivs else None,
                       clean(p['Description']) or 'En quarantaine dans l\'ancien registre', ivs[-1]['editor_out'] if ivs else None))
        elif final == 'stock' and state == 'quarantaine':
            ev.append((code, 'remise_en_stock', None, None, None, 'En stock dans l\'ancien registre', None))

        for iv in ivs:
            zone = (f"(select zone from public.drone_slots where model = 'Tango 4' and code = {q(iv['slot'])})"
                    if iv['slot'] else q(MULTI_ZONE))
            sql.append(
                'insert into public.part_installations (part_id, drone_id, slot, zone, installed_at, removed_at, removal_reason) values ('
                f"(select id from public.parts where legacy_code = {q(code)}), (select id from public.drones where code = {q(iv['drone'])}), "
                f"{q(iv['slot'])}, {zone}, {q(f'{iv[chr(97)]:%Y-%m-%d %H:%M}')}, "
                f"{q(f'{iv[chr(98)]:%Y-%m-%d %H:%M}') if iv['b'] else 'null'}, {q(iv['reason_out'])});")

    for code, etype, at, drone, slot, reason, editor in ev:
        at_sql = q(f'{at:%Y-%m-%d %H:%M}') if at else import_at
        sql.append(
            'insert into public.part_events (part_id, event_type, at, drone_id, slot, to_port_id, reason, imported, editor_name, created_by) values ('
            f"(select id from public.parts where legacy_code = {q(code)}), '{etype}', {at_sql}, "
            f"{'(select id from public.drones where code = ' + q(drone) + ')' if drone else 'null'}, "
            f"{q(slot or (MULTI_ZONE if drone else None))}, "
            f"{'(select id from imp_port)' if etype in ('entree_stock', 'montage') else 'null'}, {q(reason)}, true, {q(editor)}, null);")

    sql += ['', 'commit;', '']
    out.write_text('\n'.join(sql), encoding='utf-8')

    # ------------------------------------------------------------- résumé
    print(f'SQL écrit : {out}')
    print(f'{len(inv)} pièces · {len(merged)} périodes de montage · {len(ev)} événements')
    print('statuts :', dict(collections.Counter(status_of.values())))
    print('montées par drone :', dict(collections.Counter(iv['drone'] for iv in merged if iv['b'] is None)))
    diff = [c for c, p in inv_by.items() if (p['Drone'] or None) != (by_code[c][-1]['drone'] if by_code.get(c) and by_code[c][-1]['b'] is None else None)]
    print('écarts avec la colonne Drone de l\'inventaire :', diff or 'aucun')
    print(f'corrections appliquées ({len(notes)}) :')
    for n in notes:
        print('  -', n)


if __name__ == '__main__':
    main()
