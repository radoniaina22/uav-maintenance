/*
 * Passerelle UAV Maintenance <-> WindPath
 * ---------------------------------------------------------------
 * Injectée par la page « Planification » dans l'iframe WindPath (même origine).
 * Elle s'exécute dans la portée globale de WindPath : elle lit `state`, `elements`
 * et les fonctions de script.js SANS modifier ses fichiers, et échange des messages
 * avec l'application via postMessage (origine vérifiée).
 *
 * Messages reçus (source: 'uav')
 *   prefill { payloadKg, capacityMah, departureVoltage, takeoff: 'AAAA-MM-JJTHH:MM', center: [lat, lon] }
 *   request                  → result { data }
 *   loadPlan { id, name, fileName, content } → planLoaded { ok, name, count, error }
 *   exportPlan               → planFile { fileName, content, waypointCount, distanceKm, generated }
 *   clear                    → efface la mission (et la sauvegarde locale)
 *   layout { mode: 'map' | 'balanced' | 'entry' } → disposition Préparer / Mixte / Saisie
 * Envoyé aussi par WindPath (layout { mode }) quand le pilote change de disposition au clavier (Alt+1/2/3)
 * Messages envoyés (source: 'windpath')
 *   ready, prefilled { applied }, restored { missionName, savedAt }, status { … } (à chaque changement)
 */
