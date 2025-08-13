/* Julie la championne — Web App QCM (rev. 2025‑08‑13c)
   - Deux datasets JSON: Annales 2020–2024 (enrichi) + Actualités 2024Q4
   - Mobile-first, PWA, révisions espacées (SM‑2 light), stats, mode examen
   - Chemins relatifs (GitHub Pages)
*/

(() => {
  'use strict';

  // ========= Constantes & config =========
  const APP_VER = '4.1.1'; // ✨ bump
  const LS_KEY  = 'julie.v3.state';     // conserve la clé
  const DAY     = 24 * 60 * 60 * 1000;

  // IMPORTANT : laissez les chemins *relatifs* au repo GitHub Pages.
  const SOURCES = [
    { id:'annales',  label:'Annales 2020–2024', url:'./data/annales_qcm_2020_2024_enrichi.json', enabled:true },
    { id:'actu24q4', label:'Actualités 2024Q4', url:'./data/qcm_actualites_2024Q4.json',          enabled:true }
  ];

  // ========= État global =========
  const state = {
    _ver: APP_VER,
    mode: 'practice', // practice | exam | review
    all: [],          // toutes les questions normalisées
    pool: [],         // sélection courante (session en cours)
    index: 0,         // index dans la session en cours
    selection: new Set(SOURCES.map(s => s.url)), // sources cochées par défaut

    // ✨ Options persistées et appliquées
    opts: {
      newOnly: false,
      dueFirst: true,
      shuffle: true
    },

    goalDaily: 20,

    // Paramètres d’examen
    exam: { total: 50, timer: 50*60, startedAt: 0 },

    // Infos de session (entraînement/examen/révision)
    session: {
      kind: null,           // 'practice' | 'exam' | 'review'
      total: 0,
      startedAt: 0,
      answers: [],          // {id, chosen, correctIdx, ok}
      score: 0
    },

    // Historique des sessions enregistrées
    history: {
      practice: [],         // [{date, total, score, durationMs}]
      exam: []              // [{date, total, score, durationMs, details:[...]}]
    },

    stats: {
      // par qid: { attempts, correct, streak, easiness, interval, dueAt, lastAt, srcUrl, srcLabel }
      q: {},
      // par jour (YYYY-MM-DD): validations (tentatives comptées)
      days: {}
    },

    ui: { deferredPrompt: null },

    // flags de la question courante
    answered: false,        // une option a été cochée et enregistrée
    solutionShown: false,   // solution affichée (entraînement/révision)
    revealed: false         // solution révélée explicitement (examen)
  };

  // ========= Utilitaires DOM & divers =========
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const todayKey = () => new Date().toISOString().slice(0,10);
  const ABCD = 'ABCD';

  function shuffle(arr){
    for (let i = arr.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function toast(msg, bad=false){
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.setAttribute('role','status');              // ✨ a11y
    el.setAttribute('aria-live','polite');         // ✨ a11y
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); el.remove(); }, 2600);
  }

  // Style minimal pour toasts (autonome)
  (function injectToastCSS(){
    const style = document.createElement('style');
    style.textContent = `
      .toast{position:fixed;left:50%;bottom:18px;transform:translate(-50%,20px);opacity:0;
        background:#111827;border:1px solid #e5e7eb;color:#f9fafb;padding:10px 14px;border-radius:10px;
        box-shadow:0 8px 30px rgba(0,0,0,.2);transition:.2s;font-size:14px;z-index:9999}
      .toast.show{transform:translate(-50%,0);opacity:1}
      .toast.bad{background:#7f1d1d}
    `;
    document.head.appendChild(style);
  })();

  // ========= SRS (SM‑2 simplifié) =========
  function initItemStat(id, srcUrl, srcLabel){
    state.stats.q[id] ||= {
      attempts: 0, correct: 0, streak: 0, easiness: 2.5,
      interval: 0, dueAt: 0, lastAt: 0,
      srcUrl, srcLabel
    };
    return state.stats.q[id];
  }

  function scheduleNext(s, wasCorrect){
    const q = wasCorrect ? 5 : 2; // qualité binaire
    s.easiness = Math.max(1.3, s.easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    if (!wasCorrect){
      s.interval = 1;
      s.streak = 0;
    } else {
      s.streak++;
      if (s.streak === 1) s.interval = 1;
      else if (s.streak === 2) s.interval = 3;
      else s.interval = Math.round(s.interval * s.easiness);
    }
    const now = Date.now();
    s.dueAt = now + s.interval * DAY;
    s.lastAt = now;
  }

  // ========= Normalisation datasets (tolérante) =========
  function safeAnswerIndex(raw){
    // accepte 0–3, 1–4, 'A'..'D', 'a'..'d', '1'..'4' (string)
    if (typeof raw === 'number'){
      if (raw >= 0 && raw <= 3) return raw;
      if (raw >= 1 && raw <= 4) return raw - 1;
    }
    if (typeof raw === 'string'){
      const m = raw.trim().toUpperCase();
      if (ABCD.includes(m)) return ABCD.indexOf(m);
      if (/^[1-4]$/.test(m)) return (+m) - 1;
      const c = m.replace(/[^A-D]/g, '')[0];
      if (ABCD.includes(c)) return ABCD.indexOf(c);
    }
    return 0;
  }

  function pickFirstNonEmpty(...vals){
    for (const v of vals){
      if (v === null || v === undefined) continue;
      const s = (typeof v === 'string') ? v.trim() : v;
      if (typeof s === 'string' && s) return s;
      if (typeof s === 'number' && !Number.isNaN(s)) return s;
      if (Array.isArray(s) && s.length) return s;
      if (s && typeof s === 'object' && Object.keys(s).length) return s;
    }
    return '';
  }

  // Retourne un tableau d’objets normalisés :
  // { id, question, options[4], answerIndex, explanation, srcUrl, srcLabel, meta? }
  function normalizeDataset(json, src){
    const out = [];
    const { label: srcLabel, url: srcUrl, id: srcId } = src;

    // 1) Récupérer la liste d’items, quel que soit le conteneur
    let list = [];
    if (Array.isArray(json)) list = json;
    else {
      const buckets = [
        json.questions, json.items, json.data, json.list, json.qcm, json.qs
      ].filter(Array.isArray);
      if (buckets.length) buckets.forEach(b => list.push(...b));
      if (!buckets.length && json.sections && Array.isArray(json.sections)){
        json.sections.forEach(sec => {
          const arr = pickFirstNonEmpty(sec.questions, sec.items);
          if (Array.isArray(arr)) list.push(...arr);
        });
      }
    }

    // 2) Mapper chaque item vers le format attendu
    list.forEach((raw, i) => {
      const qtext = pickFirstNonEmpty(
        raw.question, raw.q, raw.text, raw.prompt, raw.enonce, raw.enoncé, raw.title
      );
      const question = (qtext || '').toString().trim();
      if (!question) return;

      // B) Options
      let options = [];
      const objChoices = pickFirstNonEmpty(
        raw.choices, raw.choix, raw.propositions, raw.reponses, raw.réponses, raw.answers, raw.options
      );

      const tryObjToArray = (o) => {
        const take = k => (o[k] ?? o[k.toLowerCase()] ?? o[k.toUpperCase()]);
        const arr = [take('A'), take('B'), take('C'), take('D')].map(x => (x ?? '').toString());
        return arr.every(s => s.trim()) ? arr : null;
      };

      if (Array.isArray(objChoices)){
        options = objChoices.slice(0, 4).map(x => (x ?? '').toString());
      } else if (objChoices && typeof objChoices === 'object'){
        options = tryObjToArray(objChoices) ?? [];
        if (!options.length){
          const arr = [objChoices[1], objChoices[2], objChoices[3], objChoices[4]].map(x => (x ?? '').toString());
          if (arr.every(s => s.trim())) options = arr;
        }
      }
      if (options.length !== 4 || options.some(o => !o.trim())) return;

      const ansRaw = pickFirstNonEmpty(
        raw.answer_index, raw.answerIndex, raw.correct_index, raw.correctIndex,
        raw.correct_idx, raw.correct, raw.bonne, raw.bonne_reponse, raw.bonneRéponse,
        raw.answer, raw.letter, raw.reponse, raw.réponse
      );
      const answerIndex = safeAnswerIndex(ansRaw);

      let explanation = pickFirstNonEmpty(
        raw.explanation, raw.explication, raw.justification, raw.comment, raw.solution, raw.correction, raw.answer_text, raw.detail
      );
      explanation = (explanation || '').toString();
      const srcNote = pickFirstNonEmpty(raw.source, raw.lien, raw.url, raw.link);
      if (srcNote) explanation = explanation ? `${explanation} (source: ${srcNote})` : `source: ${srcNote}`;

      const baseId = pickFirstNonEmpty(raw.id, raw.uid, raw.key, `${srcId}-${i}`);
      const id = `${srcId}::${baseId}`;

      const meta = {};
      ['year','annee','session','theme','thème','tags','categorie','catégorie'].forEach(k => {
        if (raw[k] !== undefined) meta[k] = raw[k];
      });

      out.push({ id, question, options, answerIndex, explanation, srcUrl, srcLabel, meta });
    });

    return out;
  }

  // ========= Chargement des fichiers =========
  async function fetchJson(url){
    const abs = new URL(url, location.href).href;
    const res = await fetch(abs, { cache: 'no-store' }); // ✨ on laisse SW gérer le cache
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadAll(){
    const acc = [];
    for (const src of SOURCES){
      if (!src.enabled) continue;
      try {
        const json = await fetchJson(src.url);
        const list = normalizeDataset(json, src);
        list.forEach(q => initItemStat(q.id, src.url, src.label));
        acc.push(...list);
      } catch (e) {
        toast(`Erreur de chargement: ${src.label} — ${e.message}`, true);
      }
    }
    state.all = acc;
    save();
  }

  // ========= Persistance =========
  function save(){
    const dump = {
      _ver: APP_VER,
      mode: state.mode,
      selection: Array.from(state.selection),
      goalDaily: state.goalDaily,
      stats: state.stats,
      history: state.history,
      // ✨ on persiste les options
      opts: state.opts
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(dump)); } catch { /* ignore */ }
  }

  function restore(){
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj._ver){
        state.mode      = obj.mode || 'practice';
        state.goalDaily = obj.goalDaily || 20;
        state.stats     = obj.stats || { q:{}, days:{} };
        state.history   = obj.history || { practice:[], exam:[] };
        const def = SOURCES.map(s => s.url);
        state.selection = new Set(Array.isArray(obj.selection) ? obj.selection : def);
        // ✨ restau options
        if (obj.opts) state.opts = Object.assign(state.opts, obj.opts);
      }
    } catch { /* ignore */ }
  }

  // ========= Construction du pool et gestion des sessions =========
  function buildFilteredItems(){
    const keep = new Set(state.selection);
    let items = state.all.filter(q => keep.has(q.srcUrl));

    // ✨ filtrage/tri selon options
    if (state.opts.newOnly){
      items = items.filter(q => (state.stats.q[q.id]?.attempts || 0) === 0);
    }

    if (state.opts.dueFirst){
      const now = Date.now();
      items = items.slice().sort((a,b) => {
        const sa = state.stats.q[a.id] || {}, sb = state.stats.q[b.id] || {};
        const da = sa.dueAt || 0, db = sb.dueAt || 0;
        const aDue = da <= now, bDue = db <= now;
        if (aDue !== bDue) return aDue ? -1 : 1;   // dues d’abord
        return (da || Infinity) - (db || Infinity); // puis par échéance
      });
    }

    if (state.opts.shuffle){
      items = shuffle(items);
    }

    return items;
  }

  function startSession(kind){
    state.mode = kind;               // 'practice' | 'exam' | 'review'
    const items = buildFilteredItems();
    let pool = [];

    if (kind === 'review'){
      const wrong = items.filter(q => {
        const s = state.stats.q[q.id];
        return s && s.attempts > 0 && s.correct < s.attempts; // uniquement manquées
      });
      pool = shuffle(wrong.slice()).slice(0, Math.min(20, wrong.length));
    } else if (kind === 'exam'){
      pool = items.slice(0, Math.min(state.exam.total, items.length));
      if (state.opts.shuffle) shuffle(pool);
    } else { // practice
      pool = items.slice(0, Math.min(20, items.length));
    }

    state.pool = pool;
    state.index = 0;
    state.session = {
      kind, total: pool.length, startedAt: Date.now(),
      answers: [], score: 0
    };
    state.answered = false;
    state.solutionShown = false;
    state.revealed = false;

    renderHUD();
    renderQuestion();

    if (kind === 'exam'){
      state.exam.startedAt = Date.now();
      tickExam();
    } else {
      const el = $('#subtitle'); if (el) el.textContent = SOURCES.map(s => s.label).join(' + ');
    }
  }

  // ========= UI binding =========
  function bindUI(){
    // Sources (checkboxes)
    const box = $('#sources');
    if (box) box.innerHTML = '';
    for (const src of SOURCES){
      const id = `src-${src.id}`;
      const label = document.createElement('label');
      label.className = 'src';
      label.innerHTML = `
        <input type="checkbox" id="${id}">
        <span>${src.label}</span>
      `;
      box?.appendChild(label);
      const input = $('#'+id);
      if (input){
        input.checked = state.selection.has(src.url);
        input.addEventListener('change', (e) => {
          const checked = !!(e.target && e.target.checked);
          if (checked) state.selection.add(src.url);
          else state.selection.delete(src.url);
          renderKPIs(); save();
        });
      }
    }

    // Segmented control (modes)
    $$('.seg').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.seg').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected','false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected','true');
        const mode = btn.dataset.mode;
        startSession(mode);
        renderKPIs(); save();
      });
    });

    // Options (persistées)
    const optNew   = $('#opt-newOnly');
    const optDue   = $('#opt-dueFirst');
    const optShuf  = $('#opt-shuffle');
    if (optNew)  optNew.checked  = !!state.opts.newOnly;
    if (optDue)  optDue.checked  = !!state.opts.dueFirst;
    if (optShuf) optShuf.checked = !!state.opts.shuffle;

    if (optNew)  optNew.addEventListener('change',  e => { state.opts.newOnly  = !!e.target.checked;  save(); });
    if (optDue)  optDue.addEventListener('change',  e => { state.opts.dueFirst = !!e.target.checked;  save(); });
    if (optShuf) optShuf.addEventListener('change', e => { state.opts.shuffle  = !!e.target.checked;  save(); });

    // Objectif quotidien
    $('#goal-dec')?.addEventListener('click', () => setGoal(state.goalDaily - 1));
    $('#goal-inc')?.addEventListener('click', () => setGoal(state.goalDaily + 1));
    const goalInput = $('#goal-input');
    if (goalInput) {
      goalInput.value = state.goalDaily;
      goalInput.addEventListener('change', e => {
        const v = parseInt(e.target.value, 10);
        setGoal(Number.isFinite(v) ? v : 1);
      });
    }

    // Actions question
    $('#btn-reveal')?.addEventListener('click', reveal);
    $('#btn-next')?.addEventListener('click', next);
    $('#btn-restart')?.addEventListener('click', () => startSession(state.mode === 'exam' ? 'practice' : state.mode));

    // Reset progression (soft)
    $('#btn-reset')?.addEventListener('click', resetProgress);

    // Reboot complet (hard reset + SW)
    $('#btn-reboot')?.addEventListener('click', hardResetApp);

    // Raccourcis clavier (✨ A/B/C/D corrigé)
    document.addEventListener('keydown', (e) => {
      if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.code === 'Space'){ e.preventDefault(); validate(); }
      else if (e.key === 'n' || e.key === 'N'){ next(); }
      else if (e.key === 'r' || e.key === 'R'){ reveal(); }
      else {
        const key = (e.key || '').toUpperCase();
        let idx = -1;
        if ('1234'.includes(key)) idx = Number(key) - 1;
        else if ('ABCD'.includes(key)) idx = 'ABCD'.indexOf(key);
        if (idx >= 0 && idx < 4){
          const radios = $$('#q-choices input[type=radio]');
          if (radios[idx]){ radios[idx].checked = true; validate(); }
        }
      }
    });

    // PWA install
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.ui.deferredPrompt = e;
      const btn = $('#btn-install');
      if (btn) btn.hidden = false; // ✨ au lieu de style inline
    });
    $('#btn-install')?.addEventListener('click', () => {
      if (state.ui.deferredPrompt){ state.ui.deferredPrompt.prompt(); }
    });

    // Online/offline feedback
    window.addEventListener('offline', () => toast('Mode hors-ligne activé'));
    window.addEventListener('online',  () => toast('Connexion rétablie'));
  }

  function setGoal(n){
    state.goalDaily = clamp(n, 1, 500);
    const inp = $('#goal-input'); if (inp) inp.value = state.goalDaily;
    renderKPIs(); save();
  }

  // ========= KPI / HUD / Spark =========
  function drawSpark(){
    const el = $('#spark'); if (!el || !el.getContext) return;
    const ctx = el.getContext('2d');
    const days = [];
    for (let i = 13; i >= 0; i--){
      const d = new Date(Date.now() - i * DAY).toISOString().slice(0,10);
      days.push(state.stats.days[d] || 0);
    }
    const W = el.width, H = el.height;
    const max = Math.max(1, ...days);
    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle = '#e5e7eb';
    ctx.beginPath(); ctx.moveTo(32, H-24); ctx.lineTo(W-8, H-24); ctx.stroke();
    ctx.strokeStyle = '#0ea5e9';
    ctx.beginPath();
    days.forEach((v,i) => {
      const x = 32 + i * ((W - 48) / 13);
      const y = H - 24 - (H - 60) * (v / max);
      if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    // ✨ points pleins de la même couleur
    ctx.fillStyle = '#0ea5e9';
    days.forEach((v,i) => {
      const x = 32 + i * ((W - 48) / 13);
      const y = H - 24 - (H - 60) * (v / max);
      ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill();
    });
  }

  function renderKPIs(){
    const totalEl = $('#kpi-total'); if (totalEl) totalEl.textContent = state.all.length.toString();
    const due = Object.values(state.stats.q).filter(s => (s.dueAt || 0) <= Date.now()).length;
    const dueEl = $('#kpi-due'); if (dueEl) dueEl.textContent = due.toString();

    const attempts = Object.values(state.stats.q).reduce((a,s)=>a+(s.attempts||0),0);
    const corrects = Object.values(state.stats.q).reduce((a,s)=>a+(s.correct||0),0);
    const accEl = $('#kpi-accuracy'); if (accEl) accEl.textContent = attempts ? Math.round(100*corrects/attempts)+'%' : '—';

    const doneToday = state.stats.days[todayKey()] || 0;
    const goalEl = $('#kpi-goal'); if (goalEl) goalEl.textContent = `${doneToday}/${state.goalDaily}`;

    // Stats par source
    const list = $('#by-source'); if (list) list.innerHTML = '';
    const agg = {};
    for (const s of Object.values(state.stats.q)){
      const key = s.srcLabel || 'Source';
      agg[key] ||= { attempts:0, correct:0 };
      agg[key].attempts += s.attempts || 0;
      agg[key].correct  += s.correct  || 0;
    }
    if (list){
      for (const [label,v] of Object.entries(agg)){
        const li = document.createElement('li');
        const pct = v.attempts ? Math.round(100*v.correct/v.attempts)+'%' : '—';
        li.innerHTML = `<span>${label}</span><span class="muted">${pct} • ${v.attempts} essais</span>`;
        list.appendChild(li);
      }
    }

    drawSpark();
    renderHistory();
  }

  function renderHUD(){
    const hud = $('#session-hud'); if (!hud) return;

    if (!state.session.kind){
      hud.classList.add('hidden'); return;
    }
    hud.classList.remove('hidden');

    if (state.session.kind === 'exam'){
      const n = state.index + 1, N = state.session.total || state.pool.length || 0;
      const l = $('#hud-left');  if (l) l.textContent  = 'Examen';
      const m = $('#hud-mid');   if (m) m.textContent   = `Question ${Math.min(n, N)}/${N}`;
      const r = $('#hud-right'); if (r) r.textContent = '';
    } else {
      const answeredCount = state.session.answers.length;
      const goodSoFar = state.session.answers.filter(a => a.ok).length;
      const n = Math.max(answeredCount, state.index + 1);
      const N = state.session.total || state.pool.length || 0;
      const l = $('#hud-left');  if (l) l.textContent  = (state.session.kind === 'review') ? 'Révisions' : 'Entraînement';
      const m = $('#hud-mid');   if (m) m.textContent   = `Question ${Math.min(n, N)}/${N}`;
      const r = $('#hud-right'); if (r) r.textContent = `Score ${goodSoFar}/${answeredCount || 0}`;
    }
  }

  function renderHistory(){
    const box = $('#history'); if (!box) return;
    const fmt = (ms) => {
      const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
      return `${m} min ${String(s).padStart(2,'0')} s`;
    };
    const mkItem = (h, kind) => {
      const when = new Date(h.date).toLocaleString();
      const label = kind === 'exam' ? 'Examen' : 'Entraînement';
      return `<li><span>${label}</span><span class="muted">${when}</span><span class="muted">${h.score}/${h.total} • ${fmt(h.durationMs)}</span></li>`;
    };
    const lastPractice = state.history.practice.slice(-6);
    const lastExam     = state.history.exam.slice(-6);
    box.innerHTML = [
      ...lastExam.map(h => mkItem(h, 'exam')),
      ...lastPractice.map(h => mkItem(h, 'practice'))
    ].reverse().join('') || '<li class="muted">Aucune session enregistrée pour le moment.</li>';
  }

  // ========= Rendu d’une question =========
  function renderQuestion(){
    renderHUD();
    const q = state.pool[state.index];
    const fb = $('#q-feedback');

    if (!q){
      const qt = $('#q-text');    if (qt) qt.textContent = 'Aucune question dans la sélection.';
      const qc = $('#q-choices'); if (qc) qc.innerHTML = '';
      if (fb){ fb.className = 'feedback'; fb.textContent = ''; }
      const tg = $('#q-tag');     if (tg) tg.textContent = '—';
      const qi = $('#q-index');   if (qi) qi.textContent = '—';
      updateNextLabel();
      return;
    }

    const qt = $('#q-text');   if (qt) qt.textContent   = q.question;
    const tg = $('#q-tag');    if (tg) tg.textContent    = q.srcLabel;
    const qi = $('#q-index');  if (qi) qi.textContent  = `${state.index + 1} / ${state.pool.length}`;

    const wrap = $('#q-choices'); if (wrap) {
      wrap.innerHTML = '';
      wrap.setAttribute('role','radiogroup'); // a11y
      wrap.setAttribute('aria-labelledby','q-text');

      q.options.forEach((opt, i) => {
        const lab = document.createElement('label');
        lab.className = 'choice';
        lab.innerHTML = `
          <input type="radio" name="choice">
          <span class="letter">${ABCD[i]}</span>
          <span class="opt-text">${opt}</span>
        `;
        wrap.appendChild(lab);
      });
    }

    if (fb){ fb.className = 'feedback'; fb.textContent = ''; }

    state.answered = false;
    state.solutionShown = false;
    state.revealed = false;
    updateNextLabel();
  }

  function mark(correctIdx, chosenIdx, showSolution){
    const nodes = $$('#q-choices .choice');
    nodes.forEach((n,i) => {
      n.classList.remove('correct','wrong','chosen');
      if (!showSolution){
        if (i === chosenIdx) n.classList.add('chosen'); // surligner uniquement le choix
      } else {
        if (i === correctIdx) n.classList.add('correct');
        if (i === chosenIdx && chosenIdx !== correctIdx) n.classList.add('wrong');
      }
    });
  }

  const current = () => state.pool[state.index];

  function updateNextLabel(){
    const btn = $('#btn-next'); if (!btn) return;
    if (state.session.kind === 'exam'){
      btn.textContent = 'Suivante ↵';
      return;
    }
    // entraînement / révision : 1er clic → montrer la solution ; 2e clic → passer à la suivante
    btn.textContent = (!state.answered || !state.solutionShown) ? 'Afficher la solution' : 'Question suivante ↵';
  }

  function validate(){
    if (state.answered) return;
    const q = current(); if (!q) return;

    const radios = $$('#q-choices input[type=radio]');
    const idx = radios.findIndex(r => r.checked);
    if (idx < 0){ toast('Choisis une réponse'); return; }

    const ok = (idx === q.answerIndex);

    // Marquage : en examen on ne montre pas la solution tant que non "Révéler"
    if (state.session.kind === 'exam'){
      mark(q.answerIndex, idx, /*showSolution*/false);
    } else {
      mark(q.answerIndex, idx, /*showSolution*/false);
    }

    // Feedback minimal
    const fb = $('#q-feedback');
    if (fb){
      if (state.session.kind === 'exam'){
        fb.className = 'feedback';
        fb.textContent = 'Réponse enregistrée. Tu peux passer à la suivante (utilise “Révéler” pour afficher la solution).';
      } else {
        fb.className = 'feedback';
        fb.textContent = 'Réponse enregistrée.';
      }
    }

    // SRS + stats
    const s = initItemStat(q.id, q.srcUrl, q.srcLabel);
    s.attempts++; if (ok) s.correct++;
    scheduleNext(s, ok);

    // progression du jour
    const k = todayKey(); state.stats.days[k] = (state.stats.days[k] || 0) + 1;

    // session
    state.session.answers.push({ id: q.id, chosen: idx, correctIdx: q.answerIndex, ok });
    if (ok) state.session.score++;

    state.answered = true;
    save();
    renderKPIs();
    renderHUD();
    updateNextLabel();
  }

  function reveal(){
    const q = current(); if (!q) return;

    // Affiche la solution + explication
    const lastChosen = state.session.answers.at(-1)?.chosen ?? -1;
    mark(q.answerIndex, lastChosen, /*showSolution*/true);
    const fb = $('#q-feedback');
    if (fb){
      fb.className = 'feedback';
      const txt = `Réponse : ${ABCD[q.answerIndex]}. ${q.explanation || ''}`.trim();
      fb.textContent = txt;
    }

    state.solutionShown = true;
    state.revealed = true;
    updateNextLabel();
  }

  function goNextQuestionOrFinish(){
    if (state.index < state.pool.length - 1){
      state.index++; renderQuestion();
    } else {
      finishSession();
    }
  }

  function next(){
    const mode = state.session.kind;

    // si rien n'est coché → on valide pour générer le feedback
    const anyChecked = $$('#q-choices input[type=radio]').some(r => r.checked);
    if (!anyChecked){ validate(); return; }

    if (mode === 'exam'){
      // examen : jamais de solution automatique
      if (!state.answered){ validate(); return; }
      goNextQuestionOrFinish();
      return;
    }

    // entraînement / révision : 1er clic après validation → montrer la solution
    if (!state.answered){ validate(); return; }
    if (!state.solutionShown){ reveal(); return; }
    goNextQuestionOrFinish();
  }

  function finishSession(){
    const durationMs = Date.now() - state.session.startedAt;
    const total = state.session.total || state.pool.length;
    const score = state.session.score;

    // Affichage du résumé / détail
    renderResultsPanel();

    // Historisation (sauf révision)
    if (state.session.kind === 'practice'){
      state.history.practice.push({ date: Date.now(), total, score, durationMs });
      if (state.history.practice.length > 50) state.history.practice = state.history.practice.slice(-50);
    } else if (state.session.kind === 'exam'){
      state.history.exam.push({
        date: Date.now(), total, score, durationMs,
        details: state.session.answers.slice()
      });
      if (state.history.exam.length > 50) state.history.exam = state.history.exam.slice(-50);
    }

    save();
    renderKPIs();
  }

  function renderResultsPanel(){
    const res = $('#results'); if (!res) return;
    const kind = state.session.kind;
    const total = state.session.total || state.pool.length;
    const score = state.session.score;
    const durationMs = Date.now() - state.session.startedAt;

    const fmt = (ms) => {
      const m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000);
      return `${m} min ${String(s).padStart(2,'0')} s`;
    };

    let detailHTML = '';
    if (kind === 'exam'){
      const items = state.session.answers.map((a, i) => {
        const q = state.pool[i];
        const ok = a.ok ? 'ok' : 'ko';
        const your = (a.chosen != null) ? ABCD[a.chosen] : '—';
        const good = ABCD[a.correctIdx];
        const qShort = q.question.length > 110 ? q.question.slice(0,107)+'…' : q.question;
        return `<li class="res-item ${ok}">
          <span class="num">${i+1}.</span>
          <span class="q">${qShort}</span>
          <span class="ans">Ta réponse : <strong>${your}</strong> • Bonne : <strong>${good}</strong></span>
        </li>`;
      }).join('');
      detailHTML = `
        <h3>Détail des questions</h3>
        <ul class="res-list">${items}</ul>
      `;
    } else {
      detailHTML = `<p class="muted">Session terminée. Tu peux <button class="ghost" id="res-restart" type="button">Recommencer</button> pour générer un nouveau set.</p>`;
    }

    res.innerHTML = `
      <div class="card-header"><strong>Résultat de la session</strong></div>
      <p class="res-head">${(kind==='exam'?'Examen':'Entraînement')} — <strong>${score}/${total}</strong> en <strong>${fmt(durationMs)}</strong></p>
      ${detailHTML}
    `;
    res.classList.remove('hidden');

    // bouton recommencer (si présent)
    $('#res-restart')?.addEventListener('click', () => startSession(state.session.kind === 'review' ? 'review' : 'practice'));

    // retour automatique de l’onglet visuel sur "Entraînement" après un examen
    if (kind === 'exam'){
      $$('.seg').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
      const t = document.querySelector('.seg[data-mode="practice"]');
      if (t){ t.classList.add('active'); t.setAttribute('aria-selected','true'); }
    }
  }

  // ========= Chrono examen =========
  function tickExam(){
    if (state.session.kind !== 'exam') return;
    const elapsed = Math.floor((Date.now() - state.exam.startedAt) / 1000);
    const remain  = Math.max(0, state.exam.timer - elapsed);
    const mm = String(Math.floor(remain / 60)).padStart(2,'0');
    const ss = String(remain % 60).padStart(2,'0');
    const qNum = `${Math.min(state.index+1, state.pool.length)}/${state.pool.length}`;
    const st = $('#subtitle'); if (st) st.textContent = `Mode examen — ${mm}:${ss} — Question ${qNum}`;
    if (remain > 0) setTimeout(tickExam, 500);
    else {
      toast(`Temps écoulé`);
      finishSession();
    }
  }

  // ========= Reset & Reboot =========
  function resetProgress(){
    if (!confirm('Effacer TOUTE la progression (stats + historique) ?')) return;
    state.stats = { q:{}, days:{} };
    state.history = { practice:[], exam:[] };
    state.all.forEach(q => initItemStat(q.id, q.srcUrl, q.srcLabel));
    save();
    startSession('practice');
    renderKPIs();
    toast('Progression réinitialisée');
  }

  async function hardResetApp(){
    if (!confirm('Redémarrer complètement l’application (cache + progression) ?')) return;
    try {
      // 1) localStorage
      localStorage.removeItem(LS_KEY);
      // 2) caches SW
      if ('caches' in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      // 3) unregister service workers
      if ('serviceWorker' in navigator){
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch { /* ignore */ }
    location.reload();
  }

  // ========= Init =========
  async function init(){
    // Sous-titre (sources actives)
    const st = $('#subtitle'); if (st) st.textContent = SOURCES.map(s => s.label).join(' + ');

    restore();
    bindUI();

    try {
      await loadAll();
    } catch {
      toast('Erreur de chargement', true);
    }

    renderKPIs();
    startSession('practice');   // démarre une première session de 20 questions

    // Service worker
    if ('serviceWorker' in navigator){
      try { await navigator.serviceWorker.register('./sw.js'); }
      catch { /* ignore */ }
    }
  }

  // Expose quelques actions (debug)
  window.JulieQCM = {
    version: APP_VER,
    state, startSession, renderKPIs, renderQuestion
  };

  init();
})();