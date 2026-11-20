/*
 * Passerelle UAV Maintenance <-> WindPath
 * ---------------------------------------------------------------
 * Injectée par la page « Planification » dans l'iframe WindPath (même origine).
 * Elle s'exécute dans la portée globale de WindPath : elle lit `state`, `elements`
 * et les fonctions de script.js SANS les modifier, et échange des messages avec
 * l'application via postMessage (origine vérifiée).
 *
 * Messages reçus (source: 'uav')       : prefill { payloadKg, capacityMah, departureVoltage }, request
 * Messages envoyés (source: 'windpath') : ready, prefilled { applied }, result { data }
 */
(() => {
  if (window.__uavBridge) return;
  window.__uavBridge = true;

  const ORIGIN = window.location.origin;
  const post = (msg) => window.parent.postMessage({ source: 'windpath', ...msg }, ORIGIN);
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function setInput(el, value, eventName) {
    const n = Number(value);
    if (!el || value == null || value === '' || !Number.isFinite(n)) return false;
    el.value = String(n);
    el.dispatchEvent(new Event(eventName, { bubbles: true }));
    return true;
  }

  function prefill(p) {
    const applied = [];
    if (setInput(elements.payloadWeight, p.payloadKg, 'change')) applied.push(`colis ${p.payloadKg} kg`);
    if (setInput(elements.batteryCapacity, p.capacityMah, 'input')) applied.push(`capacité ${Math.round(p.capacityMah)} mAh`);
    if (setInput(elements.departureVoltage, p.departureVoltage, 'input')) applied.push(`tension de départ ${p.departureVoltage} V`);
    return applied;
  }

  /** Résultats de la mission en cours (valeurs réelles si saisies dans WindPath, sinon estimations) */
  function collect() {
    const wps = state.waypoints || [];
    if (!wps.length) return { error: 'Aucun point de passage : importez un plan de vol ou cliquez sur la carte dans WindPath.' };

    let distance = 0, windWeight = 0, windSpeedSum = 0, windX = 0, windY = 0;
    for (let i = 1; i < wps.length; i += 1) {
      const d = distanceAndBearing(wps[i - 1], wps[i]).distance;
      distance += d;
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

    const lastFinite = (key) => { for (let i = wps.length - 1; i >= 0; i -= 1) if (finite(wps[i][key])) return wps[i][key]; return null; };
    const realMah = lastFinite('actualCumulativeMah');
    const estMah = lastFinite('cumulativeEstimatedMah');
    const realVoltEnd = lastFinite('actualVoltage');
    const estVoltEnd = lastFinite('estimatedVoltage');

    const drop = typeof hasDropPoint === 'function' ? wps.find((wp) => hasDropPoint(wp)) : null;
    const last = wps[wps.length - 1];
    const timeOf = (wp) => (!wp ? null
      : finite(wp.actualPassedAt) ? { value: hhmm(wp.actualPassedAt), source: 'reel' }
      : finite(wp.etaTimestamp) ? { value: hhmm(wp.etaTimestamp), source: 'estime' } : null);

    const takeoff = elements.takeoffTime && elements.takeoffTime.value ? elements.takeoffTime.value : null;
    const departureVoltage = Number(elements.departureVoltage && elements.departureVoltage.value);
    const payloadKg = Number(elements.payloadWeight && elements.payloadWeight.value);

    return {
      missionName: state.missionName || null,
      waypointCount: wps.length,
      windChecked: Boolean(state.lastWindCheckAt),
      takeoffDate: takeoff ? takeoff.slice(0, 10) : null,
      takeoffTime: takeoff ? takeoff.slice(11, 16) : null,
      dropTime: timeOf(drop),
      landingTime: timeOf(last),
      distanceKm: distance > 0 ? Math.round(distance / 10) / 100 : null,
      windSpeedMs: windWeight ? Math.round((windSpeedSum / windWeight) * 10) / 10 : null,
      windDirectionDeg: windWeight ? Math.round(((Math.atan2(windX, windY) * 180) / Math.PI + 360) % 360) % 360 : null,
      cruiseAltitudeAmsl: cruise == null ? null : Math.round(cruise),
      consumption: finite(realMah) ? { value: Math.round(realMah), source: 'reel' } : finite(estMah) ? { value: Math.round(estMah), source: 'estime' } : null,
      voltageEnd: finite(realVoltEnd) ? { value: Math.round(realVoltEnd * 100) / 100, source: 'reel' }
        : finite(estVoltEnd) ? { value: Math.round(estVoltEnd * 100) / 100, source: 'estime' } : null,
      departureVoltage: Number.isFinite(departureVoltage) ? departureVoltage : null,
      payloadKg: Number.isFinite(payloadKg) ? payloadKg : null,
    };
  }

  // -------------------------------------------------------------------
  // Thème UAV Maintenance appliqué à WindPath (sans modifier ses fichiers)
  //  1. mode sombre de WindPath imposé (l'application principale est toujours sombre) ;
  //  2. variables de couleur et police remplacées par celles de l'application ;
  //  3. couleurs codées en dur du mode sombre de WindPath recolorées à la volée
  //     (accent vert → bleu, ardoise → bleu nuit), en lisant sa feuille de style.
  // -------------------------------------------------------------------
  function applyUavTheme() {
    const doc = document;
    try { localStorage.setItem('windpath-theme', 'dark'); } catch { /* stockage indisponible */ }
    doc.documentElement.dataset.theme = 'dark';
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
          const t = recolor(rule.cssText, dark);
          if (t !== rule.cssText) extra.push(wrap(t));
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
    `;
  }
  try { applyUavTheme(); } catch (err) { console.warn('Thème UAV non appliqué à WindPath :', err); }

  window.addEventListener('message', (event) => {
    if (event.origin !== ORIGIN || !event.data || event.data.source !== 'uav') return;
    try {
      if (event.data.type === 'prefill') post({ type: 'prefilled', applied: prefill(event.data.payload || {}) });
      if (event.data.type === 'request') post({ type: 'result', data: collect() });
    } catch (err) {
      post({ type: 'result', data: { error: `Lecture de WindPath impossible : ${err && err.message ? err.message : err}` } });
    }
  });

  post({ type: 'ready' });
})();