(() => {
  if (window.__uavBridge) return;
  window.__uavBridge = true;

  const ORIGIN = window.location.origin;
  const post = (msg) => window.parent.postMessage({ source: 'windpath', ...msg }, ORIGIN);
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const round = (v, d = 0) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
  /** Réserve de route appliquée par WindPath (20 % de la consommation estimée) */
  const RESERVE = typeof ROUTE_RESERVE_FRACTION === 'number' ? ROUTE_RESERVE_FRACTION : 0.2;
  const SESSION_KEY = 'uav.windpath.session.v1';
  const SESSION_MAX_AGE_MS = 3 * 24 * 3600 * 1000;

  /** Fichier importé (pour l'enregistrer tel quel dans la bibliothèque) et plan de la bibliothèque chargé */
  let lastFile = null;   // { name, text, sig }
  let planId = null;
  /** Disposition carte / tableau des points (mode « saisie » : le tableau prend presque toute la hauteur) */
  let layout = 'balanced';

  const signature = () => JSON.stringify((state.waypoints || []).map((w) => [w.lat, w.lon, w.altitude, w.command, w.dropPoint]));

  function setInput(el, value, eventName) {
    const n = Number(value);
    if (!el || value == null || value === '' || !Number.isFinite(n)) return false;
    el.value = String(n);
    if (eventName) el.dispatchEvent(new Event(eventName, { bubbles: true }));
    return true;
  }

  // -------------------------------------------------------------------
  // Fichier importé : capturé sans toucher aux écouteurs de WindPath
  // -------------------------------------------------------------------
  async function rememberFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      // WindPath lit le fichier en parallèle : la signature est prise une fois les points chargés
      setTimeout(() => { if (state.missionName === file.name) { lastFile = { name: file.name, text, sig: signature() }; planId = null; } }, 400);
    } catch { /* fichier illisible : WindPath affichera son propre message */ }
  }
  elements.missionFile.addEventListener('change', (e) => rememberFile(e.target.files && e.target.files[0]), true);
  elements.uploadZone.addEventListener('drop', (e) => rememberFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]), true);

  // -------------------------------------------------------------------
  // Pré-remplissage depuis le vol
  // -------------------------------------------------------------------
  function prefill(p) {
    const applied = [];
    if (setInput(elements.payloadWeight, p.payloadKg, 'change')) applied.push(`colis ${p.payloadKg} kg`);
    if (setInput(elements.batteryCapacity, p.capacityMah, 'input')) applied.push(`capacité ${Math.round(p.capacityMah)} mAh`);
    if (setInput(elements.departureVoltage, p.departureVoltage, 'input')) applied.push(`tension de départ ${p.departureVoltage} V`);
    if (typeof p.takeoff === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.takeoff)) {
      elements.takeoffTime.value = p.takeoff;
      elements.takeoffTime.dispatchEvent(new Event('change', { bubbles: true }));
      applied.push(`décollage ${p.takeoff.slice(8, 10)}/${p.takeoff.slice(5, 7)} ${p.takeoff.slice(11)}`);
    }
    if (Array.isArray(p.center) && finite(p.center[0]) && finite(p.center[1]) && !(state.waypoints || []).length) {
      map.setView(p.center, 11);
      applied.push('carte centrée sur le drone port');
    }
    return applied;
  }

  // -------------------------------------------------------------------
  // Synthèse de la mission (verdict de la page, report dans le vol)
  // -------------------------------------------------------------------
  function lastFinite(wps, key) { for (let i = wps.length - 1; i >= 0; i -= 1) if (finite(wps[i][key])) return wps[i][key]; return null; }

  function summary() {
    const wps = state.waypoints || [];
    let distance = 0, maxWind = null, maxWindWp = null, maxGust = null;
    wps.forEach((wp, i) => {
      if (i > 0) distance += distanceAndBearing(wps[i - 1], wp).distance;
      if (wp.wind && finite(wp.wind.speed) && (maxWind == null || wp.wind.speed > maxWind)) { maxWind = wp.wind.speed; maxWindWp = i + 1; }
      if (finite(wp.gust) && (maxGust == null || wp.gust > maxGust)) maxGust = wp.gust;
    });
    const capacity = Number(elements.batteryCapacity.value);
    const estMah = lastFinite(wps, 'cumulativeEstimatedMah');
    const margin = finite(estMah) && capacity > 0 ? (1 - (estMah * (1 + RESERVE)) / capacity) * 100 : null;
    const etas = wps.map((w) => w.etaTimestamp).filter(finite);
    const age = finite(state.lastWindCheckAt) ? (Date.now() - state.lastWindCheckAt) / 60000 : null;
    return {
      waypointCount: wps.length,
      missionName: state.missionName || null,
      planId,
      modified: Boolean(lastFile && lastFile.sig !== signature()),
      distanceKm: distance > 0 ? round(distance / 1000, 2) : null,
      windChecked: finite(state.lastWindCheckAt),
      windCheckAgeMin: age == null ? null : Math.floor(age),
      maxWindMs: round(maxWind, 1),
      maxWindWp,
      maxGustMs: round(maxGust, 1),
      estimatedMah: round(estMah),
      capacityMah: capacity > 0 ? capacity : null,
      marginPct: round(margin, 1),
      finalVoltage: round(lastFinite(wps, 'estimatedVoltage'), 2),
      durationMin: etas.length > 1 ? round((etas[etas.length - 1] - etas[0]) / 60000, 1) : null,
      payloadKg: finite(Number(elements.payloadWeight.value)) ? Number(elements.payloadWeight.value) : null,
      realCount: wps.filter((w) => finite(w.actualCumulativeMah) || finite(w.actualVoltage)).length,
      layout,
    };
  }

  /** Résultats de la mission en cours (valeurs réelles si saisies dans WindPath, sinon estimations) */
  function collect() {
    const wps = state.waypoints || [];
    if (!wps.length) return { error: 'Aucun point de passage : importez un plan de vol ou cliquez sur la carte dans WindPath.' };

    let windWeight = 0, windSpeedSum = 0, windX = 0, windY = 0;
    for (let i = 1; i < wps.length; i += 1) {
      const d = distanceAndBearing(wps[i - 1], wps[i]).distance;
      const w = wps[i].wind;
      if (w && finite(w.speed) && finite(w.direction) && d > 0) {
        windSpeedSum += w.speed * d;
        windWeight += d;
        // moyenne vectorielle de la direction (provenance), pondérée par vitesse × distance
        const rad = (w.direction * Math.PI) / 180;
        windX += Math.sin(rad) * w.speed * d;
        windY += Math.cos(rad) * w.speed * d;
      }
    }
    if (!windWeight && wps[0].wind && finite(wps[0].wind.speed)) {
      windSpeedSum = wps[0].wind.speed; windWeight = 1;
      const rad = (wps[0].wind.direction * Math.PI) / 180;
      windX = Math.sin(rad); windY = Math.cos(rad);
    }

    // altitude de croisière AMSL : plus haute altitude MSL connue du plan
    let cruise = null;
    if (typeof waypointAltitudeReference === 'function') {
      for (const wp of wps) {
        const ref = waypointAltitudeReference(wp);
        if (ref && ref.reference === 'msl' && finite(ref.altitude)) cruise = cruise == null ? ref.altitude : Math.max(cruise, ref.altitude);
      }
    }

    const realMah = lastFinite(wps, 'actualCumulativeMah');
    // dernier mAh « réel » ajouté automatiquement (point non saisi) : c'est une estimation
    const realMahIsAuto = (() => { for (let i = wps.length - 1; i >= 0; i -= 1) if (finite(wps[i].actualCumulativeMah)) return Boolean(wps[i].uavAuto && wps[i].uavAuto.mah === wps[i].actualCumulativeMah); return false; })();
    const estMah = lastFinite(wps, 'cumulativeEstimatedMah');
    const realVoltIsAuto = (() => { for (let i = wps.length - 1; i >= 0; i -= 1) if (finite(wps[i].actualVoltage)) return Boolean(wps[i].uavAuto && wps[i].uavAuto.v === wps[i].actualVoltage); return false; })();
    const realVoltEnd = lastFinite(wps, 'actualVoltage');
    const estVoltEnd = lastFinite(wps, 'estimatedVoltage');

    const drop = typeof hasDropPoint === 'function' ? wps.find((wp) => hasDropPoint(wp)) : null;
    const last = wps[wps.length - 1];
    const timeOf = (wp) => (!wp ? null
      : finite(wp.actualPassedAt) ? { value: hhmm(wp.actualPassedAt), source: wp.uavAuto && wp.uavAuto.pass === wp.actualPassedAt ? 'estime' : 'reel' }
      : finite(wp.etaTimestamp) ? { value: hhmm(wp.etaTimestamp), source: 'estime' } : null);
    const eta = (wp) => (wp && finite(wp.etaTimestamp) ? hhmm(wp.etaTimestamp) : null);

    const takeoff = elements.takeoffTime && elements.takeoffTime.value ? elements.takeoffTime.value : null;
    const departureVoltage = Number(elements.departureVoltage && elements.departureVoltage.value);
    const payloadKg = Number(elements.payloadWeight && elements.payloadWeight.value);
    const s = summary();

    return {
      missionName: state.missionName || null,
      waypointCount: wps.length,
      windChecked: Boolean(state.lastWindCheckAt),
      takeoffDate: takeoff ? takeoff.slice(0, 10) : null,
      takeoffTime: takeoff ? takeoff.slice(11, 16) : null,
      dropTime: timeOf(drop),
      landingTime: timeOf(last),
      distanceKm: s.distanceKm,
      windSpeedMs: windWeight ? round(windSpeedSum / windWeight, 1) : null,
      windDirectionDeg: windWeight ? Math.round(((Math.atan2(windX, windY) * 180) / Math.PI + 360) % 360) % 360 : null,
      cruiseAltitudeAmsl: cruise == null ? null : Math.round(cruise),
      consumption: finite(realMah) ? { value: Math.round(realMah), source: realMahIsAuto ? 'estime' : 'reel' } : finite(estMah) ? { value: Math.round(estMah), source: 'estime' } : null,
      voltageEnd: finite(realVoltEnd) ? { value: round(realVoltEnd, 2), source: realVoltIsAuto ? 'estime' : 'reel' }
        : finite(estVoltEnd) ? { value: round(estVoltEnd, 2), source: 'estime' } : null,
      departureVoltage: Number.isFinite(departureVoltage) ? departureVoltage : null,
      payloadKg: Number.isFinite(payloadKg) ? payloadKg : null,
      // estimation seule (jamais les valeurs réelles), conservée avec le vol pour la comparaison prévu / réel
      estimate: {
        planId,
        missionName: state.missionName || null,
        waypointCount: wps.length,
        distanceKm: s.distanceKm,
        takeoffTime: eta(wps[0]) || (takeoff ? takeoff.slice(11, 16) : null),
        dropTime: eta(drop),
        landingTime: eta(last),
        durationMin: s.durationMin,
        consumptionMah: s.estimatedMah,
        voltageEndV: s.finalVoltage,
        marginPct: s.marginPct,
        windMs: windWeight ? round(windSpeedSum / windWeight, 1) : null,
        windDirectionDeg: windWeight ? Math.round(((Math.atan2(windX, windY) * 180) / Math.PI + 360) % 360) % 360 : null,
        maxWindMs: s.maxWindMs,
        maxGustMs: s.maxGustMs,
        payloadKg: s.payloadKg,
        capacityMah: s.capacityMah,
        windCheckedAt: finite(state.lastWindCheckAt) ? new Date(state.lastWindCheckAt).toISOString() : null,
      },
    };
  }

  // -------------------------------------------------------------------
  // Bibliothèque de plans : chargement et export
  // -------------------------------------------------------------------
  async function loadPlan(p) {
    const fileName = p.fileName || p.name || 'plan.waypoints';
    const before = state.missionName;
    await loadMissionFile(new File([p.content || ''], fileName, { type: 'text/plain' }));
    if (state.missionName !== fileName && before !== fileName) {
      return { ok: false, error: (elements.message && elements.message.textContent) || 'Plan illisible.' };
    }
    state.missionName = p.name || fileName;
    lastFile = { name: fileName, text: p.content, sig: signature() };
    planId = p.id || null;
    renderWaypoints();
    return { ok: true, name: state.missionName, count: state.waypoints.length };
  }

  /** Mission tracée à la main (ou modifiée) : génère un .plan QGroundControl relisible par WindPath */
  function buildPlan() {
    const wps = state.waypoints || [];
    const items = [];
    let id = 1;
    let speed = null;
    for (const wp of wps) {
      const s = wp.speedSetting;
      if (s && finite(s.speed) && (!speed || speed.type !== s.type || speed.speed !== s.speed)) {
        items.push({ type: 'SimpleItem', command: DO_CHANGE_SPEED, frame: 2, params: [s.type, s.speed, -1, 0, 0, 0, 0], autoContinue: true, doJumpId: id++ });
        speed = s;
      }
      items.push({ type: 'SimpleItem', command: wp.command || 16, frame: finite(wp.frame) ? wp.frame : 3,
        params: [0, 0, 0, 0, wp.lat, wp.lon, wp.altitude], autoContinue: true, doJumpId: id++ });
      if (wp.dropPoint) {
        for (const [channel, out] of PAYLOAD_RELEASE_CHANNELS) {
          items.push({ type: 'SimpleItem', command: DO_SET_SERVO, frame: 2, params: [channel, Math.round((out.minPwm + out.maxPwm) / 2), 0, 0, 0, 0, 0], autoContinue: true, doJumpId: id++ });
        }
      }
    }
    const home = wps[0];
    return JSON.stringify({
      fileType: 'Plan', version: 1, groundStation: 'UAV Maintenance',
      mission: { version: 2, firmwareType: 3, vehicleType: 1, cruiseSpeed: Number(elements.defaultCruiseSpeed.value) || 23, hoverSpeed: 5,
        plannedHomePosition: home ? [home.lat, home.lon, 0] : [0, 0, 0], items },
      geoFence: { circles: [], polygons: [], version: 2 }, rallyPoints: { points: [], version: 2 },
    }, null, 1);
  }

  function exportPlan() {
    const wps = state.waypoints || [];
    if (!wps.length) return { error: 'Aucune mission à enregistrer.' };
    const s = summary();
    const raw = lastFile && lastFile.sig === signature();
    const base = (state.missionName || 'mission').replace(/\.(waypoints|plan|txt)$/i, '');
    return {
      fileName: raw ? lastFile.name : `${base}.plan`,
      content: raw ? lastFile.text : buildPlan(),
      waypointCount: wps.length,
      distanceKm: s.distanceKm,
      generated: !raw,
      missionName: state.missionName || null,
    };
  }

  // -------------------------------------------------------------------
  // Sauvegarde locale de la mission (retrouvée en revenant sur la page)
  // -------------------------------------------------------------------
  function save() {
    try {
      if (!(state.waypoints || []).length) { localStorage.removeItem(SESSION_KEY); return; }
      const s = {
        v: 1, savedAt: Date.now(), missionName: state.missionName, planId, lastFile,
        waypoints: state.waypoints, lastWindCheckAt: state.lastWindCheckAt, forecasts: state.forecasts,
        inputs: {
          takeoffTime: elements.takeoffTime.value, batteryCapacity: elements.batteryCapacity.value, departureVoltage: elements.departureVoltage.value,
          defaultCruiseSpeed: elements.defaultCruiseSpeed.value, payloadWeight: elements.payloadWeight.value,
        },
      };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {
        // prévisions trop volumineuses : on garde les points (et leur vent), sans les prévisions brutes
        s.forecasts = null;
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      }
    } catch { /* stockage indisponible */ }
  }

  function restore() {
    let s;
    try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
    if (!s || s.v !== 1 || !Array.isArray(s.waypoints) || !s.waypoints.length || Date.now() - s.savedAt > SESSION_MAX_AGE_MS) return null;
    if ((state.waypoints || []).length) return null;
    try {
      for (const [k, v] of Object.entries(s.inputs || {})) if (elements[k] && v != null && v !== '') elements[k].value = v;
      state.waypoints = s.waypoints;
      state.missionName = s.missionName || '';
      state.forecasts = s.forecasts || null;
      state.lastWindCheckAt = s.lastWindCheckAt || null;
      lastFile = s.lastFile || null;
      planId = s.planId || null;
      if (state.forecasts) refreshMissionEstimates(); else renderWaypoints();
      if (typeof drawWindIndicators === 'function') drawWindIndicators();
      if (typeof updateWindCheckTimer === 'function') updateWindCheckTimer();
      window.requestAnimationFrame(() => { try { zoomToMission(); } catch { /* carte pas prête */ } });
      return { missionName: state.missionName, savedAt: s.savedAt };
    } catch (err) {
      console.warn('Mission sauvegardée illisible :', err);
      try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
      clearMission();
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Thème et ergonomie UAV Maintenance appliqués à WindPath (sans modifier ses fichiers)
  //  1. mode sombre de WindPath imposé (l'application principale est toujours sombre) ;
  //  2. variables de couleur et police remplacées par celles de l'application ;
  //  3. couleurs codées en dur du mode sombre de WindPath recolorées à la volée
  //     (accent vert → bleu, ardoise → bleu nuit), en lisant sa feuille de style ;
  //  4. mise en page resserrée pour l'intégration (titre d'accueil masqué, carte plus large,
  //     étiquettes de vent allégées) — l'impression de WindPath n'est pas touchée.
  // -------------------------------------------------------------------
  function applyUavTheme() {
    const doc = document;
    try { localStorage.setItem('windpath-theme', 'dark'); } catch { /* stockage indisponible */ }
    doc.documentElement.dataset.theme = 'dark';
    doc.documentElement.classList.add('uav-embedded');
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = '#070b16';
    if (!doc.getElementById('uav-font')) {
      const link = doc.createElement('link');
      link.id = 'uav-font'; link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap';
      doc.head.appendChild(link);
    }

    // correspondance couleurs WindPath (sombre) → palette UAV Maintenance, en « r,g,b »
    const MAP = {
      // fonds et bordures (ardoise → bleu nuit)
      '17,25,35': '7,11,22', '24,34,47': '17,26,44', '28,40,55': '22,34,56', '25,37,51': '17,26,44',
      '43,57,72': '28,42,68', '43,57,75': '34,50,80', '48,62,80': '38,54,86', '52,67,86': '42,60,94',
      '52,68,90': '42,60,94', '58,72,90': '46,66,102', '64,80,100': '52,74,112',
      // accent vert → bleu
      '57,184,149': '43,123,224', '38,155,122': '59,140,242', '29,154,119': '43,123,224', '18,129,100': '31,100,190',
      '27,56,47': '22,42,72', '32,61,53': '22,42,72', '145,221,189': '127,182,255',
      // textes
      '228,235,243': '232,238,249', '164,178,196': '160,176,204', '154,168,187': '141,155,181',
    };
    // tout vert / sarcelle (accent de WindPath) → même nuance dans le bleu de l'application (teinte 214°)
    const toBlue = (r, g, b) => {
      const R = r / 255, G = g / 255, B = b / 255;
      const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
      if (!d) return null;
      const s = d / (1 - Math.abs(2 * l - 1));
      let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      h = (h * 60 + 360) % 360;
      if (h < 130 || h > 182 || s < 0.1) return null;
      const H = 214, c = (1 - Math.abs(2 * l - 1)) * Math.min(1, s * 1.05), x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = l - c / 2;
      const [r1, g1, b1] = H < 240 ? [0, x, c] : [x, 0, c]; // 180–240° : (0, x, c)
      return `${Math.round((r1 + m) * 255)},${Math.round((g1 + m) * 255)},${Math.round((b1 + m) * 255)}`;
    };
    const recolor = (text, dark) => text.replace(/rgba?\((\d+),\s*(\d+),\s*(\d+)(\s*[,/]\s*[\d.]+%?)?\)/g, (m, r, g, b, a) => {
      const to = (dark && MAP[`${r},${g},${b}`]) || toBlue(+r, +g, +b);
      return to ? (a ? `rgba(${to},${a.replace(/[,/]\s*/, '').trim()})` : `rgb(${to})`) : m;
    });
    // verts « d'état » conservés (prêt, écart positif, flux en direct) : même convention que l'application
    const KEEP_GREEN = /positive|\.ready|live-pill|api-check/;
    const extra = [];
    for (const sheet of Array.from(doc.styleSheets)) {
      if (!sheet.href || !/\/windpath\/style\.css/.test(sheet.href)) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list, wrap) => {
        for (const rule of Array.from(list)) {
          if (rule.cssRules && rule.conditionText != null) { walk(rule.cssRules, (t) => wrap(`@media ${rule.conditionText}{${t}}`)); continue; }
          if (!rule.selectorText || KEEP_GREEN.test(rule.selectorText)) continue;
          const dark = rule.selectorText.includes('data-theme="dark"');
          // règles du thème clair : seules les couleurs d'accent sont reprises (le reste est déjà remplacé par le mode sombre)
          // seules les déclarations de couleur modifiées sont réémises : réémettre toute la règle
          // écraserait la mise en page responsive de WindPath (placement de la carte et du tableau)
          const decls = [];
          for (let i = 0; i < rule.style.length; i += 1) {
            const prop = rule.style[i];
            const value = rule.style.getPropertyValue(prop);
            const next = recolor(value, dark);
            if (next !== value) decls.push(`${prop}: ${next}${rule.style.getPropertyPriority(prop) ? ' !important' : ''}`);
          }
          if (decls.length) extra.push(wrap(`${rule.selectorText} { ${decls.join('; ')} }`));
        }
      };
      walk(rules, (t) => t);
    }

    let style = doc.getElementById('uav-theme');
    if (!style) { style = doc.createElement('style'); style.id = 'uav-theme'; doc.head.appendChild(style); }
    style.textContent = `
      :root[data-theme="dark"] {
        --ink: #e8eef9; --muted: #8d9bb5; --line: #22324f;
        --green: #2b7be0; --green-dark: #3b8cf2; --green-soft: #162a48;
        --surface: #111a2c; --canvas: #070b16;
        font-family: Inter, "DM Sans", system-ui, sans-serif;
      }
      body { background: #070b16; }
      button, input, select, textarea { font-family: inherit; }
      .theme-toggle { display: none !important; }
      ::selection { background: rgba(79, 156, 249, 0.35); }
      * { scrollbar-color: #2a3c5e transparent; }
      ${extra.join('\n')}

      /* =================================================================
         Intégration UAV (écran uniquement ; l'impression de WindPath n'est pas touchée)
         ================================================================= */
      @media screen {
        .uav-embedded body { font-size: 13px; }
        .uav-embedded .intro { display: none !important; }
        .uav-embedded .brand { height: 54px !important; flex-basis: 54px !important; padding: 8px 16px !important; }
        .uav-embedded .brand-mark { transform: scale(0.78); transform-origin: left center; }
        .uav-embedded .app-shell { grid-template-columns: 300px minmax(0, 1fr) !important; }
        .uav-embedded .sidebar { box-shadow: 1px 0 0 #1b2942 !important; }
        .uav-embedded .sidebar-content { scroll-behavior: smooth; gap: 10px; padding: 10px 0 0; }
        .uav-embedded .panel { margin: 0 12px !important; padding: 13px 14px 12px !important; border-radius: 14px !important; }
        .uav-embedded .section-heading { margin-bottom: 2px; }
        .uav-embedded .section-heading h2 { font-size: 14px !important; letter-spacing: -0.01em; }
        .uav-embedded .step-number { color: #4f9cf9 !important; }
        .uav-embedded .primary-button { border-radius: 11px !important; box-shadow: 0 10px 24px -12px rgba(43, 123, 224, 0.9); }
        .uav-embedded input:focus-visible, .uav-embedded button:focus-visible { outline: 2px solid #4f9cf9; outline-offset: 2px; }
        /* textes trop petits de WindPath (8-10 px) agrandis pour la lecture en Full HD */
        .uav-embedded .energy-field { font-size: 11px !important; }
        .uav-embedded .energy-field small { font-size: 10px !important; }
        .uav-embedded .energy-summary span { font-size: 10.5px !important; }
        .uav-embedded .energy-summary strong { font-size: 13.5px !important; }
        .uav-embedded .summary-row, .uav-embedded .summary-row strong { font-size: 12px !important; }
        .uav-embedded .wind-check-timer { font-size: 11px !important; }
        .uav-embedded .wind-check-timer strong { font-size: 12px !important; }
        .uav-embedded .weather-forecast-button { font-size: 11.5px !important; }
        .uav-embedded .sidebar-footer { padding: 8px 16px 10px !important; gap: 4px !important; }
        .uav-embedded .footer-caption, .uav-embedded .copyright { font-size: 9.5px !important; }

        /* =================================================================
           Panneau gauche « tableau de bord » : toutes les données, sans les longs textes.
           Les textes explicatifs sont masqués ; les valeurs sont montrées en jauge,
           bande de vent, frise horaire et tuiles (widgets ajoutés plus bas par la passerelle).
           ================================================================= */
        .uav-embedded .sidebar { background: radial-gradient(120% 60% at 0% 0%, #10213f 0%, rgba(16, 33, 63, 0) 60%), linear-gradient(180deg, #0b1322, #070b16) !important; }
        .uav-embedded .brand { border-bottom: 1px solid #16223a !important; }
        .uav-embedded .sidebar-content { gap: 9px !important; padding-bottom: 4px !important; }
        .uav-embedded .panel { position: relative; overflow: hidden; flex-shrink: 0 !important; background: linear-gradient(180deg, rgba(22, 34, 58, 0.78), rgba(14, 22, 39, 0.78)) !important;
          border: 1px solid #1c2a45 !important; box-shadow: 0 12px 28px -18px rgba(0, 0, 0, 0.9) !important; }
        .uav-embedded .panel::before { content: ''; position: absolute; inset: 0 0 auto; height: 1px;
          background: linear-gradient(90deg, rgba(79, 156, 249, 0), rgba(79, 156, 249, 0.55), rgba(79, 156, 249, 0)); }
        .uav-embedded .section-heading > div, .uav-embedded .summary-heading { display: flex; align-items: center; gap: 8px; }
        .uav-embedded .section-heading h2, .uav-embedded .summary-heading h2 { font-size: 13.5px !important; font-weight: 700 !important; letter-spacing: -0.01em; margin: 0 !important; }
        .uav-embedded .step-number { display: inline-grid; place-items: center; width: 21px; height: 21px; border-radius: 7px; background: #16294b;
          box-shadow: inset 0 0 0 1px #2a4677; font-size: 10px !important; font-weight: 800 !important; color: #8fc1ff !important; }
        .uav-embedded .summary-heading::before { content: '04'; display: inline-grid; place-items: center; width: 21px; height: 21px; border-radius: 7px;
          background: #16294b; box-shadow: inset 0 0 0 1px #2a4677; font-size: 10px; font-weight: 800; color: #8fc1ff; }

        /* textes longs ou redondants retirés */
        .uav-embedded .mission-panel .divider, .uav-embedded .mission-panel .manual-hint, .uav-embedded .upload-copy > span,
        .uav-embedded .live-pill, .uav-embedded .api-note, .uav-embedded .field-label > span,
        .uav-embedded .aircraft-specs > span:not(:first-of-type), .uav-embedded .energy-method, .uav-embedded .energy-field small,
        .uav-embedded .energy-summary > div:has(#estimatedTotalMah), .uav-embedded .energy-summary > div:has(#estimatedCapacityUsed),
        .uav-embedded #energyWarning, .uav-embedded .summary-note, .uav-embedded .summary-heading > span,
        .uav-embedded .summary-row:has(#summaryTakeoff), .uav-embedded .summary-drop-row, .uav-embedded .summary-row:has(#summaryArrival),
        .uav-embedded .footer-caption { display: none !important; }

        /* 01 · mission : dépôt du fichier sur une ligne + carte d'identité de la mission */
        .uav-embedded .upload-zone { min-height: 0 !important; margin-top: 10px !important; padding: 8px 10px !important; gap: 10px !important; border-radius: 11px !important; }
        .uav-embedded .upload-icon { width: 28px !important; height: 28px !important; flex: 0 0 28px !important; }
        .uav-embedded .upload-copy strong { font-size: 12px !important; }
        .uav-mission-id { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; margin-top: 10px; padding: 9px 11px; border-radius: 11px;
          background: linear-gradient(135deg, #15294d, #101c33); box-shadow: inset 0 0 0 1px #24406f; }
        .uav-mission-id[hidden] { display: none; }
        .uav-mission-id .uav-plane { grid-row: span 2; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: #2b7be0; color: #fff; font-size: 15px;
          box-shadow: 0 6px 16px -6px rgba(43, 123, 224, 0.9); }
        .uav-mission-id b { overflow: hidden; color: #e8eef9; font-size: 12.5px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
        .uav-mission-id span { color: #8d9bb5; font-size: 11px; font-variant-numeric: tabular-nums; }
        .uav-mission-id em { font-style: normal; color: #f5b544; }

        /* 02 · vent : boutons côte à côte, chrono en pastille, bande de vent par point */
        .uav-embedded .route-panel { display: grid !important; grid-template-columns: 1fr 1fr; column-gap: 8px; }
        .uav-embedded .route-panel > * { grid-column: 1 / -1; }
        .uav-embedded .route-panel > .weather-forecast-button { grid-column: auto; margin-top: 8px !important; justify-content: center; }
        .uav-embedded .field-label { margin-top: 10px !important; font-size: 10px !important; text-transform: uppercase; letter-spacing: 0.08em; color: #7f91b2 !important; }
        .uav-embedded .wind-check-timer { justify-self: start; display: inline-flex !important; align-items: center; gap: 7px !important; width: auto !important; margin-top: 10px !important;
          padding: 4px 10px 4px 8px !important; border-radius: 99px !important; background: #0d1628 !important; box-shadow: inset 0 0 0 1px #22324f; }
        .uav-embedded .wind-check-timer::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #5b6b88; }
        .uav-embedded .wind-check-timer.uav-fresh::before { background: #3dd68c; box-shadow: 0 0 0 3px rgba(61, 214, 140, 0.18); }
        .uav-embedded .wind-check-timer.uav-stale::before { background: #f5b544; box-shadow: 0 0 0 3px rgba(245, 181, 68, 0.18); }
        .uav-embedded .wind-check-timer.uav-stale strong { color: #f5b544 !important; }
        .uav-embedded .wind-check-timer svg { display: none; }
        .uav-embedded .wind-check-timer > span { color: #6f84a8 !important; }
        .uav-windstrip { margin-top: 10px; padding: 10px 10px 8px; border-radius: 12px; background: #0b1426; box-shadow: inset 0 0 0 1px #1c2a45; }
        .uav-windstrip[hidden] { display: none; }
        .uav-ws-bars { position: relative; display: flex; align-items: flex-end; gap: 3px; height: 54px; }
        .uav-ws-bars::before, .uav-ws-bars::after { content: ''; position: absolute; left: 0; right: 0; border-top: 1px dashed; pointer-events: none; }
        .uav-ws-bars::before { bottom: var(--warn); border-color: rgba(245, 181, 68, 0.45); }
        .uav-ws-bars::after { bottom: var(--danger); border-color: rgba(242, 109, 109, 0.5); }
        .uav-ws-bar { position: relative; flex: 1; min-width: 4px; border-radius: 4px 4px 2px 2px; background: linear-gradient(180deg, #4f9cf9, #2b5fa8); transition: height .35s ease; }
        .uav-ws-bar.warn { background: linear-gradient(180deg, #f5b544, #a8741b); }
        .uav-ws-bar.danger { background: linear-gradient(180deg, #f26d6d, #a83a3a); }
        .uav-ws-bar.drop { box-shadow: 0 0 0 1.5px #f5b544; }
        .uav-ws-bar i { position: absolute; left: 50%; bottom: calc(100% + 2px); width: 9px; height: 9px; margin-left: -4.5px; color: #8fc1ff; font: 700 9px/9px Inter, sans-serif;
          font-style: normal; text-align: center; transform: rotate(var(--dir)); }
        .uav-ws-axis { display: flex; gap: 3px; margin-top: 4px; }
        .uav-ws-axis span { flex: 1; min-width: 4px; overflow: hidden; color: #5f7397; font-size: 9px; text-align: center; }
        .uav-ws-stats { display: flex; justify-content: space-between; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #1a2741; }
        .uav-ws-stats div { display: grid; gap: 1px; }
        .uav-ws-stats small { color: #6f84a8; font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
        .uav-ws-stats b { color: #e8eef9; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .uav-ws-stats b small { margin-left: 3px; font-size: 9.5px; letter-spacing: 0; text-transform: none; color: #8d9bb5; }
        .uav-ws-stats .warn b { color: #f5b544; } .uav-ws-stats .danger b { color: #f26d6d; }

        /* 03 · batterie : jauge circulaire, réglages en 2 × 2, tuiles */
        .uav-embedded .energy-battery { padding: 4px 8px !important; font-size: 10px !important; color: #9cc7ff !important; background: #16294b !important; }
        .uav-embedded .aircraft-specs { display: flex !important; flex-wrap: wrap; gap: 6px; margin: 8px 0 0 !important; padding: 0 !important; background: none !important; border: 0 !important; }
        .uav-embedded .aircraft-specs > * { padding: 3px 8px; border-radius: 99px; background: #0d1628; box-shadow: inset 0 0 0 1px #22324f; color: #9aa9c4 !important;
          font-size: 10.5px !important; font-weight: 600 !important; }
        .uav-embedded .aircraft-specs > strong { color: #cfe3ff !important; }
        .uav-embedded .energy-inputs { grid-template-columns: 1fr 1fr !important; gap: 8px !important; margin-top: 10px !important; }
        .uav-embedded .energy-field { gap: 4px !important; }
        .uav-embedded .energy-field > span:first-child { font-size: 10px !important; font-weight: 600; color: #7f91b2 !important; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
        .uav-embedded .energy-input-wrap { border-radius: 10px !important; }
        .uav-gauge { display: grid; grid-template-columns: 92px 1fr; gap: 12px; align-items: center; margin-top: 12px; padding: 10px; border-radius: 13px;
          background: #0b1426; box-shadow: inset 0 0 0 1px #1c2a45; }
        .uav-gauge svg { width: 92px; height: 92px; transform: rotate(-90deg); }
        .uav-gauge circle { fill: none; stroke-width: 9; transition: stroke-dasharray .5s ease, stroke-dashoffset .5s ease; }
        .uav-gauge .g-track { stroke: #17243d; }
        .uav-gauge .g-used { stroke: url(#uavGaugeUsed); stroke-linecap: round; }
        .uav-gauge .g-res { stroke: #f5b544; opacity: 0.85; }
        .uav-gauge .g-ring { position: relative; }
        .uav-gauge .g-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
        .uav-gauge .g-center b { color: #fff; font-size: 19px; font-weight: 800; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
        .uav-gauge .g-center small { margin-top: 3px; color: #6f84a8; font-size: 8.5px; font-weight: 700; letter-spacing: 0.12em; }
        .uav-gauge dl { display: grid; gap: 6px; margin: 0; }
        .uav-gauge dl div { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
        .uav-gauge dt { display: flex; align-items: center; gap: 5px; color: #7f91b2; font-size: 10.5px; }
        .uav-gauge dt i { width: 7px; height: 7px; border-radius: 2px; background: #4f9cf9; }
        .uav-gauge dt i.res { background: #f5b544; } .uav-gauge dt i.free { background: #2a3d5f; }
        .uav-gauge dd { margin: 0; color: #e8eef9; font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .uav-gauge dd.ok { color: #3dd68c; } .uav-gauge dd.warn { color: #f5b544; } .uav-gauge dd.danger { color: #f26d6d; }
        .uav-gauge.over .g-used { stroke: #f26d6d; }
        .uav-embedded .energy-summary { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px !important; margin-top: 8px !important; padding: 0 !important; border: 0 !important; }
        .uav-embedded .energy-summary > div { display: grid !important; gap: 2px; margin: 0 !important; padding: 7px 9px !important; border-radius: 10px; background: #0d1628; box-shadow: inset 0 0 0 1px #1a2741; }
        .uav-embedded .energy-summary > div:has(#actualTotalMah) { grid-column: 1 / -1; background: linear-gradient(90deg, #13284b, #0d1628); box-shadow: inset 0 0 0 1px #24406f; }
        .uav-embedded .energy-summary span { color: #6f84a8 !important; font-size: 9.5px !important; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
        .uav-embedded .energy-summary strong { color: #e8eef9 !important; font-size: 13px !important; font-variant-numeric: tabular-nums; }
        .uav-alerts { display: grid; gap: 5px; margin-top: 8px; }
        .uav-alerts[hidden] { display: none; }
        .uav-alerts p { display: flex; gap: 7px; margin: 0; padding: 6px 9px; border-radius: 9px; background: rgba(245, 181, 68, 0.09); box-shadow: inset 2px 0 0 #f5b544;
          color: #f3d9a4; font-size: 11px; line-height: 1.35; }
        .uav-alerts p.danger { background: rgba(242, 109, 109, 0.1); box-shadow: inset 2px 0 0 #f26d6d; color: #ffc4c4; }

        /* 04 · synthèse : frise décollage → largage → arrivée, puis tuiles */
        .uav-embedded .mission-summary { display: grid !important; grid-template-columns: 1fr 1fr; gap: 6px !important; }
        .uav-embedded .mission-summary > * { grid-column: 1 / -1; }
        .uav-embedded .mission-summary > .summary-row { grid-column: auto; display: grid !important; gap: 2px; margin: 0 !important; padding: 7px 9px !important; border: 0 !important;
          border-radius: 10px; background: #0d1628; box-shadow: inset 0 0 0 1px #1a2741; }
        .uav-embedded .mission-summary > .summary-row > span { color: #6f84a8 !important; font-size: 9.5px !important; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
        .uav-embedded .mission-summary > .summary-row > strong { color: #e8eef9 !important; font-size: 13px !important; text-align: left !important; font-variant-numeric: tabular-nums; }
        .uav-embedded .mission-summary > .summary-row { order: 3; }
        .uav-embedded .mission-summary > .summary-heading, .uav-embedded .mission-summary > .uav-timeline { order: 0; }
        .uav-embedded .mission-summary > .summary-row:has(#summaryDistance) { order: 1; }
        .uav-embedded .mission-summary > .summary-row:has(#summaryWind) { order: 2; }
        .uav-embedded .mission-summary > .summary-row:has(#summaryPressureAltitudeChange) { grid-column: 1 / -1; order: 4; }
        .uav-embedded .mission-summary > .summary-row.summary-drop-row { display: none !important; }
        .uav-embedded .summary-heading { justify-content: flex-start !important; }
        .uav-timeline { position: relative; margin: 4px 0 4px; padding: 12px 10px 10px; border-radius: 12px; background: #0b1426; box-shadow: inset 0 0 0 1px #1c2a45; }
        .uav-timeline[hidden] { display: none; }
        .uav-tl-track { position: relative; display: flex; justify-content: space-between; }
        .uav-tl-track::before { content: ''; position: absolute; left: 6px; right: 6px; top: 5px; height: 2px; border-radius: 2px;
          background: linear-gradient(90deg, #2b7be0, #f5b544 var(--drop, 50%), #3dd68c); opacity: 0.85; }
        .uav-tl-stop { position: relative; display: grid; justify-items: center; gap: 3px; min-width: 0; }
        .uav-tl-stop:first-child { justify-items: start; } .uav-tl-stop:last-child { justify-items: end; }
        .uav-tl-stop i { width: 12px; height: 12px; border-radius: 50%; background: #0b1426; box-shadow: inset 0 0 0 3px #4f9cf9; }
        .uav-tl-stop.drop i { box-shadow: inset 0 0 0 3px #f5b544; } .uav-tl-stop.land i { box-shadow: inset 0 0 0 3px #3dd68c; }
        .uav-tl-stop b { margin-top: 2px; color: #fff; font-size: 14px; font-weight: 800; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
        .uav-tl-stop small { overflow: hidden; max-width: 90px; color: #6f84a8; font-size: 9.5px; font-weight: 600; letter-spacing: 0.05em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
        .uav-tl-dur { position: absolute; left: 50%; top: -9px; transform: translateX(-50%); padding: 1px 8px; border-radius: 99px; background: #16294b; color: #9cc7ff;
          font-size: 10px; font-weight: 700; white-space: nowrap; box-shadow: inset 0 0 0 1px #2a4677; }

        /* =================================================================
           Panneau de droite (04 · batterie) : budget, indicateurs, graphiques en cartes
           ================================================================= */
        .uav-embedded .energy-dashboard { padding: 12px !important; background: linear-gradient(180deg, #0f1a2e, #0a1222) !important; }
        .uav-embedded .energy-dashboard .energy-method, .uav-embedded .battery-budget-legend { display: none !important; }
        .uav-embedded .dashboard-heading h2 { font-size: 13.5px !important; font-weight: 700 !important; font-family: inherit !important; }
        .uav-embedded .dashboard-heading > span { display: inline-flex; gap: 10px; padding: 3px 9px; border-radius: 99px; background: #0b1426; box-shadow: inset 0 0 0 1px #22324f;
          font-size: 0 !important; }
        .uav-embedded .dashboard-heading > span::before, .uav-embedded .dashboard-heading > span::after { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }
        .uav-embedded .dashboard-heading > span::before { content: '● Estimé'; color: #7fb6ff; }
        .uav-embedded .dashboard-heading > span::after { content: '● Réel'; color: #3dd68c; }
        /* budget */
        .uav-embedded .battery-budget { margin-top: 12px !important; padding: 13px 13px 11px !important; border: 0 !important; border-radius: 14px;
          background: radial-gradient(120% 90% at 0% 0%, #15305a 0%, rgba(21, 48, 90, 0) 55%), #0b1426 !important; box-shadow: inset 0 0 0 1px #1c2a45; }
        .uav-embedded .battery-budget-heading > div > span:first-child { color: #7f91b2 !important; font-size: 9.5px !important; letter-spacing: 0.1em; }
        .uav-embedded .battery-budget-heading strong { color: #fff !important; font: 800 26px/1.05 Inter, sans-serif !important; letter-spacing: -0.02em; }
        .uav-embedded .battery-budget-heading small { color: #6f84a8 !important; font-size: 10px !important; }
        .uav-embedded .battery-budget-planned strong { color: #9cc7ff !important; font-size: 15px !important; }
        .uav-embedded .battery-budget-planned span { color: #f5b544 !important; font-size: 10.5px !important; }
        .uav-embedded .battery-budget-meter { height: 14px !important; margin-top: 12px !important; border-radius: 99px !important; background: #17243d !important;
          box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5); }
        .uav-embedded .battery-meter-used { background: linear-gradient(90deg, #2b7be0, #7fb6ff) !important; border-radius: 99px 0 0 99px; box-shadow: 0 0 14px rgba(79, 156, 249, 0.6); }
        .uav-embedded .battery-meter-reserve { background: repeating-linear-gradient(-45deg, #f5b544 0 4px, #c98a20 4px 8px) !important; }
        .uav-embedded .battery-meter-remaining { background: transparent !important; }
        .uav-embedded .battery-budget-stats { grid-template-columns: repeat(3, 1fr) !important; gap: 6px !important; margin-top: 10px !important; }
        .uav-embedded .battery-budget-stats > div { gap: 2px !important; padding: 7px 8px; border-radius: 10px; background: #0f1a2e; box-shadow: inset 0 0 0 1px #1a2741; }
        .uav-embedded .battery-budget-stats > div:nth-child(1) { order: 2; } .uav-embedded .battery-budget-stats > div:nth-child(2) { order: 1; } .uav-embedded .battery-budget-stats > div:nth-child(3) { order: 3; }
        .uav-embedded .battery-budget-stats span { display: flex; align-items: center; gap: 5px; color: #6f84a8 !important; font-size: 9.5px !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .uav-embedded .battery-budget-stats span::before { content: ''; flex: 0 0 7px; height: 7px; border-radius: 2px; background: #f5b544; }
        .uav-embedded .battery-budget-stats > div:nth-child(2) span::before { background: #4f9cf9; }
        .uav-embedded .battery-budget-stats > div:nth-child(3) span::before { background: #2a3d5f; }
        .uav-embedded .battery-budget-stats strong { color: #e8eef9 !important; font-size: 13px !important; }
        .uav-embedded .battery-budget-status { margin-top: 8px !important; color: #7f91b2 !important; font-size: 10.5px !important; }
        /* indicateurs */
        .uav-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }
        .uav-kpis[hidden] { display: none; }
        .uav-kpis div { display: grid; gap: 1px; padding: 8px 9px; border-radius: 12px; background: #0b1426; box-shadow: inset 0 0 0 1px #1c2a45; }
        .uav-kpis small { color: #6f84a8; font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
        .uav-kpis b { color: #fff; font-size: 16px; font-weight: 800; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
        .uav-kpis b small { margin-left: 2px; font-size: 10px; letter-spacing: 0; text-transform: none; color: #8d9bb5; }
        .uav-kpis em { color: #5f7397; font-size: 10px; font-style: normal; }
        /* graphiques */
        .uav-embedded .energy-chart-card { display: block !important; margin-top: 8px; padding: 10px 10px 2px; border-radius: 14px; background: #0b1426; box-shadow: inset 0 0 0 1px #1c2a45; }
        .uav-embedded .energy-chart-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .uav-embedded .energy-chart-heading strong { color: #cfdcf2 !important; font-size: 12px !important; font-weight: 700 !important; }
        .uav-embedded .energy-chart-heading span { padding: 2px 8px; border-radius: 99px; background: #13213b; color: #9cc7ff !important; font-size: 10.5px !important; font-weight: 700;
          font-variant-numeric: tabular-nums; white-space: nowrap; text-transform: none !important; }
        .uav-embedded .energy-chart-scroll { margin: 0 -4px !important; }
        .uav-embedded .energy-chart { height: 150px !important; }
        .uav-embedded .chart-grid { stroke: #1a2741 !important; stroke-dasharray: 2 4; }
        .uav-embedded .chart-axis { fill: #5f7397 !important; font: 600 8.5px Inter, sans-serif !important; }
        .uav-embedded .chart-legend { font: 700 8.5px Inter, sans-serif !important; letter-spacing: 0.04em; }
        .uav-embedded .estimate-legend { fill: #7fb6ff !important; }
        .uav-embedded .actual-legend { fill: #3dd68c !important; }
        .uav-embedded .voltage-chart .estimate-legend { fill: #f5b544 !important; }
        /* légende globale dans l'en-tête : seule la tension (courbe estimée orange) garde la sienne */
        .uav-embedded .energy-chart:not(.voltage-chart) .chart-legend { display: none; }
        .uav-embedded .chart-empty { fill: #5f7397 !important; font: 500 10px Inter, sans-serif !important; }
        .uav-embedded .chart-bar-estimate { fill: url(#uavBarEst) !important; opacity: 0.8; transition: opacity .2s; }
        .uav-embedded .chart-bar-estimate.uav-peak { opacity: 1; filter: drop-shadow(0 0 6px rgba(79, 156, 249, 0.7)); }
        .uav-embedded .chart-bar-estimate:hover, .uav-embedded .chart-bar-actual:hover { opacity: 1; }
        .uav-embedded .chart-bar-actual { fill: url(#uavBarReal) !important; }
        .uav-embedded .chart-cumulative-estimate { stroke: #4f9cf9 !important; stroke-width: 2.5 !important; filter: drop-shadow(0 0 4px rgba(79, 156, 249, 0.6)); }
        .uav-embedded .chart-cumulative-estimate-point { fill: #0b1426 !important; stroke: #4f9cf9 !important; stroke-width: 2 !important; r: 3.2px; }
        .uav-embedded .chart-cumulative-actual { stroke: #3dd68c !important; stroke-width: 2.5 !important; }
        .uav-embedded .chart-cumulative-actual-point, .uav-embedded .chart-voltage-actual-point { fill: #3dd68c !important; stroke: #0b1426 !important; stroke-width: 2 !important; }
        .uav-embedded .chart-voltage-estimate-line { stroke: #f5b544 !important; stroke-width: 2.5 !important; filter: drop-shadow(0 0 4px rgba(245, 181, 68, 0.5)); }
        .uav-embedded .chart-voltage-estimate-point { fill: #0b1426 !important; stroke: #f5b544 !important; stroke-width: 2 !important; }
        .uav-embedded .chart-voltage-actual-line { stroke: #3dd68c !important; stroke-width: 2 !important; }
        .uav-embedded .uav-area-blue { fill: url(#uavAreaBlue); }
        .uav-embedded .uav-area-amber { fill: url(#uavAreaAmber); }
        .uav-embedded .uav-drop-line { stroke: #f5b544; stroke-width: 1.2; stroke-dasharray: 3 3; opacity: 0.8; }
        .uav-embedded .uav-drop-tag { fill: #f5b544; font: 800 8px Inter, sans-serif; letter-spacing: 0.08em; }

        .uav-embedded .sidebar-footer { flex-direction: row !important; flex-wrap: wrap; align-items: center; justify-content: space-between; border-top: 1px solid #16223a !important; }
        .uav-embedded .forecast-source { font-size: 11px !important; }

        /* =================================================================
           Carte : fonds au choix, route « vivante », marqueurs d'état, drones recalé / fantôme
           ================================================================= */
        .uav-embedded:not(.uav-basemap-plan) .leaflet-tile-pane { filter: none !important; }
        .uav-embedded.uav-basemap-sat .leaflet-tile-pane { filter: brightness(.8) saturate(.95) contrast(1.06) !important; }
        .uav-embedded.uav-basemap-topo .leaflet-tile-pane { filter: brightness(.74) contrast(1.06) saturate(.85) !important; }
        .uav-embedded .leaflet-container { background: #070b16 !important; }
        .uav-basemaps { position: absolute; left: 14px; bottom: 52px; z-index: 650; display: flex; gap: 6px; padding: 6px; border-radius: 14px;
          background: rgba(9, 15, 28, 0.8); backdrop-filter: blur(8px); box-shadow: inset 0 0 0 1px #22324f, 0 12px 30px -12px rgba(0, 0, 0, 0.9); }
        .uav-basemaps button { display: none; gap: 4px; justify-items: center; width: 58px; padding: 0; border: 0; background: none; cursor: pointer;
          color: #8d9bb5; font: 600 10px Inter, sans-serif; }
        .uav-basemaps button.active, .uav-basemaps:hover button, .uav-basemaps:focus-within button { display: grid; }
        .uav-basemaps button i { display: block; width: 58px; height: 40px; border-radius: 9px; background: #111a2c center / cover;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); transition: transform .15s; }
        .uav-basemaps button:hover i { transform: translateY(-2px); }
        .uav-basemaps button.active i { box-shadow: 0 0 0 2px #4f9cf9, 0 0 14px rgba(79, 156, 249, 0.6); }
        .uav-basemaps button.active span { color: #fff; }
        .uav-basemaps button.plan i { filter: brightness(.68) invert(.88) hue-rotate(180deg) saturate(.7); }
        .uav-basemaps:not(:hover):not(:focus-within) button.active span::after { content: ' ▸'; color: #4f9cf9; }

        /* route : flux animé sur la partie restante */
        .uav-flow { stroke-dasharray: 2 16; animation: uavFlow 1.1s linear infinite; }
        @keyframes uavFlow { to { stroke-dashoffset: -18; } }
        .uav-leg-icon, .uav-gap-icon, .uav-mk { background: none !important; border: 0 !important; }
        .uav-leg { position: absolute; transform: translate(-50%, -50%); display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 6px; border-radius: 99px;
          background: rgba(9, 15, 28, 0.86); box-shadow: inset 0 0 0 1px #2a4677; color: #cfe3ff; font: 700 10.5px Inter, sans-serif; white-space: nowrap;
          font-variant-numeric: tabular-nums; pointer-events: none; }
        .uav-leg i { display: inline-block; color: #7fb6ff; font-style: normal; transform: rotate(var(--b)); }
        .uav-leg.flown { box-shadow: inset 0 0 0 1px #2bb673; color: #b8f5d4; } .uav-leg.flown i { color: #3dd68c; }
        .uav-leg.short, .uav-zoom-far .uav-leg { display: none; }

        /* marqueurs de points */
        .uav-mk-node { position: absolute; left: 3px; top: 3px; z-index: 2; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
          background: #0b1426; color: #cfe3ff; font: 800 10.5px Inter, sans-serif; box-shadow: 0 0 0 2px #4f9cf9, 0 4px 12px rgba(0, 0, 0, 0.6); }
        .uav-mk.done .uav-mk-node { background: #3dd68c; color: #04210f; box-shadow: 0 0 0 2px #b8f5d4, 0 4px 12px rgba(0, 0, 0, 0.6); }
        .uav-mk.next .uav-mk-node { background: #2b7be0; color: #fff; box-shadow: 0 0 0 2px #cfe3ff, 0 4px 12px rgba(0, 0, 0, 0.6); }
        .uav-mk.next .uav-mk-node::after { content: ''; position: absolute; inset: -2px; border-radius: inherit; animation: uavRing 1.8s ease-out infinite; }
        @keyframes uavRing { 0% { box-shadow: 0 0 0 0 rgba(79, 156, 249, 0.75); } 100% { box-shadow: 0 0 0 16px rgba(79, 156, 249, 0); } }
        .uav-mk.home .uav-mk-node { border-radius: 8px; background: #13213b; color: #fff; font-size: 12px; box-shadow: 0 0 0 2px #9cc7ff, 0 4px 12px rgba(0, 0, 0, 0.6); }
        .uav-mk.home.done .uav-mk-node { background: #1c6b46; }
        .uav-mk.drop .uav-mk-node { border-radius: 5px; transform: rotate(45deg); background: #f5b544; color: #2a1d05; box-shadow: 0 0 0 2px #ffe2a8, 0 0 18px rgba(245, 181, 68, 0.6); }
        .uav-mk.drop .uav-mk-node b { transform: rotate(-45deg); }
        .uav-mk.selected .uav-mk-node { outline: 3px solid rgba(255, 255, 255, 0.55); outline-offset: 2px; }
        .uav-mk-target { position: absolute; left: 15px; top: 15px; width: 0; height: 0; z-index: 1; pointer-events: none; }
        .uav-mk-target::before, .uav-mk-target::after { content: ''; position: absolute; border-radius: 50%; transform: translate(-50%, -50%); }
        .uav-mk-target::before { width: 50px; height: 50px; border: 2px dashed rgba(245, 181, 68, 0.8); animation: uavSpin 9s linear infinite; }
        .uav-mk-target::after { width: 84px; height: 84px; border: 1px solid rgba(245, 181, 68, 0.35); background: radial-gradient(circle, rgba(245, 181, 68, 0.14), rgba(245, 181, 68, 0) 70%);
          animation: uavBreath 2.4s ease-in-out infinite; }
        @keyframes uavSpin { to { transform: translate(-50%, -50%) rotate(360deg); } }
        @keyframes uavBreath { 50% { transform: translate(-50%, -50%) scale(1.12); opacity: 0.6; } }
        .uav-mk-wind { position: absolute; left: 34px; top: 4px; display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 3px; border-radius: 99px;
          background: rgba(9, 15, 28, 0.88); box-shadow: inset 0 0 0 1px #2a4677; color: #e8eef9; font: 700 11px Inter, sans-serif; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .uav-mk-wind i { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: #16294b; color: #7fb6ff; font-style: normal; font-size: 11px; }
        .uav-mk-wind i span { display: block; transform: rotate(var(--dir)); }
        .uav-mk-wind small { color: #7f91b2; font-size: 9px; }
        .uav-mk-wind.warn { box-shadow: inset 0 0 0 1px #8a6420; color: #f5b544; } .uav-mk-wind.warn i { color: #f5b544; background: #3d2d10; }
        .uav-mk-wind.danger { box-shadow: inset 0 0 0 1px #8a3434; color: #f26d6d; } .uav-mk-wind.danger i { color: #f26d6d; background: #3a1616; }
        .uav-mk-drop { position: absolute; left: 34px; top: 30px; padding: 2px 7px; border-radius: 6px; background: #3d2d10; box-shadow: inset 0 0 0 1px #8a6420;
          color: #f5b544; font: 800 10px Inter, sans-serif; letter-spacing: 0.04em; white-space: nowrap; }
        .uav-mk-when { position: absolute; left: 34px; top: -17px; padding: 1px 7px; border-radius: 99px; background: #2b7be0; color: #fff; font: 700 10px Inter, sans-serif;
          white-space: nowrap; box-shadow: 0 4px 12px -4px rgba(43, 123, 224, 0.9); }
        .uav-mk-when.late { background: #a8741b; }
        .uav-zoom-far .uav-mk-wind, .uav-zoom-far .uav-mk-when { display: none; }
        .uav-zoom-far .uav-mk-target::after { display: none; }

        /* drones : recalé (principal) et estimé (fantôme du plan) */
        .uav-embedded .live-drone-marker, .uav-embedded .reference-drone-marker { opacity: 1 !important; }
        .uav-embedded .live-drone-symbol { background: #2b7be0 !important; border: 2px solid #cfe3ff !important; box-shadow: 0 0 0 6px rgba(79, 156, 249, 0.2), 0 6px 16px rgba(0, 0, 0, 0.6) !important; }
        .uav-embedded .live-drone-plane { fill: #fff !important; }
        .uav-embedded .live-drone-details, .uav-embedded .reference-drone-details { gap: 1px !important; padding: 5px 9px; border-radius: 10px; background: rgba(9, 15, 28, 0.92);
          box-shadow: inset 0 0 0 1px #2f5fa3, 0 8px 20px -8px rgba(0, 0, 0, 0.8); }
        .uav-embedded .reference-drone-details { box-shadow: inset 0 0 0 1px #2bb673, 0 8px 20px -8px rgba(0, 0, 0, 0.8); }
        .uav-embedded .live-drone-details > span, .uav-embedded .reference-drone-details > span { padding: 0 !important; border: 0 !important; background: none !important; box-shadow: none !important;
          color: #cfdcf2 !important; font: 600 10.5px Inter, sans-serif !important; white-space: nowrap; }
        .uav-embedded .live-drone-status { color: #8fc1ff !important; font-weight: 800 !important; font-size: 9.5px !important; letter-spacing: 0.08em; }
        .uav-embedded .reference-drone-badge { color: #5ef0a6 !important; font-weight: 800 !important; font-size: 9.5px !important; letter-spacing: 0.08em; }
        .uav-embedded .reference-drone-symbol { position: relative; background: #3dd68c !important; border: 2px solid #eafff3 !important; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.6) !important; }
        .uav-embedded .reference-drone-symbol::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; animation: uavRealPulse 1.8s ease-out infinite; }
        @keyframes uavRealPulse { 0% { box-shadow: 0 0 0 0 rgba(61, 214, 140, 0.7); } 100% { box-shadow: 0 0 0 18px rgba(61, 214, 140, 0); } }
        .uav-embedded .reference-drone-plane { fill: #04210f !important; }
        .uav-has-real .live-drone-symbol { background: rgba(79, 156, 249, 0.12) !important; border: 2px dashed #9cc7ff !important; box-shadow: none !important; }
        .uav-has-real .live-drone-plane { fill: #9cc7ff !important; }
        .uav-has-real .live-drone-details { display: none !important; }
        .uav-has-real .live-drone-marker { opacity: 0.75 !important; }
        .uav-gap { stroke-dasharray: 3 6; }
        .uav-embedded .reference-drone-details > .uav-gap-text { margin-top: 3px !important; padding: 1px 7px !important; border-radius: 6px; font-weight: 800 !important;
          font-variant-numeric: tabular-nums; background: rgba(61, 214, 140, 0.14) !important; color: #5ef0a6 !important; }
        .uav-embedded .reference-drone-details > .uav-gap-text.warn { background: rgba(245, 181, 68, 0.14) !important; color: #f5b544 !important; }
        .uav-embedded .reference-drone-details > .uav-gap-text.danger { background: rgba(242, 109, 109, 0.14) !important; color: #ff9c9c !important; }
        .uav-embedded .reference-drone-marker { width: 260px !important; height: auto !important; align-items: flex-start !important; }

        /* voix de mission : bouton, réglages, sous-titres */
        .uav-voice { position: relative; }
        .uav-voice-btn { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid #2a4677;
          background: rgba(9, 15, 28, 0.88); color: #cfe3ff; font: 700 11.5px Inter, sans-serif; cursor: pointer; }
        .uav-voice-btn.on { border-color: #2bb673; color: #5ef0a6; }
        .uav-voice-btn .uav-eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
        .uav-voice-btn .uav-eq i { width: 2px; height: 4px; border-radius: 1px; background: currentColor; }
        .uav-speaking .uav-voice-btn .uav-eq i { animation: uavEq .5s ease-in-out infinite alternate; }
        .uav-voice-btn .uav-eq i:nth-child(2) { animation-delay: .15s !important; } .uav-voice-btn .uav-eq i:nth-child(3) { animation-delay: .3s !important; }
        @keyframes uavEq { to { height: 12px; } }
        .uav-voice-pop { position: absolute; top: 44px; right: 0; z-index: 1300; display: grid; gap: 10px; width: 290px; padding: 14px; border-radius: 14px;
          background: rgba(9, 15, 28, 0.97); box-shadow: inset 0 0 0 1px #2a4677, 0 18px 40px -12px rgba(0, 0, 0, 0.9); color: #cfdcf2; font: 500 12px Inter, sans-serif; }
        .uav-voice-pop[hidden] { display: none; }
        .uav-voice-pop b { color: #fff; font-size: 13px; }
        .uav-voice-pop label { display: grid; gap: 4px; color: #7f91b2; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
        .uav-voice-pop select, .uav-voice-pop input[type="range"] { width: 100%; }
        .uav-voice-pop select { height: 32px; padding: 0 8px; border-radius: 8px; border: 1px solid #2a4677; background: #0d1628; color: #e8eef9; font: 500 12px Inter, sans-serif; text-transform: none; }
        .uav-voice-pop .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .uav-voice-pop .switch { position: relative; width: 38px; height: 22px; border-radius: 99px; border: 0; background: #22324f; cursor: pointer; transition: background .2s; }
        .uav-voice-pop .switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .2s; }
        .uav-voice-pop .switch[aria-checked="true"] { background: #2bb673; } .uav-voice-pop .switch[aria-checked="true"]::after { transform: translateX(16px); }
        .uav-voice-pop .test { height: 32px; border-radius: 8px; border: 1px solid #2f5fa3; background: #13213b; color: #9cc7ff; font: 700 12px Inter, sans-serif; cursor: pointer; }
        .uav-voice-pop small { color: #6f84a8; font-size: 10.5px; line-height: 1.4; text-transform: none; letter-spacing: 0; font-weight: 500; }
        .uav-caption { position: absolute; left: 50%; bottom: 54px; z-index: 660; display: flex; align-items: center; gap: 10px; max-width: min(720px, 80%); padding: 9px 16px 9px 12px;
          border-radius: 14px; transform: translateX(-50%); background: rgba(9, 15, 28, 0.93); box-shadow: inset 0 0 0 1px #2f5fa3, 0 14px 34px -12px rgba(0, 0, 0, 0.9);
          color: #fff; font: 600 14px/1.35 Inter, sans-serif; transition: opacity .3s, transform .3s; pointer-events: none; }
        .uav-caption[hidden] { display: flex; opacity: 0; transform: translate(-50%, 8px); }
        .uav-caption::before { content: '🔊'; font-size: 16px; }
        .uav-caption.urgent { box-shadow: inset 0 0 0 1.5px #f5b544, 0 0 30px -6px rgba(245, 181, 68, 0.6); }
        .uav-caption.urgent::before { content: '⚠'; color: #f5b544; }

        /* trafic : autres drones du drone port */
        .uav-tf-icon { background: none !important; border: 0 !important; }
        .uav-tf { position: relative; }
        .uav-tf-sym { position: absolute; left: 0; top: 0; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
          background: #7c4dff; border: 2px solid #e6dcff; box-shadow: 0 0 0 5px rgba(180, 140, 255, 0.22), 0 6px 16px rgba(0, 0, 0, 0.6); }
        .uav-tf-sym svg { width: 17px; height: 17px; fill: #fff; transition: transform .4s; }
        .uav-tf.sol .uav-tf-sym, .uav-tf.arrive .uav-tf-sym { width: 22px; height: 22px; left: 4px; top: 4px; background: #3b2a66; box-shadow: none; }
        .uav-tf.sol .uav-tf-sym svg, .uav-tf.arrive .uav-tf-sym svg { width: 12px; height: 12px; }
        .uav-tf-card { position: absolute; left: 38px; top: -4px; display: grid; gap: 1px; padding: 5px 9px; border-radius: 10px; background: rgba(9, 15, 28, 0.93);
          box-shadow: inset 0 0 0 1px #7c4dff, 0 8px 20px -8px rgba(0, 0, 0, 0.8); color: #ddd0ff; font: 600 10.5px Inter, sans-serif; white-space: nowrap; }
        .uav-tf-card b { display: flex; align-items: center; gap: 6px; color: #fff; font-size: 11.5px; font-weight: 800; }
        .uav-tf-card b small { color: #b9a6ef; font-size: 10px; font-weight: 600; }
        .uav-tf-card em { margin-top: 2px; padding: 1px 6px; border-radius: 6px; font-style: normal; font-weight: 800; background: rgba(245, 181, 68, 0.15); color: #f5b544; }
        .uav-tf.sol .uav-tf-card, .uav-tf.arrive .uav-tf-card { opacity: 0.8; }
        .uav-tf.warn .uav-tf-sym { background: #a8741b; border-color: #ffe2a8; box-shadow: 0 0 0 6px rgba(245, 181, 68, 0.3); }
        .uav-tf.warn .uav-tf-card { box-shadow: inset 0 0 0 1.5px #f5b544, 0 8px 20px -8px rgba(0, 0, 0, 0.8); }
        .uav-tf.danger .uav-tf-sym { background: #c0392b; border-color: #ffd0d0; animation: uavTfAlarm 1s ease-out infinite; }
        .uav-tf.danger .uav-tf-card { box-shadow: inset 0 0 0 2px #f26d6d, 0 0 26px -4px rgba(242, 109, 109, 0.7); }
        .uav-tf.danger .uav-tf-card em { background: rgba(242, 109, 109, 0.2); color: #ff9c9c; }
        @keyframes uavTfAlarm { 0% { box-shadow: 0 0 0 0 rgba(242, 109, 109, 0.8); } 100% { box-shadow: 0 0 0 22px rgba(242, 109, 109, 0); } }
        .sig { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px; }
        .sig.ok { background: #3dd68c; box-shadow: 0 0 0 2px rgba(61, 214, 140, 0.25); } .sig.late { background: #f5b544; } .sig.lost { background: #f26d6d; }
        .uav-traffic { position: relative; }
        .uav-traffic-btn { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid #4a3a80;
          background: rgba(9, 15, 28, 0.88); color: #ddd0ff; font: 700 11.5px Inter, sans-serif; cursor: pointer; }
        .uav-traffic-btn b { padding: 0 6px; border-radius: 99px; background: #7c4dff; color: #fff; font-size: 10.5px; }
        .uav-tf-dot { width: 7px; height: 7px; border-radius: 50%; background: #5f7397; }
        .uav-traffic-btn.sharing .uav-tf-dot { background: #3dd68c; box-shadow: 0 0 0 3px rgba(61, 214, 140, 0.2); }
        .uav-traffic-btn.warn { border-color: #f5b544; color: #f5b544; }
        .uav-traffic-btn.danger { border-color: #f26d6d; color: #ff9c9c; animation: uavBlink 1s ease-in-out infinite; }
        .uav-traffic-pop { position: absolute; top: 44px; right: 0; z-index: 1300; display: grid; gap: 6px; width: 300px; padding: 12px; border-radius: 14px;
          background: rgba(9, 15, 28, 0.97); box-shadow: inset 0 0 0 1px #4a3a80, 0 18px 40px -12px rgba(0, 0, 0, 0.9); color: #cfdcf2; font: 500 12px Inter, sans-serif; }
        .uav-traffic-pop[hidden] { display: none; }
        .uav-traffic-pop .title { color: #fff; font-size: 13px; margin-bottom: 2px; }
        .uav-traffic-pop button { display: grid; grid-template-columns: 10px auto 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 7px 9px;
          border-radius: 10px; border: 0; background: #131d33; color: #e8eef9; text-align: left; cursor: pointer; font: inherit; }
        .uav-traffic-pop button:hover { background: #1b2944; }
        .uav-traffic-pop button small { grid-column: 2 / -1; color: #8d9bb5; font-size: 10.5px; }
        .uav-traffic-pop button span { color: #b9a6ef; font-size: 11px; }
        .uav-traffic-pop button.warn { box-shadow: inset 2px 0 0 #f5b544; } .uav-traffic-pop button.danger { box-shadow: inset 2px 0 0 #f26d6d; }
        .uav-traffic-pop p { margin: 0; font-size: 11px; line-height: 1.4; }
        .uav-traffic-pop .empty { color: #6f84a8; }
        .uav-traffic-pop .self { margin-top: 4px; padding-top: 8px; border-top: 1px solid #1a2741; }
        .uav-traffic-pop .self.ok { color: #5ef0a6; } .uav-traffic-pop .self.off { color: #f5b544; }

        /* légende de la carte */
        .uav-embedded .map-legend { display: inline-flex !important; align-items: center; gap: 7px !important; font-size: 11px !important; }
        .uav-lg { display: inline-block; width: 16px; height: 3px; border-radius: 2px; }
        .uav-lg.flown { background: #3dd68c; } .uav-lg.todo { background: #4f9cf9; }
        .uav-lg.drop { width: 8px; height: 8px; border-radius: 2px; background: #f5b544; transform: rotate(45deg); }
        .uav-lg.ghost { width: 9px; height: 9px; border-radius: 50%; border: 1.5px dashed #9cc7ff; }
        .uav-lg.real { width: 9px; height: 9px; border-radius: 50%; background: #3dd68c; }
        .uav-delay-chip { padding: 3px 9px; border-radius: 99px; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums;
          background: rgba(61, 214, 140, 0.12); color: #5ef0a6; box-shadow: inset 0 0 0 1px rgba(43, 182, 115, 0.6); }
        .uav-delay-chip.warn { background: rgba(245, 181, 68, 0.12); color: #f5b544; box-shadow: inset 0 0 0 1px rgba(245, 181, 68, 0.5); }
        .uav-delay-chip.danger { background: rgba(242, 109, 109, 0.12); color: #ff9c9c; box-shadow: inset 0 0 0 1px rgba(242, 109, 109, 0.5); }

        /* ---- Carte : étiquettes de vent allégées (détail au survol) ---- */
        .uav-embedded .map-wind-label .map-wind-direction,
        .uav-embedded .map-wind-label .map-wind-gust { display: none; }
        .uav-embedded .map-wind-label:hover .map-wind-direction,
        .uav-embedded .map-wind-label:hover .map-wind-gust { display: inline; }
        .uav-embedded .map-wind-label { padding-inline: 7px !important; gap: 4px !important; }

        /* ---- Tableau des points : la ligne entière tient sur la largeur (Full HD) ---- */
        .uav-embedded .workspace-area { gap: 8px !important; padding: 8px !important; }
        .uav-embedded .waypoint-table-panel { padding: 8px 10px 8px !important; border-color: #22324f !important; }
        .uav-embedded .waypoints-heading { margin-bottom: 6px !important; }
        .uav-embedded .waypoint-table { width: 100% !important; min-width: 0 !important; font-size: 12.5px !important; }
        .uav-embedded .waypoint-table th { padding: 6px 8px !important; font-size: 10px !important; line-height: 1.25; letter-spacing: 0.03em; text-transform: uppercase;
          white-space: normal !important; vertical-align: bottom; top: 26px !important; }
        .uav-embedded .waypoint-table td { padding: 6px 8px !important; }
        .uav-embedded .waypoint-table tbody tr:nth-child(even) td { background: #141f33 !important; }
        .uav-embedded .waypoint-table tr:hover td { background: #1a2944 !important; }
        .uav-embedded .waypoint-table tr:focus-within td { background: #182c4d !important; box-shadow: inset 0 1px 0 #2f5fa3, inset 0 -1px 0 #2f5fa3; }
        .uav-embedded .waypoint-table th:first-child,
        .uav-embedded .waypoint-table td:first-child { position: sticky; left: 0; z-index: 1; }
        .uav-embedded .waypoint-table th:first-child { z-index: 3; }
        .uav-embedded .table-waypoint-heading { gap: 5px !important; }
        .uav-embedded .table-waypoint-name { color: #8fc1ff !important; font-weight: 700 !important; font-size: 12.5px !important; }
        .uav-embedded .table-coordinates { font-size: 10px !important; margin-top: 1px !important; }
        .uav-embedded .table-drop-marker { padding: 2px 5px !important; font-size: 9px !important; }
        .uav-embedded .table-altitude-input { width: 62px !important; height: 30px !important; font-size: 12.5px !important; padding: 0 6px !important; }
        .uav-embedded .phase-label { padding: 2px 5px !important; font-size: 9.5px !important; }
        .uav-embedded .estimate-mark { min-width: 0 !important; padding: 2px 6px !important; font-size: 11px !important; }
        .uav-embedded .numeric-cell { font-variant-numeric: tabular-nums; }
        .uav-embedded .consumption-variance { font-size: 11px; gap: 4px !important; }
        .uav-embedded .consumption-percent { padding: 1px 4px !important; font-size: 10px !important; }
        /* colonnes « réel » : saisie du pilote mise en avant */
        .uav-embedded .waypoint-table td.leg-consumption-cell,
        .uav-embedded .waypoint-table td.cumulative-consumption-cell,
        .uav-embedded .waypoint-table td.pass-cell { background-image: linear-gradient(rgba(79, 156, 249, 0.07), rgba(79, 156, 249, 0.07)) !important; }
        .uav-embedded .waypoint-table thead tr:not(.uav-thead-group) th:nth-child(n+10):nth-child(-n+12) { color: #9cc7ff !important; background: #17284a !important; }
        .uav-embedded .cumulative-consumption-cell { min-width: 0 !important; text-align: left !important; }
        .uav-embedded .real-battery-readings { grid-auto-flow: column; justify-content: start !important; gap: 6px !important; }
        .uav-embedded .real-battery-reading { gap: 4px !important; font-size: 10.5px !important; }
        .uav-embedded .real-battery-reading > span { width: auto !important; font-weight: 700; color: #8d9bb5; }
        .uav-embedded .table-real-input { width: 92px !important; height: 32px !important; padding: 0 8px !important; font-size: 14px !important; font-weight: 700 !important;
          border-radius: 8px !important; background: #0b1426 !important; border: 1px solid #2f4a78 !important; color: #e8eef9 !important; font-variant-numeric: tabular-nums; }
        .uav-embedded .table-real-input.real-voltage-input { width: 74px !important; }
        .uav-embedded .table-real-input:focus { border-color: #4f9cf9 !important; box-shadow: 0 0 0 3px rgba(79, 156, 249, 0.3) !important; outline: none !important; background: #0e1b33 !important; }
        .uav-embedded .cumulative-consumption-cell > .consumption-variance { display: inline-flex !important; margin-top: 3px !important; }
        .uav-embedded .cumulative-consumption-cell > .voltage-variance { display: inline-flex !important; margin: 3px 0 0 10px !important; }
        .uav-embedded .leg-consumption-cell > .consumption-variance { margin-top: 2px !important; }
        .uav-embedded .pass-cell .pass-button { display: block; padding: 3px 8px !important; border-radius: 7px !important; font-size: 10.5px !important; }
        .uav-embedded .pass-cell .pass-time, .uav-embedded .pass-cell .pass-delta { display: inline-block !important; margin: 2px 6px 0 0; font-size: 10.5px !important; }
        .uav-embedded .table-remove-button { width: 24px !important; height: 24px !important; }
        /* rangée de groupes de colonnes ajoutée par la passerelle */
        .uav-embedded .waypoint-table .uav-thead-group th { top: 0 !important; height: 26px; padding: 0 8px !important; vertical-align: middle !important; font-size: 10px !important; letter-spacing: 0.1em !important;
          color: #6f84a8 !important; background: #111b2e !important; border-bottom: 1px solid #22324f !important; text-align: left; }
        .uav-embedded .waypoint-table .uav-thead-group th + th { box-shadow: inset 1px 0 0 #22324f; }
        .uav-embedded .waypoint-table .uav-thead-group th.uav-g-est { color: #9aa9c4 !important; }
        .uav-embedded .waypoint-table .uav-thead-group th.uav-g-real { color: #cfe3ff !important; background: linear-gradient(90deg, #1d3a6b, #17284a) !important; box-shadow: inset 0 2px 0 #4f9cf9, inset 1px 0 0 #22324f; }
        .uav-embedded .waypoint-table .uav-thead-group th.uav-g-real kbd { margin-left: 8px; padding: 1px 5px; border-radius: 4px; border: 1px solid #3a5f99; font: 600 9.5px Inter, sans-serif; letter-spacing: 0; color: #9cc7ff; text-transform: none; }
        /* =================================================================
           Tableau des points « suivi de vol » : rail de route, ligne du prochain point,
           boussole de vent, micro-barres, estimation en filigrane dans les champs réels
           ================================================================= */
        .uav-entry-progress { display: inline-flex; align-items: center; gap: 12px; margin-left: 14px; font-size: 11.5px; color: #8d9bb5; }
        .uav-entry-progress[hidden] { display: none; }
        .uav-seg { display: flex; gap: 2px; width: clamp(120px, 14vw, 240px); }
        .uav-seg span { flex: 1; height: 7px; border-radius: 2px; background: #1b2942; transition: background .3s; }
        .uav-seg span.done { background: linear-gradient(180deg, #5ef0a6, #2bb673); }
        .uav-seg span.next { background: #4f9cf9; box-shadow: 0 0 8px rgba(79, 156, 249, 0.9); animation: uavBlink 1.6s ease-in-out infinite; }
        .uav-seg span.drop:not(.done) { background: #5a4520; }
        .uav-entry-progress > b { color: #e8eef9; font-variant-numeric: tabular-nums; }
        .uav-next-chip { display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px 3px 8px; border-radius: 99px; background: linear-gradient(90deg, #17305c, #12213d);
          box-shadow: inset 0 0 0 1px #2f5fa3; color: #cfe3ff; font-weight: 600; white-space: nowrap; }
        .uav-next-chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #4f9cf9; animation: uavBlink 1.6s ease-in-out infinite; }
        .uav-next-chip em { font-style: normal; color: #9cc7ff; font-variant-numeric: tabular-nums; }
        .uav-next-chip em.late { color: #f5b544; }
        .uav-next-chip.done { background: linear-gradient(90deg, #12402b, #0f2a20); box-shadow: inset 0 0 0 1px #2bb673; color: #b8f5d4; }
        .uav-next-chip.done::before { background: #3dd68c; animation: none; }
        @keyframes uavBlink { 50% { opacity: 0.45; } }
        @keyframes uavPulse { 0% { box-shadow: 0 0 0 0 rgba(79, 156, 249, 0.75), inset 0 0 0 2px #cfe3ff; } 100% { box-shadow: 0 0 0 9px rgba(79, 156, 249, 0), inset 0 0 0 2px #cfe3ff; } }

        @media screen {
          /* rail de route dans la première colonne */
          .uav-embedded .waypoint-table tbody td:first-child { padding-left: 34px !important; }
          .uav-embedded .waypoint-table tbody td:first-child::before { content: ''; position: absolute; left: 15px; top: 0; bottom: 0; width: 2px; background: #22324f; }
          .uav-embedded .waypoint-table tbody tr:first-child td:first-child::before { top: 50%; }
          .uav-embedded .waypoint-table tbody tr:last-child td:first-child::before { bottom: 50%; }
          .uav-embedded .waypoint-table tbody tr.uav-done td:first-child::before { background: linear-gradient(180deg, #3dd68c, #3dd68c 50%, #22324f 50%); }
          .uav-embedded .waypoint-table tbody tr.uav-done:has(+ tr.uav-done) td:first-child::before { background: #3dd68c; }
          .uav-embedded .waypoint-table tbody td:first-child::after { content: ''; position: absolute; left: 10px; top: 50%; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%;
            display: grid; place-items: center; background: #0b1426; box-shadow: inset 0 0 0 2px #3a5078; font: 900 8px/12px Inter, sans-serif; color: #04210f; text-align: center; }
          .uav-embedded .waypoint-table tbody tr.uav-done td:first-child::after { content: '✓'; background: #3dd68c; box-shadow: 0 0 0 3px rgba(61, 214, 140, 0.18); }
          .uav-embedded .waypoint-table tbody tr.uav-next td:first-child::after { background: #4f9cf9; animation: uavPulse 1.6s ease-out infinite; }
          .uav-embedded .waypoint-table tbody tr.drop-point td:first-child::after { border-radius: 3px; transform: rotate(45deg); box-shadow: inset 0 0 0 2px #f5b544; }
          .uav-embedded .waypoint-table tbody tr.drop-point.uav-done td:first-child::after { content: ''; background: #f5b544; }
          .uav-embedded .waypoint-table tbody tr.drop-point.uav-next td:first-child::after { background: #f5b544; }

          /* états des lignes */
          .uav-embedded .waypoint-table tbody tr.uav-done td { color: #a9b8d3; }
          .uav-embedded .waypoint-table tbody tr.uav-done .table-waypoint-name { color: #8fe0b6 !important; }
          .uav-embedded .waypoint-table tbody tr.uav-next td { background: linear-gradient(180deg, #13284d, #10213f) !important; box-shadow: inset 0 1px 0 #2f5fa3, inset 0 -1px 0 #2f5fa3; }
          .uav-embedded .waypoint-table tbody tr.uav-next td:first-child { box-shadow: inset 3px 0 0 #4f9cf9, inset 0 1px 0 #2f5fa3, inset 0 -1px 0 #2f5fa3; }
          .uav-embedded .waypoint-table tbody tr.uav-next .table-waypoint-name { color: #fff !important; }
          .uav-embedded .waypoint-table tbody tr.uav-next .table-waypoint-name::after { content: 'PROCHAIN'; margin-left: 7px; padding: 1px 5px; border-radius: 4px; background: #2b7be0;
            color: #fff; font-size: 8.5px; font-weight: 800; letter-spacing: 0.08em; vertical-align: 2px; }
          .uav-embedded .waypoint-table tbody tr:focus-within td { background: #182c4d !important; }
          .uav-embedded .waypoint-table tbody tr.drop-point td { background-image: linear-gradient(90deg, rgba(245, 181, 68, 0.06), rgba(245, 181, 68, 0)) !important; }

          /* vent : boussole + vitesse colorée */
          .uav-wind { display: inline-grid; grid-template-columns: 22px auto; grid-template-rows: auto auto; column-gap: 6px; align-items: center; }
          .uav-wind i { grid-row: span 2; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: #0d1a31; box-shadow: inset 0 0 0 1px #2a4677;
            color: #7fb6ff; font: 800 12px/1 Inter, sans-serif; font-style: normal; }
          .uav-wind i span { display: block; transform: rotate(var(--dir)); }
          .uav-wind b { color: #e8eef9; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
          .uav-wind b small { margin-left: 2px; color: #7f91b2; font-size: 9.5px; font-weight: 600; }
          .uav-wind em { color: #6f84a8; font-size: 10px; font-style: normal; font-variant-numeric: tabular-nums; line-height: 1.1; }
          .uav-wind.warn i { color: #f5b544; box-shadow: inset 0 0 0 1px #8a6420; } .uav-wind.warn b { color: #f5b544; }
          .uav-wind.danger i { color: #f26d6d; box-shadow: inset 0 0 0 1px #8a3434; } .uav-wind.danger b { color: #f26d6d; }
          .uav-wind-none { color: #5f7397; font-size: 11px; font-style: italic; }

          /* ETA : grande, compte à rebours sur le prochain point */
          .uav-embedded .waypoint-table td.uav-eta { font-size: 13.5px; font-weight: 700; color: #e8eef9; font-variant-numeric: tabular-nums; }
          .uav-eta-rel { display: block; margin-top: 1px; color: #7fb6ff; font-size: 10px; font-weight: 600; }
          .uav-eta-rel.late { color: #f5b544; }

          /* phases en pastilles de couleur */
          .uav-embedded .phase-labels { gap: 3px !important; flex-wrap: wrap; }
          .uav-embedded .phase-label { border-radius: 5px !important; font-weight: 700 !important; letter-spacing: 0.02em; border: 0 !important; }
          .uav-embedded .phase-label--takeoff { background: #16294b !important; color: #8fc1ff !important; }
          .uav-embedded .phase-label--climbing { background: #23204a !important; color: #b6a8ff !important; }
          .uav-embedded .phase-label--cruise { background: #172338 !important; color: #a9b8d3 !important; }
          .uav-embedded .phase-label--dropping { background: #3d2d10 !important; color: #f5b544 !important; }
          .uav-embedded .phase-label--descending { background: #10303a !important; color: #6fd8e8 !important; }
          .uav-embedded .phase-label--landing { background: #12352a !important; color: #5ef0a6 !important; }

          /* micro-barres sous les mAh estimés (tronçon : par rapport au pic ; cumul : par rapport à la batterie) */
          .uav-mbar { display: block; height: 3px; margin-top: 4px; border-radius: 2px; background: #1a2741; overflow: hidden; }
          .uav-mbar b { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, #2b7be0, #7fb6ff); transition: width .35s ease; }
          .uav-mbar.cap b { background: linear-gradient(90deg, #2b7be0, #7fb6ff 70%, #f5b544); }
          .uav-embedded .waypoint-table td.numeric-cell { font-weight: 600; }

          /* saisie réelle */
          .uav-embedded .table-real-input::placeholder { color: #3f5a86; font-weight: 600; font-style: italic; font-size: 13px; }
          .uav-embedded .table-real-input { -moz-appearance: textfield; appearance: textfield; text-align: center; }
          .uav-embedded .table-real-input::-webkit-inner-spin-button, .uav-embedded .table-real-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
          .uav-embedded tr.uav-next .table-real-input { border-color: #4f9cf9 !important; background: #0e1c36 !important; }
          .uav-embedded tr.uav-next .table-real-input::placeholder { color: #5b7fb8; }
          .uav-embedded .table-real-input:not(:placeholder-shown) { border-color: #2bb673 !important; color: #b8f5d4 !important; }
          .uav-embedded .consumption-variance { padding: 1px 6px 1px 5px; border-radius: 6px; background: #172338; }
          .uav-embedded .consumption-variance.positive { background: rgba(61, 214, 140, 0.12) !important; color: #5ef0a6 !important; }
          .uav-embedded .consumption-variance.negative { background: rgba(242, 109, 109, 0.13) !important; color: #ff9c9c !important; }
          .uav-embedded .consumption-variance strong { color: inherit !important; }
          .uav-embedded .consumption-variance .consumption-percent { background: transparent !important; color: inherit !important; opacity: 0.8; }
          .uav-embedded .real-leg-value { font-weight: 700; color: #e8eef9; }

          /* heure de passage */
          .uav-embedded .pass-cell .pass-button { display: inline-flex !important; align-items: center; gap: 5px; padding: 5px 11px !important; border-radius: 99px !important;
            border: 1px solid #2f5fa3 !important; background: #10213f !important; color: #9cc7ff !important; font-weight: 700 !important; }
          .uav-embedded .pass-cell .pass-button::before { content: '◎'; font-size: 11px; }
          .uav-embedded tr.uav-next .pass-cell .pass-button { background: linear-gradient(180deg, #3b8cf2, #2b7be0) !important; border-color: #4f9cf9 !important; color: #fff !important;
            box-shadow: 0 6px 16px -6px rgba(43, 123, 224, 0.9); }
          .uav-embedded .pass-cell .pass-button.recorded { border-color: #2bb673 !important; background: rgba(61, 214, 140, 0.12) !important; color: #5ef0a6 !important; }
          .uav-embedded .pass-cell .pass-button.recorded::before { content: '✓'; }
          .uav-embedded .pass-cell .pass-button.recorded:hover { border-color: #f26d6d !important; color: #ff9c9c !important; background: rgba(242, 109, 109, 0.1) !important; }
          .uav-embedded .pass-cell .pass-time { color: #e8eef9 !important; font-weight: 700; font-variant-numeric: tabular-nums; }
          .uav-embedded .pass-cell .pass-delta { padding: 0 6px; border-radius: 5px; font-weight: 700; }
          .uav-embedded .pass-cell .pass-delta.pending { display: none !important; }
          .uav-embedded .pass-cell .pass-delta.on-time { background: rgba(61, 214, 140, 0.12); color: #5ef0a6 !important; }
          .uav-embedded .pass-cell .pass-delta.late { background: rgba(245, 181, 68, 0.13); color: #f5b544 !important; }
          .uav-embedded .pass-cell .pass-delta.early { background: rgba(79, 156, 249, 0.13); color: #8fc1ff !important; }
          .uav-embedded tr:not(.uav-has-pass) .pass-cell .pass-time { display: none !important; }
          /* estimations ajoutées automatiquement (point passé sans saisie pendant 15 s) */
          .uav-embedded tr.uav-auto-v input[data-action="actual-voltage"],
          .uav-embedded tr.uav-auto-mah input[data-action="actual-cumulative"] { border: 1px dashed #f5b544 !important; color: #f5d08a !important; font-style: italic; }
          .uav-embedded tr.uav-auto-pass .pass-cell .pass-time { color: #f5d08a !important; font-style: italic; }
          .uav-embedded tr.uav-auto-pass .pass-cell .pass-time::after { content: 'AUTO'; margin-left: 5px; padding: 0 4px; border-radius: 4px; background: #3d2d10;
            color: #f5b544; font: 800 8.5px Inter, sans-serif; font-style: normal; letter-spacing: 0.06em; vertical-align: 1px; }
          .uav-embedded .waypoint-table tbody tr.uav-done.uav-auto-pass:not(.drop-point) td:first-child::after { content: '≈'; background: #f5b544; color: #2a1d05;
            box-shadow: 0 0 0 3px rgba(245, 181, 68, 0.18); }
          .uav-embedded .pass-cell .pass-button.uav-takeoff:not(.recorded) { background: linear-gradient(180deg, #3dd68c, #23a866) !important; border-color: #5ef0a6 !important;
            color: #04210f !important; box-shadow: 0 6px 18px -6px rgba(61, 214, 140, 0.9); letter-spacing: 0.02em; }
          .uav-embedded .pass-cell .pass-button.uav-takeoff:not(.recorded)::before { content: '▲'; font-size: 9px; }
          .uav-embedded .pass-cell .pass-button.uav-takeoff:not(.recorded):hover { filter: brightness(1.1); }

          /* suppression : discrète, visible au survol de la ligne (évite les clics accidentels pendant la saisie) */
          .uav-embedded .table-remove-button { opacity: 0; transition: opacity .15s; }
          .uav-embedded tr:hover .table-remove-button, .uav-embedded .table-remove-button:focus-visible { opacity: 1; }
          .uav-embedded .table-remove-button:hover { color: #f26d6d !important; border-color: #f26d6d !important; }
        }

        /* ---- Dispositions demandées par la page ---- */
        .uav-peek-tab, .uav-peek-close { display: none; }
        @media (min-width: 1101px) {
          /* Préparer : carte en grand, tableau réduit */
          .uav-layout-map .workspace-area { grid-template-rows: minmax(0, 1fr) 190px !important; }
          /* Saisie : panneau gauche rangé (onglet « Réglages »), tableau sur presque toute la hauteur et toute la largeur */
          .uav-layout-entry .app-shell { grid-template-columns: minmax(0, 1fr) !important; }
          .uav-layout-entry .workspace-area { grid-column: 1 / -1 !important; }
          .uav-layout-entry .sidebar { position: fixed !important; top: 0; bottom: 0; left: 0; width: 320px; z-index: 1200 !important;
            transform: translateX(-102%); transition: transform .22s ease; box-shadow: 18px 0 50px -10px rgba(0, 0, 0, 0.7) !important; }
          .uav-layout-entry.uav-peek .sidebar { transform: none; }
          .uav-layout-entry .workspace-area { grid-template-rows: minmax(170px, 30vh) minmax(0, 1fr) !important; padding-left: 30px !important; }
          .uav-layout-entry .panel-resize--horizontal { display: none !important; }
          .uav-layout-entry .map-legend, .uav-layout-entry .map-hint { display: none !important; }
          .uav-layout-entry .uav-peek-tab { display: flex; position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 1100; width: 24px; padding: 14px 0;
            align-items: center; justify-content: center; writing-mode: vertical-rl; rotate: 180deg; gap: 6px; border: 1px solid #2f4a78; border-left: 0;
            border-radius: 0 10px 10px 0; background: #13213b; color: #9cc7ff; font: 700 11px Inter, sans-serif; letter-spacing: 0.08em; cursor: pointer; }
          .uav-layout-entry .uav-peek-tab:hover { background: #1b3159; color: #fff; }
          .uav-layout-entry.uav-peek .uav-peek-close { display: grid; place-items: center; position: fixed; top: 10px; left: 284px; z-index: 1300; width: 28px; height: 28px;
            border-radius: 8px; border: 1px solid #2f4a78; background: #13213b; color: #cfe3ff; cursor: pointer; }
        }
      }
    `;
  }
  try { applyUavTheme(); } catch (err) { console.warn('Thème UAV non appliqué à WindPath :', err); }

  // -------------------------------------------------------------------
  // Mise en page : panneau gauche essentiel, tableau des points, dispositions
  // -------------------------------------------------------------------
  const root = document.documentElement;
  const LAYOUTS = ['map', 'balanced', 'entry'];
  // ancien choix « essentiel / tous les détails » : remplacé par le tableau de bord ci-dessous
  try { localStorage.removeItem('uav.windpath.lean'); } catch { /* sans stockage */ }

  // -------------------------------------------------------------------
  // Panneau gauche « tableau de bord » : widgets alimentés par l'état de WindPath
  //  · carte d'identité de la mission · bande de vent par point · jauge batterie
  //  · alertes utiles (sans la note de modélisation) · frise décollage → largage → arrivée
  // Mêmes seuils que la météo du tableau de bord : vent > 8 m/s vigilance, > 12 m/s défavorable,
  // rafales > 15 m/s ; marge batterie < 10 % vigilance, < 0 % défavorable.
  // -------------------------------------------------------------------
  const WIND_OK = 8, WIND_MAX = 12, GUST_MAX = 15;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 0) => (finite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const make = (tag, cls, where, how = 'after') => {
    const el = document.createElement(tag);
    el.className = cls;
    if (where) where[how](el);
    return el;
  };
  const setHtml = (el, html) => { if (el && el.__html !== html) { el.__html = html; el.innerHTML = html; } };
  const wpLabel = (wp, i) => (typeof waypointNumber === 'function' ? waypointNumber(wp, i) : i);

  // libellés courts des réglages (le libellé complet de WindPath reste en info-bulle)
  const SHORT = { batteryCapacity: 'Capacity', departureVoltage: 'Departure', defaultCruiseSpeed: 'Cruise speed', payloadWeight: 'Payload' };
  for (const [id, label] of Object.entries(SHORT)) {
    const span = document.querySelector(`label[for="${id}"] > span:first-child`);
    if (span) { span.title = span.textContent.trim().replace(/\s+/g, ' '); span.firstChild.textContent = label; }
  }
  const SUMMARY = { summaryDistance: 'Distance', summaryWind: 'Avg wind', summaryTakeoffPressure: 'Pressure · takeoff',
    summaryLandingPressure: 'Pressure · landing', summaryPressureDifference: 'Δ pressure', summaryPressureAltitudeChange: 'Δ altitude (pressure)' };
  for (const [id, label] of Object.entries(SUMMARY)) {
    const span = document.getElementById(id) && document.getElementById(id).previousElementSibling;
    if (span) { span.title = span.textContent.trim(); span.textContent = label; }
  }
  const dropTile = document.querySelector('.energy-summary > div:has(#payloadEnergyFactor) > span');
  if (dropTile) { dropTile.title = dropTile.textContent; dropTile.textContent = 'Payload factor'; }
  const finalTile = document.querySelector('.energy-summary > div:has(#estimatedFinalVoltage) > span');
  if (finalTile) { finalTile.title = finalTile.textContent; finalTile.textContent = 'Final voltage'; }
  const realTile = document.querySelector('.energy-summary > div:has(#actualTotalMah) > span');
  if (realTile) { realTile.title = realTile.textContent; realTile.textContent = 'Real used'; }

  const missionId = make('div', 'uav-mission-id', elements.uploadZone);
  const windStrip = make('div', 'uav-windstrip', document.querySelector('.wind-check-timer'));
  const gauge = make('div', 'uav-gauge', document.querySelector('.energy-summary'), 'before');
  const alerts = make('div', 'uav-alerts', document.querySelector('.energy-summary'));
  const timeline = make('div', 'uav-timeline', document.querySelector('.summary-heading'));
  const timer = document.querySelector('.wind-check-timer');

  const C = 2 * Math.PI * 38;
  gauge.innerHTML = `<div class="g-ring"><svg viewBox="0 0 92 92" aria-hidden="true">
      <defs><linearGradient id="uavGaugeUsed" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fb6ff"/><stop offset="1" stop-color="#2b7be0"/></linearGradient></defs>
      <circle class="g-track" cx="46" cy="46" r="38"/><circle class="g-res" cx="46" cy="46" r="38"/><circle class="g-used" cx="46" cy="46" r="38"/></svg>
      <div class="g-center"><b>—</b><small>UTILISÉ</small></div></div>
    <dl><div><dt><i></i>Estimé</dt><dd data-k="est">—</dd></div>
      <div><dt title="Réserve de route : ${Math.round(RESERVE * 100)} % de l'estimation"><i class="res"></i>Réserve</dt><dd data-k="res">—</dd></div>
      <div><dt><i class="free"></i>Marge</dt><dd data-k="free">—</dd></div></dl>`;
  gauge.setAttribute('role', 'meter');
  gauge.setAttribute('aria-label', 'Batterie : consommation estimée, réserve et marge');

  // ---- panneau de droite : dégradés, aires sous les courbes, repère de largage, pic, indicateurs ----
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.setAttribute('aria-hidden', 'true');
  defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  defs.innerHTML = '<defs>'
    + '<linearGradient id="uavBarEst" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fb6ff"/><stop offset="1" stop-color="#1f5cb0"/></linearGradient>'
    + '<linearGradient id="uavBarReal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ef0a6"/><stop offset="1" stop-color="#1c8a56"/></linearGradient>'
    + '<linearGradient id="uavAreaBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f9cf9" stop-opacity=".35"/><stop offset="1" stop-color="#4f9cf9" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="uavAreaAmber" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5b544" stop-opacity=".28"/><stop offset="1" stop-color="#f5b544" stop-opacity="0"/></linearGradient>'
    + '</defs>';
  document.body.prepend(defs);

  // mêmes repères que WindPath dans ses graphiques (marges du tracé et bas de l'axe)
  const PLOT_LEFT = 42, PLOT_RIGHT_GAP = 18, PLOT_BOTTOM = 142;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const el = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
  function enhanceChart(svg) {
    if (!svg || svg.classList.contains('empty') || svg.querySelector('.uav-x')) return;
    const width = Number((svg.getAttribute('viewBox') || '').split(' ')[2]);
    if (!width) return;
    const wps = state.waypoints || [];
    svg.append(svgEl('g', { class: 'uav-x' }));
    // aire sous la courbe estimée
    const line = svg.querySelector('.chart-cumulative-estimate, .chart-voltage-estimate-line');
    if (line) {
      const pts = (line.getAttribute('points') || '').trim().split(/\s+/).map((p) => p.split(',').map(Number));
      if (pts.length > 1) {
        const area = [...pts.map((p) => p.join(',')), `${pts[pts.length - 1][0]},${PLOT_BOTTOM}`, `${pts[0][0]},${PLOT_BOTTOM}`].join(' ');
        line.before(svgEl('polygon', { class: line.classList.contains('chart-voltage-estimate-line') ? 'uav-area-amber' : 'uav-area-blue', points: area }));
      }
    }
    // pic de consommation par tronçon
    const bars = Array.from(svg.querySelectorAll('.chart-bar-estimate'));
    if (bars.length) bars.reduce((a, b) => (Number(b.getAttribute('height')) > Number(a.getAttribute('height')) ? b : a)).classList.add('uav-peak');
    // repère vertical du point de largage (le graphique des tronçons ne compte que les points estimés)
    const series = svg.id === 'consumptionChart' ? wps.filter((w) => finite(w.estimatedUsedMah)) : wps;
    if (typeof hasDropPoint !== 'function' || !series.length) return;
    const step = (width - PLOT_RIGHT_GAP - PLOT_LEFT) / series.length;
    series.forEach((wp, i) => {
      if (!hasDropPoint(wp)) return;
      const x = PLOT_LEFT + step * (i + 0.5);
      svg.querySelector('.uav-x').append(svgEl('line', { class: 'uav-drop-line', x1: x, x2: x, y1: 30, y2: PLOT_BOTTOM }));
      const tag = svgEl('text', { class: 'uav-drop-tag', x: x + 4, y: 38, 'text-anchor': 'start' });
      tag.textContent = 'LARGAGE';
      svg.querySelector('.uav-x').append(tag);
    });
  }
  const chartIds = ['consumptionChart', 'cumulativeChart', 'voltageChart'];
  const chartObserver = new MutationObserver((records) => {
    const seen = new Set(records.map((r) => r.target.closest && r.target.closest('svg')));
    seen.forEach((svg) => { try { enhanceChart(svg); } catch (err) { console.warn('Graphique WindPath :', err); } });
  });
  chartIds.forEach((id) => {
    const svg = document.getElementById(id);
    if (svg) { chartObserver.observe(svg, { childList: true }); enhanceChart(svg); }
  });

  const BUDGET = { batteryBudgetReserve: `Reserve ${Math.round(RESERVE * 100)}%`, batteryBudgetUsedPercent: 'Used', batteryBudgetRemainingPercent: 'Free' };
  for (const [id, label] of Object.entries(BUDGET)) {
    const span = document.getElementById(id) && document.getElementById(id).previousElementSibling;
    if (span) { span.title = span.textContent.trim(); span.textContent = label; }
  }
  const budget = document.querySelector('.battery-budget');
  const kpis = budget ? make('div', 'uav-kpis', budget) : null;
  const chartStat = (id) => { const svg = document.getElementById(id); return svg && svg.closest('.energy-chart-card').querySelector('.energy-chart-heading > span'); };
  const statEls = { consumptionChart: chartStat('consumptionChart'), cumulativeChart: chartStat('cumulativeChart'), voltageChart: chartStat('voltageChart') };
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };

  function renderCharts(s) {
    const wps = state.waypoints || [];
    const best = (key, cmp) => wps.reduce((acc, w, i) => (finite(w[key]) && (!acc || cmp(w[key], acc.v)) ? { v: w[key], i } : acc), null);
    const peakLeg = best('estimatedUsedMah', (a, b) => a > b);
    const peakA = best('estimatedCurrentA', (a, b) => a > b);
    const minV = best('estimatedVoltage', (a, b) => a < b);
    const currents = wps.map((w) => w.estimatedCurrentA).filter((v) => finite(v) && v > 0);
    const at = (x) => (x ? `<em>pt ${esc(wpLabel(wps[x.i], x.i))}</em>` : '');
    if (kpis) {
      kpis.hidden = !peakA && !minV;
      setHtml(kpis, `<div><small>Courant max</small><b>${peakA ? num(peakA.v, 1) : '—'}<small>A</small></b>${at(peakA)}</div>`
        + `<div><small>Courant moyen</small><b>${currents.length ? num(currents.reduce((a, b) => a + b, 0) / currents.length, 1) : '—'}<small>A</small></b><em>${currents.length} tronçons</em></div>`
        + `<div><small>Tension min</small><b>${minV ? num(minV.v, 1) : '—'}<small>V</small></b>${at(minV)}</div>`);
    }
    const realCum = lastFinite(wps, 'actualCumulativeMah');
    setText(statEls.consumptionChart, peakLeg ? `pic ${num(peakLeg.v)} mAh · pt ${wpLabel(wps[peakLeg.i], peakLeg.i)}` : '—');
    setText(statEls.cumulativeChart, finite(s.estimatedMah) ? `${num(s.estimatedMah)} mAh${finite(realCum) ? ` · réel ${num(realCum)}` : ''}` : '—');
    const v0 = wps.length && finite(wps[0].estimatedVoltage) ? wps[0].estimatedVoltage : null;
    setText(statEls.voltageChart, v0 != null && finite(s.finalVoltage) ? `${num(v0, 1)} → ${num(s.finalVoltage, 1)} V` : '—');
  }

  function renderDashboard(s) {
    renderCharts(s);
    const wps = state.waypoints || [];

    // mission
    missionId.hidden = !wps.length;
    setHtml(missionId, `<span class="uav-plane" aria-hidden="true">✈</span><b title="${esc(s.missionName || '')}">${esc(s.missionName || 'Mission tracée sur la carte')}</b>`
      + `<span>${wps.length} pts${s.distanceKm != null ? ` · ${num(s.distanceKm, 1)} km` : ''}${s.durationMin != null ? ` · ${Math.round(s.durationMin)} min` : ''}`
      + `${s.modified ? ' · <em>modifiée</em>' : ''}</span>`);

    // chrono du vent : vert < 30 min, orange au-delà de 60 min (comme le verdict de la page)
    if (timer) {
      timer.classList.toggle('uav-fresh', s.windChecked && s.windCheckAgeMin < 30);
      timer.classList.toggle('uav-stale', s.windChecked && s.windCheckAgeMin >= 60);
    }

    // bande de vent par point
    const winds = wps.map((w) => (w.wind && finite(w.wind.speed) ? w.wind : null));
    windStrip.hidden = !winds.some(Boolean);
    if (!windStrip.hidden) {
      const top = Math.max(WIND_MAX * 1.15, ...winds.filter(Boolean).map((w) => w.speed)) || 1;
      const pct = (v) => `${Math.min(100, (v / top) * 100).toFixed(1)}%`;
      const lvl = (v, g) => (v > WIND_MAX || (finite(g) && g > GUST_MAX) ? 'danger' : v > WIND_OK ? 'warn' : '');
      const bars = wps.map((wp, i) => {
        const w = winds[i];
        if (!w) return '<span class="uav-ws-bar" style="height:2px;opacity:.3"></span>';
        const drop = typeof hasDropPoint === 'function' && hasDropPoint(wp) ? ' drop' : '';
        const dir = finite(w.direction) ? `<i style="--dir:${Math.round(w.direction + 180)}deg">↑</i>` : '';
        const tip = `Pt ${wpLabel(wp, i)} · ${w.speed.toFixed(1)} m/s${finite(w.direction) ? ` · de ${Math.round(w.direction)}°` : ''}${finite(wp.gust) ? ` · rafales ${wp.gust.toFixed(1)} m/s` : ''}`;
        return `<span class="uav-ws-bar ${lvl(w.speed, wp.gust)}${drop}" style="height:${pct(w.speed)}" title="${esc(tip)}">${wps.length <= 14 ? dir : ''}</span>`;
      }).join('');
      const axis = wps.map((wp, i) => `<span>${wps.length <= 16 || i % Math.ceil(wps.length / 12) === 0 ? esc(wpLabel(wp, i)) : ''}</span>`).join('');
      const avg = elements.summaryWind ? elements.summaryWind.textContent.replace(' m/s', '') : '—';
      const stat = (label, v, unit, cls = '', extra = '') => `<div class="${cls}"><small>${label}</small><b>${v}${v !== '—' ? `<small>${unit}${extra}</small>` : ''}</b></div>`;
      setHtml(windStrip, `<div class="uav-ws-bars" style="--warn:${pct(WIND_OK)};--danger:${pct(WIND_MAX)}">${bars}</div><div class="uav-ws-axis">${axis}</div>`
        + '<div class="uav-ws-stats">'
        + stat('Moyen', /^\d/.test(avg) ? avg : '—', 'm/s')
        + stat('Max', s.maxWindMs != null ? num(s.maxWindMs, 1) : '—', 'm/s', lvl(s.maxWindMs || 0), s.maxWindWp && wps[s.maxWindWp - 1] ? ` · pt ${wpLabel(wps[s.maxWindWp - 1], s.maxWindWp - 1)}` : '')
        + stat('Rafales', s.maxGustMs != null ? num(s.maxGustMs, 1) : '—', 'm/s', (s.maxGustMs || 0) > GUST_MAX ? 'danger' : '')
        + '</div>');
    }

    // jauge batterie
    const cap = s.capacityMah, est = s.estimatedMah;
    const used = cap && finite(est) ? est / cap : null;
    const res = used == null ? 0 : Math.min(Math.max(0, 1 - used), used * RESERVE);
    const [usedArc, resArc] = [Math.min(1, used || 0) * C, res * C];
    gauge.querySelector('.g-used').style.strokeDasharray = `${usedArc} ${C}`;
    gauge.querySelector('.g-res').style.strokeDasharray = `${resArc} ${C}`;
    gauge.querySelector('.g-res').style.strokeDashoffset = `${-usedArc}`;
    gauge.classList.toggle('over', used != null && used > 1);
    gauge.querySelector('.g-center b').textContent = used == null ? '—' : `${Math.round(used * 100)} %`;
    gauge.querySelector('[data-k="est"]').textContent = finite(est) ? `${num(est)} mAh` : '—';
    gauge.querySelector('[data-k="res"]').textContent = finite(est) ? `${num(est * RESERVE)} mAh` : '—';
    const free = gauge.querySelector('[data-k="free"]');
    free.textContent = s.marginPct == null ? '—' : `${num(s.marginPct, 1)} %`;
    free.className = s.marginPct == null ? '' : s.marginPct < 0 ? 'danger' : s.marginPct < 10 ? 'warn' : 'ok';
    gauge.setAttribute('aria-valuetext', used == null ? 'Estimation indisponible' : `${Math.round(used * 100)} % utilisé, marge ${num(s.marginPct, 1)} %`);

    // alertes WindPath, sans la note de modélisation de la charge (toujours présente)
    const warn = elements.energyWarning;
    const lines = warn && !warn.hidden ? (warn.textContent.match(/[^.]+(?:\.(?=\s|$)|$)/g) || []).map((t) => t.trim()).filter((t) => t && !/^Payload is modeled/.test(t)) : [];
    alerts.hidden = !lines.length;
    setHtml(alerts, lines.map((t) => `<p class="${/exceeds|Over capacity/i.test(t) ? 'danger' : ''}">⚠ <span>${esc(t)}</span></p>`).join(''));

    // frise horaire
    const stops = [];
    const t0 = wps[0] && finite(wps[0].etaTimestamp) ? wps[0].etaTimestamp : new Date(elements.takeoffTime.value).getTime();
    if (wps.length && finite(t0)) stops.push({ cls: '', t: t0, label: 'Décollage' });
    wps.forEach((wp, i) => {
      if (typeof hasDropPoint === 'function' && hasDropPoint(wp)) stops.push({ cls: 'drop', t: wp.etaTimestamp, label: `Largage · pt ${wpLabel(wp, i)}` });
    });
    const last = wps[wps.length - 1];
    if (wps.length > 1) stops.push({ cls: 'land', t: last && last.etaTimestamp, label: 'Arrivée' });
    timeline.hidden = stops.length < 2;
    const firstDrop = stops.find((x) => x.cls === 'drop');
    const span = finite(t0) && last && finite(last.etaTimestamp) ? last.etaTimestamp - t0 : null;
    const dropAt = firstDrop && span && finite(firstDrop.t) ? Math.round(((firstDrop.t - t0) / span) * 100) : 50;
    setHtml(timeline, `${s.durationMin != null ? `<span class="uav-tl-dur">${Math.round(s.durationMin)} min de vol</span>` : ''}`
      + `<div class="uav-tl-track" style="--drop:${dropAt}%">${stops.map((x) => `<div class="uav-tl-stop ${x.cls}"><i></i><b>${finite(x.t) ? hhmm(x.t) : '--:--'}</b><small title="${esc(x.label)}">${esc(x.label)}</small></div>`).join('')}</div>`);
  }

  // onglet « Réglages » : en mode saisie, le panneau gauche est rangé et s'ouvre par-dessus le tableau
  const peekTab = document.createElement('button');
  peekTab.type = 'button';
  peekTab.className = 'uav-peek-tab';
  peekTab.textContent = '⚙ Réglages du vol';
  const peekClose = document.createElement('button');
  peekClose.type = 'button';
  peekClose.className = 'uav-peek-close';
  peekClose.setAttribute('aria-label', 'Ranger les réglages');
  peekClose.textContent = '✕';
  document.body.append(peekTab, peekClose);
  const setPeek = (open) => root.classList.toggle('uav-peek', open);
  peekTab.addEventListener('click', () => setPeek(true));
  peekClose.addEventListener('click', () => setPeek(false));
  document.addEventListener('pointerdown', (e) => {
    if (root.classList.contains('uav-peek') && !e.target.closest('.sidebar, .uav-peek-tab, .uav-peek-close, dialog')) setPeek(false);
  }, true);

  function setLayout(mode, fromKeyboard) {
    if (!LAYOUTS.includes(mode)) return;
    layout = mode;
    LAYOUTS.forEach((m) => root.classList.toggle(`uav-layout-${m}`, m === mode));
    setPeek(false);
    // écran étroit : WindPath empile carte / graphiques / tableau et fait défiler la page
    if (mode === 'entry' && window.matchMedia('(max-width: 1100px)').matches) {
      setTimeout(() => elements.waypointTablePanel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
    setTimeout(() => { try { map.invalidateSize({ pan: false }); drawEnergyCharts(); } catch { /* carte en cours */ } }, 260);
    if (fromKeyboard) post({ type: 'layout', mode });
  }
  setLayout('balanced');

  // Alt+1 / Alt+2 / Alt+3 : Préparer / Mixte / Saisie (aussi depuis la page, voir Planning.tsx)
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const mode = { Digit1: 'map', Digit2: 'balanced', Digit3: 'entry' }[e.code];
    if (mode) { e.preventDefault(); setLayout(mode, true); }
  });

  // première intégration : tableau plus haut que le réglage d'origine de WindPath (30 % de la hauteur)
  try {
    const saved = JSON.parse(localStorage.getItem('windpath-panel-layout-v1') || '{}');
    if (!saved.tableHeight && typeof applyPanelSize === 'function') {
      applyPanelSize('table', Math.round(window.innerHeight * 0.42));
      if (typeof savePanelLayout === 'function') savePanelLayout('table');
    }
  } catch { /* réglage d'origine conservé */ }

  // groupes de colonnes : route et vent · estimation WindPath · réel (saisie du pilote)
  const thead = elements.waypointTable.querySelector('thead');
  const headCount = thead ? thead.querySelectorAll('tr:last-child th').length : 0;
  if (thead && headCount === 13 && !thead.querySelector('.uav-thead-group')) {
    const group = document.createElement('tr');
    group.className = 'uav-thead-group';
    group.innerHTML = '<th colspan="5">Route et vent</th><th colspan="4" class="uav-g-est">Estimation WindPath</th>'
      + '<th colspan="3" class="uav-g-real">Réel · saisie pilote <kbd>Entrée ↵ point suivant</kbd><kbd>mAh saisi ⇒ passé auto</kbd></th><th></th>';
    thead.prepend(group);
  }

  // -------------------------------------------------------------------
  // Tableau des points « suivi de vol »
  //  · état de chaque ligne : fait (relevé réel ou heure de passage), prochain point, à venir ;
  //  · rail de route, boussole de vent, micro-barres, estimation en filigrane dans les champs réels ;
  //  · en-tête : avancement segmenté par point + prochain point avec compte à rebours vers son ETA.
  // WindPath redessine tout le tableau (innerHTML) : la décoration est réappliquée à chaque fois.
  // -------------------------------------------------------------------
  const progress = document.createElement('span');
  progress.className = 'uav-entry-progress';
  const heading = document.getElementById('waypointTableTitle');
  if (heading && heading.parentElement) heading.parentElement.append(progress);

  const isDone = (w) => finite(w.actualCumulativeMah) || finite(w.actualVoltage) || finite(w.actualPassedAt);
  /** prochain point : celui qui suit le dernier point fait (les points sautés restent saisissables) */
  function nextIndex(wps) {
    let last = -1;
    wps.forEach((w, i) => { if (isDone(w)) last = i; });
    return last + 1 < wps.length ? last + 1 : -1;
  }
  const relTime = (ts) => {
    const min = Math.round((ts - Date.now()) / 60000);
    if (Math.abs(min) < 1) return { text: 'maintenant', late: false };
    return min > 0 ? { text: `dans ${min >= 60 ? `${Math.floor(min / 60)} h ${pad(min % 60)}` : `${min} min`}`, late: false }
      : { text: `il y a ${-min >= 60 ? `${Math.floor(-min / 60)} h ${pad(-min % 60)}` : `${-min} min`}`, late: true };
  };

  function updateProgress() {
    const wps = state.waypoints || [];
    progress.hidden = !wps.length;
    if (!wps.length) return;
    const next = nextIndex(wps);
    const done = wps.filter(isDone).length;
    const seg = wps.map((w, i) => `<span class="${isDone(w) ? 'done' : i === next ? 'next' : ''}${typeof hasDropPoint === 'function' && hasDropPoint(w) ? ' drop' : ''}"></span>`).join('');
    let chip = '<span class="uav-next-chip done">Mission complète</span>';
    if (next >= 0) {
      const w = wps[next];
      const rel = finite(w.etaTimestamp) ? relTime(w.etaTimestamp) : null;
      chip = `<span class="uav-next-chip">Prochain : pt ${esc(wpLabel(w, next))}${finite(w.etaTimestamp) ? ` · ETA ${hhmm(w.etaTimestamp)}` : ''}`
        + `${rel ? ` <em class="${rel.late ? 'late' : ''}">${rel.text}</em>` : ''}</span>`;
    }
    // écart au plan au dernier point marqué passé (même calcul que l'étiquette entre les deux drones)
    const d = typeof planDelay === 'function' ? planDelay() : null;
    const delay = d ? `<span class="uav-delay-chip ${delayLevel(d)}" title="Heure de passage enregistrée au point ${esc(wpLabel(wps[d.index], d.index))} comparée à son ETA">${delayText(d)}</span>` : '';
    setHtml(progress, `<span class="uav-seg" aria-hidden="true">${seg}</span><b>${done} / ${wps.length}</b>${chip}${delay}`);
  }

  function decorateTable() {
    const wps = state.waypoints || [];
    const rows = Array.from(elements.waypointList.rows || []);
    if (!rows.length) return;
    const byId = new Map(wps.map((w, i) => [String(w.id), [w, i]]));
    const next = nextIndex(wps);
    const maxLeg = Math.max(1, ...wps.map((w) => (finite(w.estimatedUsedMah) ? w.estimatedUsedMah : 0)));
    const cap = Number(elements.batteryCapacity.value) || null;
    for (const row of rows) {
      const hit = byId.get(row.dataset.id);
      if (!hit) continue;
      const [w, i] = hit;
      row.classList.toggle('uav-done', isDone(w));
      row.classList.toggle('uav-next', i === next);
      row.classList.toggle('uav-has-pass', finite(w.actualPassedAt));
      row.classList.toggle('uav-auto-pass', isAutoPass(w));
      row.classList.toggle('uav-auto-mah', isAutoMah(w));
      row.classList.toggle('uav-auto-v', isAutoV(w));
      // point 0 : bouton « Décollage » (voir takeOff)
      if (i === 0) {
        const btn = row.querySelector('[data-action="toggle-pass"]');
        if (btn) {
          const done = btn.classList.contains('recorded');
          btn.classList.add('uav-takeoff');
          setText(btn, done ? 'Décollé' : 'Décollage');
          const tip = done ? 'Annuler le décollage enregistré' : 'Décoller maintenant : heure de décollage du plan et passage du point 0 à l\'heure actuelle';
          if (btn.title !== tip) { btn.title = tip; btn.setAttribute('aria-label', tip); }
        }
      }
      const cells = row.cells;
      if (cells.length < 13) continue;

      // vent : boussole (flèche vers où souffle le vent) + vitesse colorée selon les seuils
      const windCell = cells[2];
      const windKey = w.wind && finite(w.wind.speed) ? `${w.wind.speed}|${w.wind.direction}|${w.gust}` : 'none';
      if (windCell.dataset.uav !== windKey) {
        windCell.dataset.uav = windKey;
        if (windKey === 'none') windCell.innerHTML = '<span class="uav-wind-none">non vérifié</span>';
        else {
          const lvl = w.wind.speed > WIND_MAX || (finite(w.gust) && w.gust > GUST_MAX) ? 'danger' : w.wind.speed > WIND_OK ? 'warn' : '';
          const dir = finite(w.wind.direction) ? Math.round(w.wind.direction) : null;
          windCell.innerHTML = `<span class="uav-wind ${lvl}" title="Vent de ${dir ?? '—'}° · ${w.wind.speed.toFixed(1)} m/s${finite(w.gust) ? ` · rafales ${w.gust.toFixed(1)} m/s` : ''}">`
            + `<i><span style="--dir:${dir == null ? 0 : dir + 180}deg">↑</span></i><b>${w.wind.speed.toFixed(1)}<small>m/s</small></b>`
            + `<em>${dir == null ? '' : `${dir}°`}${finite(w.gust) ? ` · raf. ${w.gust.toFixed(0)}` : ''}</em></span>`;
        }
      }

      // ETA + compte à rebours sur le prochain point
      const etaCell = cells[3];
      etaCell.classList.add('uav-eta');
      let rel = etaCell.querySelector('.uav-eta-rel');
      if (i === next && finite(w.etaTimestamp)) {
        if (!rel) { rel = document.createElement('span'); rel.className = 'uav-eta-rel'; etaCell.append(rel); }
        const r = relTime(w.etaTimestamp);
        setText(rel, r.text);
        rel.classList.toggle('late', r.late);
      } else if (rel) rel.remove();

      // micro-barres : tronçon (par rapport au plus gros tronçon) et cumul (par rapport à la capacité)
      const bar = (cell, ratio, cls) => {
        let el = cell.querySelector('.uav-mbar');
        if (ratio == null) { if (el) el.remove(); return; }
        if (!el) { el = document.createElement('i'); el.className = `uav-mbar ${cls}`; el.innerHTML = '<b></b>'; cell.append(el); }
        el.firstChild.style.width = `${Math.max(2, Math.min(100, ratio * 100)).toFixed(1)}%`;
      };
      bar(cells[7], finite(w.estimatedUsedMah) ? w.estimatedUsedMah / maxLeg : null, '');
      bar(cells[8], finite(w.cumulativeEstimatedMah) && cap ? w.cumulativeEstimatedMah / cap : null, 'cap');

      // valeur estimée en filigrane dans les champs réels : le pilote sait quoi lire sur la télémétrie
      const mahIn = row.querySelector('input[data-action="actual-cumulative"]');
      const vIn = row.querySelector('input[data-action="actual-voltage"]');
      const mahPh = finite(w.cumulativeEstimatedMah) ? `≈${Math.round(w.cumulativeEstimatedMah)}` : '';
      const vPh = finite(w.estimatedVoltage) ? `≈${w.estimatedVoltage.toFixed(1)}` : '';
      if (mahIn && mahIn.placeholder !== mahPh) mahIn.placeholder = mahPh;
      if (vIn && vIn.placeholder !== vPh) vIn.placeholder = vPh;
    }
  }
  new MutationObserver(() => { try { decorateTable(); updateProgress(); } catch (err) { console.warn('Tableau WindPath :', err); } })
    .observe(elements.waypointList, { childList: true });
  // saisie validée (WindPath met à jour les cellules) : état des lignes et avancement tout de suite
  elements.waypointList.addEventListener('change', () => setTimeout(() => { try { decorateTable(); updateProgress(); } catch { /* rendu en cours */ } }, 0));

  // -------------------------------------------------------------------
  // Estimations automatiques : point passé (horaire recalé) sans saisie ni clic pendant 15 s
  // → heure de passage = heure recalée, mAh cumulé = estimation recalée sur les vrais relevés.
  // Marquées `uavAuto` (envoyées comme « estimé » dans le vol, en orange dans le tableau) ;
  // une saisie du pilote les remplace. Les valeurs auto se recalent à chaque vrai relevé pour
  // que la règle de WindPath (cumul croissant d'un point à l'autre) n'empêche jamais une saisie.
  // -------------------------------------------------------------------
  const AUTO_GRACE_MS = 15000;
  const isAutoMah = (w) => Boolean(w.uavAuto && w.uavAuto.mah != null && w.uavAuto.mah === w.actualCumulativeMah);
  const isAutoPass = (w) => Boolean(w.uavAuto && w.uavAuto.pass != null && w.uavAuto.pass === w.actualPassedAt);
  const isAutoV = (w) => Boolean(w.uavAuto && w.uavAuto.v != null && w.uavAuto.v === w.actualVoltage);
  /**
   * Tension estimée au point j, recalée sur le dernier vrai relevé de tension avant lui
   * (même écart réel − estimé), bornée à la plage acceptée par WindPath (30-51 V).
   */
  function autoVoltage(wps, j) {
    const est = wps[j].estimatedVoltage;
    if (!finite(est)) return null;
    let offset = 0;
    for (let i = j - 1; i >= 0; i -= 1) {
      const w = wps[i];
      if (finite(w.actualVoltage) && !isAutoV(w) && finite(w.estimatedVoltage)) { offset = w.actualVoltage - w.estimatedVoltage; break; }
    }
    return Math.round(Math.min(51, Math.max(30, est + offset)) * 100) / 100;
  }
  /** relevés du pilote (hors valeurs auto), avec éventuellement la saisie en cours */
  const anchorsOf = (wps, override) => wps.map((w, i) => (override && override.i === i ? { i, v: override.v }
    : finite(w.actualCumulativeMah) && !isAutoMah(w) ? { i, v: w.actualCumulativeMah } : null)).filter(Boolean);
  /** mAh estimé au point j, recalé entre les relevés réels qui l'encadrent (forme de la courbe estimée) */
  function autoValue(wps, j, anchors) {
    const est = (i) => (finite(wps[i].cumulativeEstimatedMah) ? wps[i].cumulativeEstimatedMah : null);
    if (est(j) == null) return null;
    const before = anchors.filter((a) => a.i < j).pop();
    const after = anchors.find((a) => a.i > j);
    let v;
    if (before && after && est(before.i) != null && est(after.i) != null && est(after.i) > est(before.i)) {
      v = before.v + ((after.v - before.v) * (est(j) - est(before.i))) / (est(after.i) - est(before.i));
    } else if (before && est(before.i) != null) v = before.v + (est(j) - est(before.i));
    else v = est(j);
    if (before) v = Math.max(v, before.v);
    if (after) v = Math.min(v, after.v);
    return Math.round(v / 10) * 10;
  }
  /** recale toutes les valeurs auto sur les relevés réels (+ la saisie en cours) */
  function rebaseAuto(override) {
    const wps = state.waypoints || [];
    const anchors = anchorsOf(wps, override);
    wps.forEach((w, j) => {
      if (!isAutoMah(w) || (override && override.i === j)) return;
      const v = autoValue(wps, j, anchors);
      if (v != null) { w.actualCumulativeMah = v; w.uavAuto.mah = v; }
    });
  }
  // saisie d'un mAh réel : avant la validation de WindPath (phase de capture), les valeurs auto sont recalées
  elements.waypointList.addEventListener('change', (e) => {
    const input = e.target;
    // tension saisie par le pilote sur un point auto : ce n'est plus une estimation
    if (input instanceof HTMLInputElement && input.dataset.action === 'actual-voltage') {
      const row = input.closest('tr');
      const w = (state.waypoints || []).find((x) => String(x.id) === (row && row.dataset.id));
      if (w && w.uavAuto) w.uavAuto.v = null;
      return;
    }
    if (!(input instanceof HTMLInputElement) || input.dataset.action !== 'actual-cumulative' || input.value === '') return;
    const v = Number(input.value);
    const row = input.closest('tr');
    const wps = state.waypoints || [];
    const i = wps.findIndex((w) => String(w.id) === (row && row.dataset.id));
    if (i < 0 || !Number.isFinite(v)) return;
    if (wps[i].uavAuto) wps[i].uavAuto.mah = null; // le pilote a saisi lui-même ce point
    rebaseAuto({ i, v });
  }, true);

  // frappe dans le tableau : le remplissage auto attend que le pilote ait fini
  let lastTableTyping = 0;
  elements.waypointList.addEventListener('input', () => { lastTableTyping = Date.now(); });
  /** champ du tableau qui a le focus, s'il contient une saisie pas encore validée */
  function pendingEntry(a) {
    if (!a || !elements.waypointList.contains(a) || a.tagName !== 'INPUT') return false;
    const row = a.closest('tr.mission-row');
    const w = row && (state.waypoints || []).find((x) => String(x.id) === row.dataset.id);
    if (!w) return false;
    const key = { 'actual-cumulative': 'actualCumulativeMah', 'actual-voltage': 'actualVoltage', altitude: 'altitude' }[a.dataset.action];
    if (!key) return false;
    const stored = finite(w[key]) ? Number(w[key]) : null;
    return a.value === '' ? stored != null : Number(a.value) !== stored;
  }

  function autoFill() {
    const wps = state.waypoints || [];
    if (wps.length < 2 || !finite(wps[0].actualPassedAt)) return; // seulement en vol (après le décollage)
    // pilote en train de saisir (frappe récente ou valeur pas encore validée) : on attend qu'il ait fini
    const a = document.activeElement;
    if (Date.now() - lastTableTyping < 10000 || pendingEntry(a)) return;
    const now = Date.now();
    const filled = [];
    for (let i = 1; i < wps.length; i += 1) {
      const w = wps[i];
      if (finite(w.actualPassedAt) || finite(w.actualCumulativeMah) || finite(w.actualVoltage)) continue;
      if (!finite(w.etaTimestamp)) break;
      const d = planDelay();
      const t = Math.round(w.etaTimestamp + (d ? d.ms : 0));
      if (now < t + AUTO_GRACE_MS) break; // les points suivants ne sont pas encore passés
      const v = autoValue(wps, i, anchorsOf(wps));
      const volt = autoVoltage(wps, i);
      w.actualPassedAt = t;
      if (v != null) w.actualCumulativeMah = v;
      if (volt != null) w.actualVoltage = volt;
      w.uavAuto = { pass: t, mah: v, v: volt };
      filled.push(i);
    }
    if (!filled.length) return;
    // le tableau est redessiné : le curseur revient dans le même champ
    const row = a && elements.waypointList.contains(a) ? a.closest('tr.mission-row') : null;
    const focus = row && a.dataset.action ? { id: row.dataset.id, action: a.dataset.action } : null;
    renderWaypoints();
    const again = focus && Array.from(elements.waypointList.rows).find((r) => r.dataset.id === focus.id);
    const el = again && again.querySelector(`[data-action="${focus.action}"]`);
    if (el) el.focus();
  }
  // une valeur auto modifiée par WindPath ou le pilote n'est plus une estimation
  function pruneAuto() {
    (state.waypoints || []).forEach((w) => {
      if (!w.uavAuto) return;
      if (w.uavAuto.pass != null && w.uavAuto.pass !== w.actualPassedAt) w.uavAuto.pass = null;
      if (w.uavAuto.mah != null && w.uavAuto.mah !== w.actualCumulativeMah) w.uavAuto.mah = null;
      if (w.uavAuto.v != null && w.uavAuto.v !== w.actualVoltage) w.uavAuto.v = null;
      if (w.uavAuto.pass == null && w.uavAuto.mah == null && w.uavAuto.v == null) delete w.uavAuto;
    });
  }

  // -------------------------------------------------------------------
  // Décollage (point 0) : un seul instant pour les deux drones.
  // L'heure de décollage de WindPath (drone estimé, ETA) passe à maintenant, à la seconde,
  // et le point 0 est marqué passé (drone recalé). Les ETA sont recalculées avec les prévisions
  // déjà chargées (pas de nouvel appel météo).
  // -------------------------------------------------------------------
  function takeOff() {
    const wps = state.waypoints || [];
    if (!wps.length) return;
    const now = new Date();
    now.setMilliseconds(0);
    const p = (n) => String(n).padStart(2, '0');
    elements.takeoffTime.step = '1';
    elements.takeoffTime.value = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    wps[0].actualPassedAt = now.getTime();
    // WindPath : résumé + recalcul des ETA (si le vent a été vérifié), puis rendu
    elements.takeoffTime.dispatchEvent(new Event('change', { bubbles: true }));
    if (!state.forecasts) renderWaypoints();
    if (typeof resetMissionAlerts === 'function') try { resetMissionAlerts(); } catch { /* alertes */ }
  }
  // bouton du point 0 : « Décollage » au lieu de « Mark passed » (l'annulation reste celle de WindPath)
  elements.waypointList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="toggle-pass"]');
    const row = btn && btn.closest('tr.mission-row');
    if (!row || row !== elements.waypointList.rows[0] || btn.classList.contains('recorded')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    takeOff();
    const first = elements.waypointList.rows[0];
    const mah = first && first.querySelector('[data-action="actual-cumulative"]');
    if (mah) mah.focus();
  }, true);

  // mAh cumulé réel saisi (et accepté par WindPath) → point marqué « passé » à l'heure de la saisie.
  // Ce gestionnaire passe après celui de WindPath (ajouté avant la passerelle) : la valeur est déjà validée.
  // Le tableau est redessiné ; le champ où le pilote est allé (Tab → V, Entrée → point suivant) garde le focus.
  elements.waypointList.addEventListener('change', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.action !== 'actual-cumulative' || input.value === '') return;
    const row = input.closest('tr');
    const wp = row && (state.waypoints || []).find((w) => String(w.id) === row.dataset.id);
    if (!wp || finite(wp.actualPassedAt) || wp.actualCumulativeMah !== Number(input.value)) return;
    // point 0 : la saisie vaut décollage (heure de décollage = maintenant, pour les deux drones)
    if (wp === state.waypoints[0]) {
      setTimeout(() => {
        const active = document.activeElement;
        const activeRow = active && active.closest && active.closest('tr.mission-row');
        const focus = activeRow ? { id: activeRow.dataset.id, action: active.dataset.action } : null;
        takeOff();
        const again = focus && Array.from(elements.waypointList.rows).find((r) => r.dataset.id === focus.id);
        const el = again && focus.action && again.querySelector(`[data-action="${focus.action}"]`);
        if (el) { el.focus(); try { el.select(); } catch { /* champ non sélectionnable */ } }
      }, 0);
      return;
    }
    wp.actualPassedAt = Date.now();
    setTimeout(() => {
      const active = document.activeElement;
      const activeRow = active && active.closest && active.closest('tr.mission-row');
      const focus = activeRow && elements.waypointList.contains(active) ? { id: activeRow.dataset.id, action: active.dataset.action } : null;
      renderWaypoints();
      if (!focus || !focus.action) return;
      const again = Array.from(elements.waypointList.rows).find((r) => r.dataset.id === focus.id);
      const el = again && again.querySelector(`[data-action="${focus.action}"]`);
      if (el) { el.focus(); if (typeof el.select === 'function') try { el.select(); } catch { /* champ non sélectionnable */ } }
    }, 0);
  });
  elements.waypointList.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="toggle-pass"]')) setTimeout(() => { try { decorateTable(); updateProgress(); } catch { /* rendu en cours */ } }, 0);
  });

  // Entrée (ou ↓ / ↑) dans un champ réel : même champ du point suivant (ou précédent), prêt à être saisi.
  // WindPath redessine le tableau à chaque changement : le champ est retrouvé par sa ligne et son action.
  elements.waypointTable.addEventListener('keydown', (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains('table-real-input')) return;
    // Ctrl+Entrée : valide la saisie et marque le point comme passé (heure actuelle)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const id = input.closest('tr') && input.closest('tr').dataset.id;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        const row = Array.from(elements.waypointList.rows).find((r) => r.dataset.id === id);
        const btn = row && row.querySelector('[data-action="toggle-pass"]:not(.recorded)');
        if (btn) btn.click();
      }, 30);
      return;
    }
    const down = e.key === 'Enter' && !e.shiftKey || e.key === 'ArrowDown';
    const up = e.key === 'Enter' && e.shiftKey || e.key === 'ArrowUp';
    if (!down && !up) return;
    e.preventDefault();
    const rows = Array.from(elements.waypointTable.querySelectorAll('tr.mission-row'));
    const index = rows.indexOf(input.closest('tr')) + (down ? 1 : -1);
    const action = input.dataset.action;
    // la sortie du champ déclenche la validation de WindPath (événement change natif)
    setTimeout(() => {
      const row = elements.waypointTable.querySelectorAll('tr.mission-row')[index];
      const next = row && row.querySelector(`input[data-action="${action}"]`);
      if (next) { next.focus(); next.select(); next.scrollIntoView({ block: 'nearest' }); }
    }, 30);
  }, true);

  // -------------------------------------------------------------------
  // Carte
  //  · fonds au choix (Sombre / Satellite / Relief / Plan d'origine), miniatures de la zone affichée ;
  //  · route : volé en vert, à venir coloré selon le vent, flux animé, étiquettes « distance · durée » ;
  //  · marqueurs aux mêmes états que le tableau (fait / prochain / à venir), drone port, cible de largage ;
  //  · drones : position recalée (principale) et estimée (fantôme), reliées par l'écart au plan.
  // Les fonctions de WindPath (markerIcon, renderMap, updateReferenceDronePosition) sont appelées par leur
  // nom global : la passerelle les remplace ou les complète sans modifier script.js.
  // -------------------------------------------------------------------
  const BASEMAP_KEY = 'uav.windpath.basemap';
  const BASEMAPS = [
    { key: 'dark', label: 'Sombre', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', max: 16,
      labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      attr: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors' },
    { key: 'sat', label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 18,
      attr: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
    { key: 'topo', label: 'Relief', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub: 'abc', max: 17,
      attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
    { key: 'plan', label: 'Plan', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc', max: 19 },
  ];
  let originalTiles = null;
  map.eachLayer((l) => { if (!originalTiles && l instanceof L.TileLayer) originalTiles = l; });
  let baseLayer = null;
  const baseBox = document.createElement('div');
  baseBox.className = 'uav-basemaps';
  baseBox.setAttribute('role', 'group');
  baseBox.setAttribute('aria-label', 'Fond de carte');
  baseBox.innerHTML = BASEMAPS.map((b) => `<button type="button" class="${b.key}" data-key="${b.key}" title="Fond ${b.label}"><i></i><span>${b.label}</span></button>`).join('');
  const stage = document.querySelector('.map-stage');
  if (stage) stage.append(baseBox);
  function setBasemap(key) {
    const b = BASEMAPS.find((x) => x.key === key) || BASEMAPS[0];
    if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
    if (b.key === 'plan') { if (originalTiles && !map.hasLayer(originalTiles)) originalTiles.addTo(map); }
    else {
      if (originalTiles && map.hasLayer(originalTiles)) map.removeLayer(originalTiles);
      // au-delà du zoom natif du fond, les tuiles sont agrandies (la carte garde son zoom 19)
      const tiles = L.tileLayer(b.url, { subdomains: b.sub || 'abc', maxZoom: 19, maxNativeZoom: b.max, attribution: b.attr, crossOrigin: true });
      baseLayer = b.labels
        ? L.layerGroup([tiles, L.tileLayer(b.labels, { maxZoom: 19, maxNativeZoom: b.max, opacity: 0.7, crossOrigin: true })])
        : tiles;
      baseLayer.addTo(map);
      tiles.bringToBack();
    }
    BASEMAPS.forEach((x) => root.classList.toggle(`uav-basemap-${x.key}`, x.key === b.key));
    baseBox.querySelectorAll('button').forEach((btn) => { btn.classList.toggle('active', btn.dataset.key === b.key); btn.setAttribute('aria-pressed', String(btn.dataset.key === b.key)); });
    try { localStorage.setItem(BASEMAP_KEY, b.key); } catch { /* sans stockage */ }
  }
  baseBox.addEventListener('click', (e) => { const btn = e.target.closest('button'); if (btn) setBasemap(btn.dataset.key); });
  // miniatures : la tuile qui couvre le centre de la carte (zoom 9), pour chaque fond
  function updateThumbs() {
    const c = map.getCenter(), z = 9, n = 2 ** z;
    const x = Math.floor(((c.lng + 180) / 360) * n);
    const rad = (c.lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    BASEMAPS.forEach((b) => {
      const url = b.url.replace('{s}', (b.sub || 'a')[0]).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
      const i = baseBox.querySelector(`[data-key="${b.key}"] i`);
      if (i && i.dataset.url !== url) { i.dataset.url = url; i.style.backgroundImage = `url("${url}")`; }
    });
  }
  let savedBase = 'dark';
  try { savedBase = localStorage.getItem(BASEMAP_KEY) || 'dark'; } catch { /* fond sombre */ }
  setBasemap(savedBase);
  updateThumbs();

  const routeRenderer = L.svg({ padding: 0.5 });
  const routeGroup = L.layerGroup().addTo(map);
  const flownLine = L.polyline([], { renderer: routeRenderer, color: '#3dd68c', weight: 5, opacity: 0.95, lineCap: 'round', interactive: false });
  const flownGlow = L.polyline([], { renderer: routeRenderer, color: '#3dd68c', weight: 13, opacity: 0.18, lineCap: 'round', interactive: false });
  const gapLine = L.polyline([], { renderer: routeRenderer, color: '#cfe3ff', weight: 2, opacity: 0.75, className: 'uav-gap', interactive: false });
  const windLevel = (w) => (!w || !w.wind || !finite(w.wind.speed) ? 'none'
    : w.wind.speed > WIND_MAX || (finite(w.gust) && w.gust > GUST_MAX) ? 'danger' : w.wind.speed > WIND_OK ? 'warn' : 'ok');
  const LEVEL_COLOR = { none: '#4f9cf9', ok: '#4f9cf9', warn: '#f5b544', danger: '#f26d6d' };
  const near = (a, b) => a && b && Math.abs(a.lat - b.lat) < 2e-4 && Math.abs(a.lon - b.lon) < 2e-4;
  const fmtKm = (m) => (m >= 10000 ? `${num(m / 1000, 0)} km` : m >= 1000 ? `${num(m / 1000, 1)} km` : `${Math.round(m)} m`);
  const fmtDur = (ms) => {
    const s = Math.round(Math.abs(ms) / 1000), m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)}` : m ? `${m} min${s % 60 ? ` ${pad(s % 60)} s` : ''}` : `${s} s`;
  };

  /** dernier point marqué passé (par heure) et écart au plan à ce point (ms, > 0 = retard) */
  function planDelay() {
    let last = null;
    (state.waypoints || []).forEach((w, i) => { if (finite(w.actualPassedAt) && (!last || w.actualPassedAt > last.w.actualPassedAt)) last = { w, i }; });
    if (!last || !finite(last.w.etaTimestamp)) return null;
    return { ms: last.w.actualPassedAt - last.w.etaTimestamp, index: last.i };
  }
  const delayText = (d) => (Math.abs(d.ms) < 30000 ? 'À l\'heure du plan' : `${d.ms > 0 ? '+' : '−'}${fmtDur(d.ms)} ${d.ms > 0 ? 'de retard' : 'd\'avance'}`);
  const delayLevel = (d) => (Math.abs(d.ms) < 120000 ? 'ok' : Math.abs(d.ms) < 300000 ? 'warn' : 'danger');

  function drawRoute() {
    routeGroup.clearLayers();
    const wps = state.waypoints || [];
    if (state.routeLine) state.routeLine.setStyle({ opacity: 0 });
    if (wps.length < 2) return;
    const all = wps.map((w) => [w.lat, w.lon]);
    L.polyline(all, { renderer: routeRenderer, color: '#4f9cf9', weight: 12, opacity: 0.1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeGroup);
    const far = map.getZoom() < 10;
    for (let i = 1; i < wps.length; i += 1) {
      const a = wps[i - 1], b = wps[i];
      const seg = [[a.lat, a.lon], [b.lat, b.lon]];
      const color = LEVEL_COLOR[windLevel(b)];
      L.polyline(seg, { renderer: routeRenderer, color, weight: 4, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(routeGroup);
      L.polyline(seg, { renderer: routeRenderer, color: '#ffffff', weight: 2, opacity: 0.55, lineCap: 'round', className: 'uav-flow', interactive: false }).addTo(routeGroup);
      // étiquette du tronçon si assez longue à l'écran
      const pa = map.latLngToContainerPoint(seg[0]), pb = map.latLngToContainerPoint(seg[1]);
      const px = pa.distanceTo(pb);
      if (far || px < 150) continue;
      const leg = distanceAndBearing(a, b);
      const dur = finite(a.etaTimestamp) && finite(b.etaTimestamp) ? b.etaTimestamp - a.etaTimestamp : null;
      const flown = isDone(b);
      // décalée à droite du sens de vol : sur un aller-retour, les deux étiquettes ne se recouvrent pas
      const rad = (leg.bearing * Math.PI) / 180;
      const off = `margin-left:${Math.round(Math.cos(rad) * 18)}px;margin-top:${Math.round(Math.sin(rad) * 18)}px`;
      L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], { interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'uav-leg-icon', iconSize: [0, 0],
          html: `<span class="uav-leg${flown ? ' flown' : ''}" style="${off}"><i style="--b:${Math.round(leg.bearing)}deg">↑</i>${fmtKm(leg.distance)}${dur ? ` · ${fmtDur(dur)}` : ''}</span>` }) }).addTo(routeGroup);
    }
    flownGlow.addTo(routeGroup);
    flownLine.addTo(routeGroup);
    gapLine.addTo(routeGroup);
    syncDrones();
  }

  /** point le plus proche de p sur le segment a-b (coordonnées planes locales, suffisant à cette échelle) */
  function projectOnLeg(p, a, b) {
    const k = Math.cos((p.lat * Math.PI) / 180);
    const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lng * k, py = p.lat;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return { t, d: (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2 };
  }

  /**
   * Position du plan à l'instant t (interpolée entre les ETA), sans revenir avant le point `from`.
   * Les ETA gèrent les tronçons sans distance (décollage / atterrissage verticaux), contrairement au
   * calcul « distance / vitesse sol » de WindPath qui s'y arrête.
   */
  function planPositionAt(t, from) {
    const wps = state.waypoints || [];
    if (!wps[from]) return null;
    let pos = { lat: wps[from].lat, lon: wps[from].lon, bearing: null, alt: wps[from].altitude, leg: wps[from + 1] || null };
    for (let i = from + 1; i < wps.length; i += 1) {
      const a = wps[i - 1], b = wps[i];
      if (!finite(a.etaTimestamp) || !finite(b.etaTimestamp)) break;
      const moving = a.lat !== b.lat || a.lon !== b.lon;
      const bearing = moving ? distanceAndBearing(a, b).bearing : pos.bearing;
      if (t >= b.etaTimestamp) { pos = { lat: b.lat, lon: b.lon, bearing, alt: b.altitude, leg: wps[i + 1] || b }; continue; }
      const span = b.etaTimestamp - a.etaTimestamp;
      const k = span > 0 ? Math.max(0, Math.min(1, (t - a.etaTimestamp) / span)) : 1;
      const alt = finite(a.altitude) && finite(b.altitude) ? a.altitude + (b.altitude - a.altitude) * k : b.altitude;
      pos = { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k, bearing, alt, leg: b };
      break;
    }
    return pos;
  }

  /** drone recalé = plan décalé de l'écart mesuré au dernier point passé */
  function placeRecalibrated() {
    const m = state.referenceDroneMarker;
    const d = planDelay();
    if (!m || !d) { ownPos = null; return; }
    const pos = planPositionAt(Date.now() - d.ms, d.index);
    if (!pos) { ownPos = null; return; }
    ownPos = { lat: pos.lat, lon: pos.lon, alt: pos.alt, bearing: pos.bearing, legIndex: pos.leg ? state.waypoints.indexOf(pos.leg) : -1 };
    m.setLatLng([pos.lat, pos.lon]);
    const el = m.getElement();
    if (!el) return;
    const plane = el.querySelector('.reference-drone-plane');
    if (plane && pos.bearing != null) plane.style.transform = `rotate(${pos.bearing}deg)`;
    const leg = pos.leg;
    const speeds = el.querySelector('.reference-drone-speeds');
    if (speeds && leg) setText(speeds, `GS ${finite(leg.groundSpeed) ? leg.groundSpeed.toFixed(1) : '—'} · AS ${finite(leg.airSpeed) ? leg.airSpeed.toFixed(1) : '—'} m/s`);
    const where = el.querySelector('.reference-drone-position');
    if (where) setText(where, `ALT ${finite(pos.alt) ? Math.round(pos.alt) : '—'} m · HDG ${pos.bearing != null ? Math.round((pos.bearing + 360) % 360) : '—'}°`);
  }

  function syncDrones() {
    const wps = state.waypoints || [];
    try { placeRecalibrated(); } catch (err) { console.warn('Drone recalé :', err); }
    const real = state.referenceDroneMarker ? state.referenceDroneMarker.getLatLng() : null;
    const ghost = state.droneMarker ? state.droneMarker.getLatLng() : null;
    root.classList.toggle('uav-has-real', Boolean(real));
    const badge = state.referenceDroneMarker && state.referenceDroneMarker.getElement() && state.referenceDroneMarker.getElement().querySelector('.reference-drone-badge');
    if (badge) setText(badge, 'POSITION RECALÉE');
    const status = state.droneMarker && state.droneMarker.getElement() && state.droneMarker.getElement().querySelector('.live-drone-status');
    if (status) {
      const t = { UPCOMING: 'PLAN · AVANT DÉCOLLAGE', 'IN FLIGHT': 'PLAN · EN VOL', ARRIVED: 'PLAN · ARRIVÉ' }[status.textContent];
      if (t) status.textContent = t;
    }

    // trace du vol recalé : jusqu'au dernier point passé, puis jusqu'au drone sur le tronçon où il se trouve
    let path = [];
    let lastPassed = -1;
    wps.forEach((w, i) => { if (finite(w.actualPassedAt)) lastPassed = i; });
    if (lastPassed >= 0) {
      if (real) {
        let best = { j: lastPassed, d: Infinity };
        for (let j = lastPassed; j < wps.length - 1; j += 1) {
          const pr = projectOnLeg(real, wps[j], wps[j + 1]);
          if (pr.d < best.d) best = { j, d: pr.d };
        }
        path = wps.slice(0, best.j + 1).map((w) => [w.lat, w.lon]).concat([[real.lat, real.lng]]);
      } else path = wps.slice(0, lastPassed + 1).map((w) => [w.lat, w.lon]);
    }
    flownLine.setLatLngs(path);
    flownGlow.setLatLngs(path);

    // écart entre la position recalée et le plan
    const d = planDelay();
    // l'écart est écrit dans la carte du drone recalé (pas d'étiquette flottante qui chevaucherait la route)
    const details = state.referenceDroneMarker && state.referenceDroneMarker.getElement() && state.referenceDroneMarker.getElement().querySelector('.reference-drone-details');
    if (real && ghost && d) {
      gapLine.setLatLngs([ghost, real]);
      const dist = map.distance(ghost, real);
      const color = delayLevel(d) === 'ok' ? '#5ef0a6' : LEVEL_COLOR[delayLevel(d)];
      if (gapLine.options.color !== color) gapLine.setStyle({ color });
      if (details) {
        let lbl = details.querySelector('.uav-gap-text');
        if (!lbl) { lbl = document.createElement('span'); details.append(lbl); }
        lbl.className = `uav-gap-text ${delayLevel(d)}`;
        setText(lbl, `${delayText(d)}${dist >= 50 ? ` · ${fmtKm(dist)} du plan` : ''}`);
      }
    } else {
      gapLine.setLatLngs([]);
      const lbl = details && details.querySelector('.uav-gap-text');
      if (lbl) lbl.remove();
    }
  }

  // marqueurs : remplace l'icône de WindPath (même signature) ; clic, sélection et fiche restent ceux de WindPath
  window.markerIcon = function uavMarkerIcon(wp, index, selected) {
    const wps = state.waypoints || [];
    const next = nextIndex(wps);
    const drop = hasDropPoint(wp);
    const home = !drop && (index === 0 || (index === wps.length - 1 && near(wp, wps[0])));
    const cls = ['uav-mk', isDone(wp) ? 'done' : index === next ? 'next' : 'todo', drop ? 'drop' : '', home ? 'home' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
    const label = home ? 'H' : esc(waypointNumber(wp, index));
    let wind = '';
    if (wp.wind && finite(wp.wind.speed)) {
      const lvl = windLevel(wp);
      wind = `<span class="uav-mk-wind ${lvl === 'ok' ? '' : lvl}"><i><span style="--dir:${Math.round(wp.wind.direction + 180)}deg">↑</span></i>${wp.wind.speed.toFixed(1)}<small>m/s</small></span>`;
    }
    const dropLabel = drop ? `<span class="uav-mk-drop">LARGAGE${finite(wp.etaTimestamp) ? ` · ${hhmm(wp.etaTimestamp)}` : ''}</span>` : '';
    const when = index === next && finite(wp.etaTimestamp) ? '<span class="uav-mk-when"></span>' : '';
    return L.divIcon({
      className: cls,
      html: `${drop ? '<span class="uav-mk-target"></span>' : ''}<span class="uav-mk-node"><b>${label}</b></span>${when}${wind}${dropLabel}`,
      iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14],
    });
  };
  const wpRenderMap = window.renderMap;
  window.renderMap = function uavRenderMap() { wpRenderMap(); try { drawRoute(); } catch (err) { console.warn('Route UAV :', err); } };
  const wpUpdateReference = window.updateReferenceDronePosition;
  window.updateReferenceDronePosition = function uavUpdateReference() { wpUpdateReference(); try { syncDrones(); } catch { /* carte en cours */ } };

  // légende alignée sur les nouveaux tracés
  const legend = document.querySelector('.map-legend');
  if (legend) legend.innerHTML = '<span class="uav-lg flown"></span>Volé <span class="uav-lg todo"></span>À venir <span class="uav-lg drop"></span>Largage'
    + ' <span class="uav-lg real"></span>Recalé <span class="uav-lg ghost"></span>Plan';

  const zoomClass = () => root.classList.toggle('uav-zoom-far', map.getZoom() < 10);
  map.on('zoomend', () => { zoomClass(); try { drawRoute(); } catch { /* route en cours */ } });
  map.on('moveend', () => { try { updateThumbs(); } catch { /* miniatures */ } });
  zoomClass();

  // états des marqueurs (fait / prochain) et compte à rebours du prochain point
  let markerKey = '';
  function mapTick() {
    const wps = state.waypoints || [];
    const next = nextIndex(wps);
    const key = `${wps.map((w) => (isDone(w) ? 1 : 0)).join('')}|${next}`;
    if (key !== markerKey) { markerKey = key; if (wps.length && typeof drawWindIndicators === 'function') { drawWindIndicators(); drawRoute(); } }
    const m = next >= 0 && state.markers && state.markers[next];
    const when = m && m.getElement() && m.getElement().querySelector('.uav-mk-when');
    if (when && finite(wps[next].etaTimestamp)) {
      const r = relTime(wps[next].etaTimestamp);
      setText(when, `${hhmm(wps[next].etaTimestamp)} · ${r.text}`);
      when.classList.toggle('late', r.late);
    }
  }
  if ((state.waypoints || []).length) window.renderMap();

  // -------------------------------------------------------------------
  // Voix de mission (synthèse vocale du navigateur : gratuite, sans clé, utilisable hors ligne
  // avec les voix locales ; voix « Natural » de Microsoft dans Edge, « Google français » dans Chrome).
  // Annonces calées sur l'horaire recalé (ETA + écart mesuré au dernier passage) et sur les saisies.
  // Sous-titres affichés sur la carte même quand la voix est coupée.
  // -------------------------------------------------------------------
  const VOICE_KEY = 'uav.windpath.voice';
  const voiceCfg = { on: true, name: '', rate: 1.05 };
  try { Object.assign(voiceCfg, JSON.parse(localStorage.getItem(VOICE_KEY) || '{}')); } catch { /* réglages par défaut */ }
  const saveVoice = () => { try { localStorage.setItem(VOICE_KEY, JSON.stringify(voiceCfg)); } catch { /* sans stockage */ } };
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  const frVoices = () => (synth ? synth.getVoices().filter((v) => /^fr\b|^fr[-_]/i.test(v.lang)) : []);
  const voiceScore = (v) => (/natural/i.test(v.name) ? 100 : 0) + (/online/i.test(v.name) ? 30 : 0) + (/google/i.test(v.name) ? 40 : 0)
    + (/fr[-_]FR/i.test(v.lang) ? 10 : 0) + (/denise|vivienne|eloise|henri|remy|amélie|thomas/i.test(v.name) ? 5 : 0);
  const pickVoice = () => { const list = frVoices(); return list.find((v) => v.name === voiceCfg.name) || list.sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null; };

  const caption = document.createElement('div');
  caption.className = 'uav-caption';
  caption.hidden = true;
  caption.setAttribute('role', 'status');
  caption.setAttribute('aria-live', 'polite');
  if (stage) stage.append(caption);
  let captionTimer = null;
  function showCaption(text, urgent) {
    caption.textContent = text;
    caption.classList.toggle('urgent', urgent);
    caption.hidden = false;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => { caption.hidden = true; }, Math.max(4500, text.length * 75));
  }

  function utter(text, voice) {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'fr-FR';
    u.rate = voiceCfg.rate;
    u.onstart = () => root.classList.add('uav-speaking');
    u.onend = () => { if (!synth.speaking) root.classList.remove('uav-speaking'); };
    return u;
  }
  function say(text, urgent = false) {
    showCaption(text, urgent);
    if (!voiceCfg.on || !synth) return;
    if (urgent && typeof playNotificationTone === 'function') try { playNotificationTone(); } catch { /* son */ }
    const voice = pickVoice();
    const u = utter(text, voice);
    // voix en ligne indisponible (réseau du drone port) : même phrase avec une voix locale
    u.onerror = (e) => {
      root.classList.remove('uav-speaking');
      if (!voice || voice.localService || e.error === 'interrupted' || e.error === 'canceled') return;
      const local = frVoices().find((v) => v.localService);
      if (local) synth.speak(utter(text, local));
    };
    setTimeout(() => synth.speak(u), urgent ? 500 : 0);
  }

  // formulation parlée
  const spokenTime = (ts) => { const d = new Date(ts); return d.getMinutes() ? `${d.getHours()} h ${pad(d.getMinutes())}` : `${d.getHours()} heures`; };
  const spokenDur = (ms) => {
    const s = Math.round(Math.abs(ms) / 1000);
    if (s < 60) return `${s} secondes`;
    const m = Math.round(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} heure${m >= 120 ? 's' : ''} ${m % 60 ? `${m % 60}` : ''}`.trim() : `${m} minute${m > 1 ? 's' : ''}`;
  };
  const spokenNum = (v, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: d });
  const ptName = (w, i) => `point ${wpLabel(w, i)}`;
  /** altitude cible parlée selon la référence du plan (départ, sol, niveau de la mer) */
  function spokenAltitude(w) {
    if (!finite(w.altitude)) return null;
    const ref = typeof waypointAltitudeReference === 'function' ? (() => { try { return waypointAltitudeReference(w); } catch { return null; } })() : null;
    if (w.altitudeMode === 'terrain' || w.frame === 10) return `${spokenNum(w.altitude)} mètres sol`;
    if (ref && ref.reference === 'msl' && !finite(w.targetAltitudeAgl)) return `${spokenNum(w.altitude)} mètres d'altitude`;
    return `${spokenNum(w.altitude)} mètres`;
  }
  /** phase du tronçon qui mène au point i : montée ou descente vers l'altitude cible */
  function phaseMessage(wps, i) {
    const w = wps[i];
    if (!w || typeof waypointPhaseLabels !== 'function') return null;
    let labels = [];
    try { labels = waypointPhaseLabels(w, i); } catch { return null; }
    const alt = spokenAltitude(w);
    if (labels.includes('Climbing')) return `Montée vers ${alt || 'l\'altitude cible'}${labels.includes('Takeoff') ? '' : `, en route vers le ${ptName(w, i)}`}.`;
    if (labels.includes('Descending')) {
      return labels.includes('Landing') || i === wps.length - 1
        ? `Descente pour l'atterrissage au ${ptName(w, i)}.`
        : `Descente vers ${alt || 'l\'altitude cible'}, en route vers le ${ptName(w, i)}.`;
    }
    return null;
  }

  // bouton et réglages, dans la barre d'outils de la carte
  const voiceBox = document.createElement('div');
  voiceBox.className = 'uav-voice';
  voiceBox.innerHTML = '<button type="button" class="uav-voice-btn" aria-haspopup="true"><span class="uav-eq" aria-hidden="true"><i></i><i></i><i></i></span><span class="lbl">Voix</span></button>'
    + '<div class="uav-voice-pop" hidden><div class="row"><b>Voix de mission</b><button type="button" class="switch" role="switch" aria-label="Activer la voix"></button></div>'
    + '<label>Voix<select></select></label><label>Débit <input type="range" min="0.8" max="1.3" step="0.05"></label>'
    + '<button type="button" class="test">▶ Tester la voix</button>'
    + '<small>Annonces : largage (5 min, 1 min, maintenant), passages, décollage, batterie, tension, atterrissage, vent à revérifier. '
    + 'Les voix « Natural » d\'Edge sont les plus naturelles ; gardez cet onglet ouvert pendant le vol.</small></div>';
  const tools = document.querySelector('.map-tools');
  if (tools) tools.prepend(voiceBox);
  const vBtn = voiceBox.querySelector('.uav-voice-btn'), vPop = voiceBox.querySelector('.uav-voice-pop');
  const vSwitch = voiceBox.querySelector('.switch'), vSelect = voiceBox.querySelector('select'), vRate = voiceBox.querySelector('input[type="range"]');
  function renderVoiceUi() {
    vBtn.classList.toggle('on', voiceCfg.on);
    vBtn.querySelector('.lbl').textContent = !synth ? 'Voix indisponible' : voiceCfg.on ? 'Voix' : 'Voix coupée';
    vSwitch.setAttribute('aria-checked', String(voiceCfg.on));
    vRate.value = String(voiceCfg.rate);
    const list = frVoices().sort((a, b) => voiceScore(b) - voiceScore(a));
    const current = pickVoice();
    const html = list.length ? list.map((v) => `<option value="${esc(v.name)}"${current && v.name === current.name ? ' selected' : ''}>${esc(v.name.replace(/^Microsoft /, '').replace(/ - French.*$/, ''))}${v.localService ? '' : ' · en ligne'}</option>`).join('')
      : '<option>Aucune voix française installée</option>';
    if (vSelect.innerHTML !== html) vSelect.innerHTML = html;
  }
  if (synth) synth.addEventListener('voiceschanged', renderVoiceUi);
  vBtn.addEventListener('click', () => { vPop.hidden = !vPop.hidden; renderVoiceUi(); });
  document.addEventListener('pointerdown', (e) => { if (!vPop.hidden && !voiceBox.contains(e.target)) vPop.hidden = true; });
  vSwitch.addEventListener('click', () => { voiceCfg.on = !voiceCfg.on; if (!voiceCfg.on && synth) synth.cancel(); saveVoice(); renderVoiceUi(); });
  vSelect.addEventListener('change', () => { voiceCfg.name = vSelect.value; saveVoice(); });
  vRate.addEventListener('input', () => { voiceCfg.rate = Number(vRate.value); saveVoice(); });
  voiceBox.querySelector('.test').addEventListener('click', () => {
    if (synth) synth.cancel();
    const wasOn = voiceCfg.on; voiceCfg.on = true;
    say('Voix de mission prête. Largage dans 5 minutes au point 3, vers 17 h 03.');
    voiceCfg.on = wasOn;
  });
  renderVoiceUi();

  // ---- moteur d'annonces ----
  const said = new Set();
  const once = (id, text, urgent) => { if (said.has(id)) return; said.add(id); say(text, urgent); };
  let voicePrev = null, voiceSnap = null, voiceSig = '';

  function announceEntries(w, i, changes) {
    const wps = state.waypoints;
    const parts = [];
    let urgent = false;
    const last = i === wps.length - 1;
    if (changes.pass) {
      if (i === 0) {
        const drop = wps.find((x) => hasDropPoint(x));
        const end = wps[wps.length - 1];
        parts.push(`Décollage enregistré à ${spokenTime(w.actualPassedAt)}.`);
        // premier tronçon (souvent le décollage vertical) : montée vers l'altitude cible
        const climb = phaseMessage(wps, 1);
        if (climb) { parts.push(climb); said.add(`phase:${wps[1].id}`); }
        if (drop && finite(drop.etaTimestamp)) parts.push(`Largage prévu à ${spokenTime(drop.etaTimestamp)}.`);
        if (end && finite(end.etaTimestamp)) parts.push(`Atterrissage prévu à ${spokenTime(end.etaTimestamp)}.`);
        else { parts.push('Vent non vérifié : aucune heure prévue ni alerte de largage. Lancez la vérification du vent.'); urgent = true; }
        const s = summary();
        if (s.maxWindMs != null && s.maxWindMs > WIND_OK && s.maxWindWp) {
          parts.push(`Attention, vent de ${spokenNum(s.maxWindMs)} mètres par seconde prévu au ${ptName(wps[s.maxWindWp - 1], s.maxWindWp - 1)}.`);
          urgent = s.maxWindMs > WIND_MAX;
        }
      } else if (isAutoPass(w)) {
        // point passé sans saisie : estimation appliquée (pas d'alerte batterie sur une estimation)
        parts.push(`${ptName(w, i).replace(/^p/, 'P')} non saisi : estimation appliquée, passage à ${spokenTime(w.actualPassedAt)}`
          + `${isAutoMah(w) ? `, ${spokenNum(w.actualCumulativeMah)} milliampères-heure` : ''}`
          + `${isAutoV(w) ? `, ${spokenNum(w.actualVoltage, 1)} volts` : ''}. Corrigez si besoin.`);
        if (parts.length) say(parts.join(' '));
        return;
      } else {
        const delta = finite(w.etaTimestamp) ? w.actualPassedAt - w.etaTimestamp : null;
        const timing = delta == null ? '' : Math.abs(delta) < 60000 ? ', à l\'heure' : `, ${spokenDur(delta)} ${delta > 0 ? 'de retard' : 'd\'avance'}`;
        parts.push(last ? `Atterrissage enregistré${timing}. Mission terminée.` : `${ptName(w, i).replace(/^p/, 'P')} enregistré${timing}.`);
        if (delta != null && delta > 300000) urgent = true;
      }
    }
    if (changes.mah) {
      const est = w.cumulativeEstimatedMah;
      if (finite(est) && est > 0) {
        const over = ((w.actualCumulativeMah - est) / est) * 100;
        if (w.actualCumulativeMah - est > 150 && over > 10) { parts.push(`Attention, consommation ${spokenNum(over)} % au-dessus de l'estimation.`); urgent = true; }
        // marge projetée : consommation réelle + reste de la route estimé, réserve comprise
        const cap = Number(elements.batteryCapacity.value);
        const estEnd = lastFinite(wps, 'cumulativeEstimatedMah');
        if (cap > 0 && finite(estEnd) && !last) {
          const projected = w.actualCumulativeMah + (estEnd - est);
          const margin = (1 - (projected * (1 + RESERVE)) / cap) * 100;
          if (margin < 0) { parts.push(`Alerte batterie : la réserve de ${Math.round(RESERVE * 100)} % sera entamée avant l'atterrissage.`); urgent = true; }
          else if (margin < 10) { parts.push(`Alerte batterie : marge projetée ${spokenNum(margin)} %, réserve comprise.`); urgent = true; }
        }
        if (last) parts.push(`Consommation totale ${spokenNum(w.actualCumulativeMah)} milliampères-heure.`);
      }
    }
    if (changes.v && finite(w.estimatedVoltage)) {
      const gap = w.estimatedVoltage - w.actualVoltage;
      if (gap >= 0.5) { parts.push(`Tension ${spokenNum(w.actualVoltage, 1)} volts, ${spokenNum(gap, 1)} volt sous l'estimation.`); urgent = urgent || gap >= 1; }
    }
    if (parts.length) say(parts.join(' '), urgent);
  }

  function voiceTick() {
    const wps = state.waypoints || [];
    const now = Date.now();
    const sig = `${state.missionName}|${wps.map((w) => w.id).join(',')}`;
    if (sig !== voiceSig) { voiceSig = sig; said.clear(); voiceSnap = null; voicePrev = now; }

    // saisies du pilote (passage, mAh, tension) depuis la dernière seconde
    const snap = wps.map((w) => ({ id: w.id, pass: w.actualPassedAt ?? null, mah: w.actualCumulativeMah ?? null, v: w.actualVoltage ?? null }));
    if (voiceSnap) {
      snap.forEach((c, i) => {
        const o = voiceSnap.find((x) => x.id === c.id);
        if (!o) return;
        const changes = { pass: finite(c.pass) && c.pass !== o.pass, mah: finite(c.mah) && c.mah !== o.mah, v: finite(c.v) && c.v !== o.v };
        if (changes.pass || changes.mah || changes.v) announceEntries(wps[i], i, changes);
      });
    }
    voiceSnap = snap;

    // événements horaires franchis depuis le dernier contrôle (pas de rafale au retour de veille)
    const prev = voicePrev;
    voicePrev = now;
    if (prev == null || now <= prev || now - prev > 120000 || !wps.length) return;
    const crossed = (t) => finite(t) && t > prev && t <= now;
    const d = planDelay();
    const shift = d ? d.ms : 0;
    const lastIdx = wps.length - 1;
    // messages du même instant réunis en une phrase (ex. « Point 2 atteint… Montée vers 200 mètres… »)
    const batch = [];
    let urgentBatch = false;
    const add = (id, text, urgent = false) => { if (said.has(id)) return; said.add(id); batch.push(text); urgentBatch = urgentBatch || urgent; };
    wps.forEach((w, i) => {
      if (i === 0 || finite(w.actualPassedAt) || !finite(w.etaTimestamp)) return;
      const t = w.etaTimestamp + shift;
      if (hasDropPoint(w)) {
        if (crossed(t - 300000)) add(`drop5:${w.id}`, `Largage dans 5 minutes au ${ptName(w, i)}, vers ${spokenTime(t)}.`, true);
        if (crossed(t - 60000)) add(`drop1:${w.id}`, 'Largage dans une minute.', true);
        if (crossed(t)) add(`drop0:${w.id}`, `Largage maintenant, ${ptName(w, i)}.`, true);
      } else if (i === lastIdx) {
        if (crossed(t - 120000)) add(`land2:${w.id}`, 'Atterrissage dans 2 minutes.');
        if (crossed(t)) add(`land0:${w.id}`, 'Atterrissage prévu maintenant. Pensez à saisir la consommation finale.');
      } else if (crossed(t) && !(i === 1 && near(w, wps[0]))) {
        add(`wp:${w.id}`, `${ptName(w, i).replace(/^p/, 'P')} atteint selon le plan. Saisissez la consommation.`);
      }
      // début du tronçon vers ce point (départ du point précédent) : montée ou descente annoncée
      const prevW = wps[i - 1];
      if (i >= 2 && finite(prevW.etaTimestamp) && crossed(prevW.etaTimestamp + shift)) {
        const msg = phaseMessage(wps, i);
        if (msg) add(`phase:${w.id}`, msg);
      }
    });
    if (batch.length) say(batch.join(' '), urgentBatch);
    // prévisions de vent trop anciennes pendant le vol
    const flying = finite(wps[0].actualPassedAt) && !finite(wps[lastIdx].actualPassedAt);
    if (flying && finite(state.lastWindCheckAt) && crossed(state.lastWindCheckAt + 3600000)) {
      once(`wind:${state.lastWindCheckAt}`, 'Les prévisions de vent ont plus d\'une heure. Pensez à les revérifier.');
    }
  }

  // -------------------------------------------------------------------
  // Trafic : vols en cours des autres laptops du même drone port
  //  · la passerelle envoie toutes les 5 s l'état de son vol à la page (message `live`),
  //    qui le partage via Supabase et renvoie les autres vols (message `traffic`) ;
  //  · autres drones en violet (route pâle, carte d'identité, signal) ;
  //  · rapprochement (positions recalées, pas GPS) : vigilance < 3 km et < 100 m d'écart
  //    d'altitude, alerte < 1,5 km et < 50 m (bip, répétée toutes les 30 s).
  // -------------------------------------------------------------------
  const TRAFFIC_WARN = { dist: 3000, alt: 100 };
  const TRAFFIC_DANGER = { dist: 1500, alt: 50 };
  let ownPos = null; // { lat, lon, alt, bearing, legIndex } : position recalée (voir placeRecalibrated)
  let traffic = [];
  let trafficSelf = { sharing: false, droneCode: null, reason: null };
  const trafficGroup = L.layerGroup().addTo(map);
  const trafficState = new Map(); // user_id -> { level, lastSaid, status }

  const PHASE_FR = { Climbing: 'montée', Descending: 'descente', Cruise: 'croisière', Dropping: 'largage', Takeoff: 'décollage', Landing: 'atterrissage' };
  function livePayload() {
    const wps = state.waypoints || [];
    if (!wps.length) return null;
    const last = wps[wps.length - 1];
    const flying = finite(wps[0].actualPassedAt);
    const status = finite(last.actualPassedAt) ? 'arrive' : flying ? 'vol' : 'sol';
    const d = planDelay();
    const shift = d ? d.ms : 0;
    const pos = status === 'vol' && ownPos ? ownPos : { lat: wps[0].lat, lon: wps[0].lon, alt: 0, bearing: null, legIndex: 1 };
    let phase = null;
    const leg = wps[pos.legIndex];
    if (status === 'vol' && leg && typeof waypointPhaseLabels === 'function') {
      try {
        const labels = waypointPhaseLabels(leg, pos.legIndex);
        const key = ['Dropping', 'Climbing', 'Descending', 'Cruise'].find((k) => labels.includes(k));
        phase = key ? PHASE_FR[key] : null;
      } catch { /* phase inconnue */ }
    }
    const next = nextIndex(wps);
    const drop = wps.findIndex((w) => hasDropPoint(w));
    const iso = (t) => (finite(t) ? new Date(t).toISOString() : null);
    return {
      status,
      lat: pos.lat, lon: pos.lon,
      altitude_m: finite(pos.alt) ? Math.round(pos.alt) : null,
      heading_deg: pos.bearing != null ? Math.round((pos.bearing + 360) % 360) : null,
      ground_speed_ms: leg && finite(leg.groundSpeed) && status === 'vol' ? Math.round(leg.groundSpeed * 10) / 10 : null,
      phase,
      next_label: next >= 0 ? `pt ${wpLabel(wps[next], next)}` : null,
      next_eta: next >= 0 && finite(wps[next].etaTimestamp) ? iso(wps[next].etaTimestamp + shift) : null,
      delay_s: d ? Math.round(d.ms / 1000) : null,
      takeoff_at: iso(wps[0].actualPassedAt),
      landing_eta: finite(last.etaTimestamp) ? iso(last.actualPassedAt || last.etaTimestamp + shift) : null,
      mission_name: state.missionName || null,
      route: wps.map((w) => [Math.round(w.lat * 1e6) / 1e6, Math.round(w.lon * 1e6) / 1e6, finite(w.altitude) ? Math.round(w.altitude) : null]),
      drop_index: drop >= 0 ? drop : null,
    };
  }
  let liveCountdown = 0;
  let lastLiveKey = '';
  function liveTick() {
    liveCountdown -= 1;
    const p = livePayload();
    const key = p ? p.status : 'none';
    // toutes les 5 s, ou tout de suite quand l'état change (décollage, arrivée, mission effacée)
    if (liveCountdown > 0 && key === lastLiveKey) return;
    liveCountdown = 5;
    lastLiveKey = key;
    post({ type: 'live', data: p });
  }

  const ageS = (f) => Math.max(0, (Date.now() - Date.parse(f.updated_at)) / 1000);
  function trafficLevel(f) {
    if (!ownPos || f.status !== 'vol' || ageS(f) > 60 || !finite(f.lat) || !finite(f.lon)) return { level: 'none' };
    const own = state.waypoints && finite(state.waypoints[0].actualPassedAt) && !finite(state.waypoints[state.waypoints.length - 1].actualPassedAt);
    if (!own) return { level: 'none' };
    const dist = map.distance([ownPos.lat, ownPos.lon], [f.lat, f.lon]);
    const dAlt = finite(f.altitude_m) && finite(ownPos.alt) ? f.altitude_m - ownPos.alt : null;
    const abs = dAlt == null ? 0 : Math.abs(dAlt);
    const level = dist < TRAFFIC_DANGER.dist && abs < TRAFFIC_DANGER.alt ? 'danger' : dist < TRAFFIC_WARN.dist && abs < TRAFFIC_WARN.alt ? 'warn' : 'none';
    return { level, dist, dAlt };
  }
  const spokenAltGap = (dAlt) => (dAlt == null ? 'altitude inconnue' : Math.abs(dAlt) < 10 ? 'même altitude'
    : `${spokenNum(Math.abs(dAlt))} mètres plus ${dAlt > 0 ? 'haut' : 'bas'}`);
  const spokenDist = (m) => (m >= 1000 ? `${spokenNum(m / 1000, 1)} kilomètre${m >= 2000 ? 's' : ''}` : `${spokenNum(Math.round(m / 50) * 50)} mètres`);

  // liste « Trafic » dans la barre d'outils de la carte
  const trafficBox = document.createElement('div');
  trafficBox.className = 'uav-traffic';
  trafficBox.innerHTML = '<button type="button" class="uav-traffic-btn"></button><div class="uav-traffic-pop" hidden></div>';
  if (tools) voiceBox.after(trafficBox);
  const tBtn = trafficBox.querySelector('.uav-traffic-btn'), tPop = trafficBox.querySelector('.uav-traffic-pop');
  tBtn.addEventListener('click', () => { tPop.hidden = !tPop.hidden; });
  document.addEventListener('pointerdown', (e) => { if (!tPop.hidden && !trafficBox.contains(e.target)) tPop.hidden = true; });
  tPop.addEventListener('click', (e) => {
    const item = e.target.closest('[data-user]');
    const f = item && traffic.find((x) => x.user_id === item.dataset.user);
    if (f && finite(f.lat)) { map.flyTo([f.lat, f.lon], Math.max(map.getZoom(), 12), { duration: 0.6 }); tPop.hidden = true; }
  });

  function renderTraffic() {
    trafficGroup.clearLayers();
    const visible = traffic.filter((f) => finite(f.lat) && finite(f.lon) && ageS(f) < 600 && !(f.status === 'arrive' && ageS(f) > 120));
    const now = Date.now();
    let worst = 'none';
    const rows = [];
    for (const f of visible) {
      const t = trafficLevel(f);
      const prev = trafficState.get(f.user_id) || { level: 'none', lastSaid: 0, status: f.status, landingSaid: false };
      // annonces : décollage d'un autre drone, rapprochement, arrivées proches au drone port
      if (prev.status === 'sol' && f.status === 'vol') say(`${f.drone_code} décolle du drone port.`);
      if (t.level === 'warn' && prev.level === 'none') say(`Trafic : ${f.drone_code} à ${spokenDist(t.dist)}, ${spokenAltGap(t.dAlt)}.`);
      if (t.level === 'danger' && (prev.level !== 'danger' || now - prev.lastSaid > 30000)) {
        say(`Alerte trafic : ${f.drone_code} à ${spokenDist(t.dist)}, ${spokenAltGap(t.dAlt)}.`, true);
        prev.lastSaid = now;
      }
      const ownLanding = state.waypoints && state.waypoints.length ? state.waypoints[state.waypoints.length - 1] : null;
      const d = planDelay();
      const ownLandAt = ownLanding && finite(ownLanding.etaTimestamp) && !finite(ownLanding.actualPassedAt) ? ownLanding.etaTimestamp + (d ? d.ms : 0) : null;
      const otherLand = f.landing_eta ? Date.parse(f.landing_eta) : null;
      if (!prev.landingSaid && f.status === 'vol' && ownLandAt && otherLand && ownLanding && near(ownLanding, { lat: f.route && f.route.length ? f.route[f.route.length - 1][0] : NaN, lon: f.route && f.route.length ? f.route[f.route.length - 1][1] : NaN })
        && Math.abs(otherLand - ownLandAt) < 180000 && otherLand > now) {
        const gap = Math.round((ownLandAt - otherLand) / 60000);
        say(`Atterrissage de ${f.drone_code} prévu à ${spokenTime(otherLand)}, ${gap === 0 ? 'en même temps que le vôtre' : `${Math.abs(gap)} minute${Math.abs(gap) > 1 ? 's' : ''} ${gap > 0 ? 'avant' : 'après'} le vôtre`}.`, true);
        prev.landingSaid = true;
      }
      trafficState.set(f.user_id, { ...prev, level: t.level, status: f.status });
      if (t.level === 'danger' || (t.level === 'warn' && worst === 'none')) worst = t.level;

      // route du plan de l'autre drone
      if (Array.isArray(f.route) && f.route.length > 1 && f.status !== 'arrive') {
        L.polyline(f.route.map((r) => [r[0], r[1]]), { renderer: routeRenderer, color: '#b48cff', weight: 3, opacity: 0.45, dashArray: '6 8', interactive: false }).addTo(trafficGroup);
        if (f.drop_index != null && f.route[f.drop_index]) {
          L.circleMarker([f.route[f.drop_index][0], f.route[f.drop_index][1]], { renderer: routeRenderer, radius: 5, color: '#b48cff', weight: 2, fillOpacity: 0.2, interactive: false }).addTo(trafficGroup);
        }
      }
      const age = ageS(f);
      const signal = age < 15 ? 'ok' : age < 60 ? 'late' : 'lost';
      const eta = f.next_eta ? hhmm(Date.parse(f.next_eta)) : null;
      const delay = f.delay_s != null && Math.abs(f.delay_s) >= 30 ? `${f.delay_s > 0 ? '+' : '−'}${fmtDur(f.delay_s * 1000)}` : f.delay_s != null ? 'à l\'heure' : '';
      const line2 = f.status === 'sol' ? 'au sol' : f.status === 'arrive' ? 'arrivé' : [f.phase, finite(f.altitude_m) ? `${f.altitude_m} m` : null, f.ground_speed_ms != null ? `${f.ground_speed_ms} m/s` : null].filter(Boolean).join(' · ');
      const line3 = f.status === 'vol' ? [f.next_label && eta ? `${f.next_label} · ETA ${eta}` : null, delay].filter(Boolean).join(' · ') : '';
      const html = `<div class="uav-tf ${t.level} ${f.status}"><span class="uav-tf-sym"><svg viewBox="0 0 24 24" style="transform:rotate(${finite(f.heading_deg) ? f.heading_deg : 0}deg)"><path d="m12 2 3 11 6 4v3l-7-2-2 4-2-4-7 2v-3l6-4 3-11Z"/></svg></span>`
        + `<span class="uav-tf-card"><b><i class="sig ${signal}" title="${signal === 'ok' ? 'Position à jour' : signal === 'late' ? 'Mise à jour il y a plus de 15 s' : 'Signal perdu'}"></i>${esc(f.drone_code)}<small>${esc(f.pilot_name || '')}</small></b>`
        + `<span>${esc(signal === 'lost' ? `signal perdu · il y a ${Math.round(age / 60)} min` : line2)}</span>${line3 && signal !== 'lost' ? `<span>${esc(line3)}</span>` : ''}`
        + `${t.level !== 'none' ? `<em>${t.level === 'danger' ? '⚠ ' : ''}${fmtKm(t.dist)} · ${t.dAlt == null ? 'alt. ?' : Math.abs(t.dAlt) < 10 ? 'même alt.' : `${t.dAlt > 0 ? '+' : '−'}${Math.round(Math.abs(t.dAlt))} m`}</em>` : ''}</span></div>`;
      L.marker([f.lat, f.lon], { interactive: false, keyboard: false, zIndexOffset: 1050,
        icon: L.divIcon({ className: 'uav-tf-icon', html, iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(trafficGroup);
      rows.push(`<button type="button" data-user="${esc(f.user_id)}" class="${t.level}"><i class="sig ${signal}"></i><b>${esc(f.drone_code)}</b><span>${esc(f.pilot_name || '')}</span><small>${esc(signal === 'lost' ? 'signal perdu' : f.status === 'vol' ? `${f.phase || 'en vol'}${t.dist != null ? ` · ${fmtKm(t.dist)}` : ''}` : f.status === 'sol' ? 'au sol' : 'arrivé')}</small></button>`);
    }
    // vols disparus : on oublie leur état d'alerte
    for (const id of trafficState.keys()) if (!visible.some((f) => f.user_id === id)) trafficState.delete(id);

    const self = trafficSelf.sharing ? `<p class="self ok">Votre position est partagée · <b>${esc(trafficSelf.droneCode || '')}</b></p>`
      : `<p class="self off">${esc(trafficSelf.reason || 'Votre position n\'est pas partagée : choisissez le drone dans la barre de la page.')}</p>`;
    setHtml(tPop, `<b class="title">Vols en cours du drone port</b>${rows.length ? rows.join('') : '<p class="empty">Aucun autre vol en cours.</p>'}${self}`);
    tBtn.className = `uav-traffic-btn ${worst}${trafficSelf.sharing ? ' sharing' : ''}`;
    setHtml(tBtn, `<span class="uav-tf-dot"></span>Trafic${visible.length ? ` <b>${visible.length}</b>` : ''}`);
  }
  renderTraffic();

  // -------------------------------------------------------------------
  // Messages et suivi des changements
  // -------------------------------------------------------------------
  window.addEventListener('message', async (event) => {
    if (event.origin !== ORIGIN || !event.data || event.data.source !== 'uav') return;
    const { type } = event.data;
    try {
      if (type === 'prefill') post({ type: 'prefilled', applied: prefill(event.data.payload || {}) });
      if (type === 'request') post({ type: 'result', data: collect() });
      if (type === 'loadPlan') post({ type: 'planLoaded', ...(await loadPlan(event.data.plan || {})) });
      if (type === 'exportPlan') post({ type: 'planFile', data: exportPlan() });
      if (type === 'layout') setLayout(event.data.mode);
      if (type === 'traffic') {
        traffic = Array.isArray(event.data.flights) ? event.data.flights : [];
        trafficSelf = event.data.self || trafficSelf;
        renderTraffic();
      }
      if (type === 'clear') { clearMission(); lastFile = null; planId = null; save(); }
    } catch (err) {
      const message = `WindPath : ${err && err.message ? err.message : err}`;
      if (type === 'loadPlan') post({ type: 'planLoaded', ok: false, error: message });
      else post({ type: 'result', data: { error: `Lecture de WindPath impossible : ${err && err.message ? err.message : err}` } });
    }
  });

  // état de la mission envoyé à chaque changement (verdict de la page) et sauvegarde locale
  let lastStatus = '';
  let lastSaved = '';
  const tick = () => {
    try {
      const s = summary();
      const json = JSON.stringify(s);
      if (json !== lastStatus) { lastStatus = json; post({ type: 'status', data: s }); }
      updateProgress();
      decorateTable();
      try { pruneAuto(); autoFill(); } catch (err) { console.warn('Estimations automatiques :', err); }
      try { mapTick(); } catch (err) { console.warn('Carte UAV :', err); }
      try { voiceTick(); } catch (err) { console.warn('Voix de mission :', err); }
      try { liveTick(); if (Date.now() % 2000 < 1000) renderTraffic(); } catch (err) { console.warn('Trafic :', err); }
      try { renderDashboard(s); } catch (err) { console.warn('Tableau de bord WindPath :', err); }
      // sauvegarde quand la mission change (pas à chaque seconde)
      const real = (state.waypoints || []).map((w) => `${w.actualCumulativeMah ?? ''}/${w.actualVoltage ?? ''}/${w.actualPassedAt ?? ''}`).join(',');
      const key = `${real}|${s.waypointCount}|${s.missionName}|${s.estimatedMah}|${s.maxWindMs}|${state.lastWindCheckAt}|${elements.takeoffTime.value}|${elements.payloadWeight.value}|${elements.batteryCapacity.value}`;
      if (key !== lastSaved) { lastSaved = key; save(); }
    } catch { /* mission en cours de calcul */ }
  };
  window.addEventListener('pagehide', save);

  const restored = restore();
  post({ type: 'ready' });
  if (restored) post({ type: 'restored', ...restored });
  tick();
  setInterval(tick, 1000);
})();
