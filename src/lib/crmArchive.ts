/** Emplacement d'archive d'un CRM : Drone / Année / Mois / jj-mm-aaaa / Vol N (CSB) / fichier */
export const MONTHS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

export function crmArchivePath(p: {
  droneCode: string; flightDate: string; takeoff: string; destination: string | null; flightType: string;
  rank: number; crmNo: string; closed: boolean;
}) {
  const [y, m, d] = p.flightDate.split('-');
  const dest = p.destination ?? (p.flightType === 'controle' ? 'Vol de contrôle' : 'sans destination');
  return {
    segments: [p.droneCode, y, `${m} - ${MONTHS_FR[Number(m) - 1]}`, `${d}-${m}-${y}`, `Vol ${p.rank} (${dest})`],
    fileName: `CRM ${p.crmNo} - ${d}-${m}-${y} ${p.takeoff.slice(0, 5).replace(':', 'h')}${p.closed ? '' : ' (provisoire)'}.pdf`,
  };
}

/** Rang de chaque vol dans la journée de son drone (ordre de décollage puis de saisie) */
export function dayRanks(flights: { id: string; drone_id: string; flight_date: string; takeoff_time: string; created_at: string }[]) {
  const groups = new Map<string, typeof flights>();
  for (const f of flights) {
    const k = `${f.drone_id}|${f.flight_date}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const rank = new Map<string, number>();
  for (const g of groups.values()) {
    g.sort((a, b) => a.takeoff_time.localeCompare(b.takeoff_time) || a.created_at.localeCompare(b.created_at)).forEach((f, i) => rank.set(f.id, i + 1));
  }
  return rank;
}
