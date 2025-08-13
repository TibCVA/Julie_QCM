/* Julie la championne — Web App QCM (rev. 2025‑08‑13)
   - Deux datasets JSON: Annales 2020–2024 (enrichi) + Actualités 2024Q4
   - Mobile-first, PWA, révisions espacées (SM‑2 light), stats, mode examen
   - Chemins relatifs (GitHub Pages)
*/

(() => {
  'use strict';

  // ========= Constantes & config =========
  const APP_VER = '4.0.0';
  const LS_KEY  = 'julie.v3.state';     // on conserve la clé pour garder la progression existante
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
    pool: [],         // sélection courante
    index: 0,
    selection: new Set(SOURCES.map(s => s.url)), // sources cochées par défaut
    goalDaily: 50,
    exam: { total: 40, timer: 40*60, startedAt: 0, score: 0 },
    stats: {
      // par qid: { attempts, correct, streak, easiness, interval, dueAt, lastAt, srcUrl, srcLabel }
      q: {},
      // par jour (YYYY-MM-DD): validations (tentatives comptées)
      days: {}
    },
    ui: { deferredPrompt: null },
    answered: false
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
        background:#0b1326;border:1px solid #1e293b;color:#e2e8f0;padding:10px 14px;border-radius:10px;
        box-shadow:0 8px 30px rgba(0,0,0,.4);transition:.2s;font-size:14px;z-index:9999}
      .toast.show{transform:translate(-50%,0);opacity:1}
      .toast.bad{border-color:#7f1d1d;color:#fecaca}
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
      // parfois stocké "B )" ou "C." → on prend le 1er char alpha
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
      // A) Texte de la question
      const qtext = pickFirstNonEmpty(
        raw.question, raw.q, raw.text, raw.prompt, raw.enonce, raw.enoncé, raw.title
      );
      const question = (qtext || '').toString().trim();
      if (!question) return;

      // B) Options : tableau ou objet {A,B,C,D} (ou variantes de clé)
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
        // autre format possible: {1:...,2:...,3:...,4:...}
        if (!options.length){
          const arr = [objChoices[1], objChoices[2], objChoices[3], objChoices[4]].map(x => (x ?? '').toString());
          if (arr.every(s => s.trim())) options = arr;
        }
      }
      if (options.length !== 4 || options.some(o => !o.trim())) return;

      // C) Index de la bonne réponse
      const ansRaw = pickFirstNonEmpty(
        raw.answer_index, raw.answerIndex, raw.correct_index, raw.correctIndex,
        raw.correct_idx, raw.correct, raw.bonne, raw.bonne_reponse, raw.bonneRéponse,
        raw.answer, raw.letter, raw.reponse, raw.réponse
      );
      const answerIndex = safeAnswerIndex(ansRaw);

      // D) Explication / justification / source éventuelle
      let explanation = pickFirstNonEmpty(
        raw.explanation, raw.explication, raw.justification, raw.comment, raw.solution, raw.correction, raw.answer_text, raw.detail
      );
      explanation = (explanation || '').toString();
      // Si l’item contient un lien/source, on l’ajoute à la fin proprement (sans HTML)
      const srcNote = pickFirstNonEmpty(raw.source, raw.lien, raw.url, raw.link);
      if (srcNote) explanation = explanation ? `${explanation} (source: ${srcNote})` : `source: ${srcNote}`;

      // E) ID stable
      const baseId = pickFirstNonEmpty(raw.id, raw.uid, raw.key, `${srcId}-${i}`);
      const id = `${srcId}::${baseId}`;

      // F) Méta facultative (année, thème, tags, etc.)
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
    // URL absolue pour iOS/Safari
    const abs = new URL(url, location.href).href;
    const res = await fetch(abs, { cache: 'no-store' });
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
      stats: state.stats
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
        state.goalDaily = obj.goalDaily || 50;
        state.stats     = obj.stats || { q:{}, days:{} };
        const def = SOURCES.map(s => s.url);
        state.selection = new Set(Array.isArray(obj.selection) ? obj.selection : def);
      }
    } catch { /* ignore */ }
  }

  // ========= Construction de la file (pool) =========
  function buildPool(){
    const keep = new Set(state.selection);
    const items = state.all.filter(q => keep.has(q.srcUrl));

    const dueFirst = $('#opt-dueFirst')?.checked;
    const newOnly  = $('#opt-newOnly')?.checked;
    const shuffleOn= $('#opt-shuffle')?.checked;

    const now = Date.now();
    const scored = items.map(q => {
      const s = state.stats.q[q.id] || {};
      const isNew = !(s.attempts > 0);
      const isDue = (s.dueAt || 0) <= now;
      let score = Math.random();
      if (dueFirst && isDue) score += 5;
      if (newOnly && isNew) score += 3;
      return { q, score };
    });

    let arr = scored.sort((a,b)=>b.score-a.score).map(x=>x.q);
    if (shuffleOn && !dueFirst && !newOnly) arr = shuffle(arr);

    state.pool = arr;
    state.index = 0;
  }

  // ========= Rendu UI =========
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
          if (e.target.checked) state.selection.add(src.url);
          else state.selection.delete(src.url);
          buildPool(); renderKPIs(); renderQuestion(); save();
        });
      }
    }

    // Segmented control (modes)
    $$('.seg').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.seg').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        pickQueue(state.mode);
        renderKPIs(); save();
      });
    });

    // Options
    ['opt-newOnly','opt-dueFirst','opt-shuffle'].forEach(id => {
      const el = $('#'+id);
      if (el) el.addEventListener('change', () => { buildPool(); renderQuestion(); save(); });
    });

    // Objectif quotidien
    $('#goal-dec')?.addEventListener('click', () => setGoal(state.goalDaily - 1));
    $('#goal-inc')?.addEventListener('click', () => setGoal(state.goalDaily + 1));
    $('#goal-input')?.addEventListener('change', e => setGoal(+e.target.value || 1));
    if ($('#goal-input')) $('#goal-input').value = state.goalDaily;

    // Actions
    $('#btn-reveal')?.addEventListener('click', reveal);
    $('#btn-next')?.addEventListener('click', next);
    $('#btn-reset')?.addEventListener('click', resetProgress);
    $('#btn-export')?.addEventListener('click', exportProgress);
    $('#btn-import')?.addEventListener('click', () => $('#import-file')?.click());
    $('#import-file')?.addEventListener('change', importProgress);

    // Raccourcis clavier
    document.addEventListener('keydown', (e) => {
      // éviter d'interférer avec un input texte
      if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.code === 'Space'){ e.preventDefault(); validate(); }
      else if (e.key === 'n' || e.key === 'N'){ next(); }
      else if (e.key === 'r' || e.key === 'R'){ reveal(); }
      else if ('1234ABCDabcd'.includes(e.key)){
        const idx = '1234ABCD'.indexOf(e.key.toUpperCase());
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
      const btn = $('#btn-install'); if (btn) btn.style.display = 'inline-flex';
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
    if ($('#goal-input')) $('#goal-input').value = state.goalDaily;
    renderKPIs(); save();
  }

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
    ctx.globalAlpha = .3; ctx.strokeStyle = '#3b82f6';
    ctx.beginPath(); ctx.moveTo(32, H-24); ctx.lineTo(W-8, H-24); ctx.stroke();
    ctx.globalAlpha = 1; ctx.beginPath();
    days.forEach((v,i) => {
      const x = 32 + i * ((W - 48) / 13);
      const y = H - 24 - (H - 60) * (v / max);
      if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    days.forEach((v,i) => {
      const x = 32 + i * ((W - 48) / 13);
      const y = H - 24 - (H - 60) * (v / max);
      ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill();
    });
  }

  function renderKPIs(){
    if ($('#kpi-total')) $('#kpi-total').textContent = state.all.length.toString();
    const due = Object.values(state.stats.q).filter(s => (s.dueAt || 0) <= Date.now()).length;
    if ($('#kpi-due')) $('#kpi-due').textContent = due.toString();

    const attempts = Object.values(state.stats.q).reduce((a,s)=>a+(s.attempts||0),0);
    const corrects = Object.values(state.stats.q).reduce((a,s)=>a+(s.correct||0),0);
    if ($('#kpi-accuracy')) $('#kpi-accuracy').textContent = attempts ? Math.round(100*corrects/attempts)+'%' : '—';

    const doneToday = state.stats.days[todayKey()] || 0;
    if ($('#kpi-goal')) $('#kpi-goal').textContent = `${doneToday}/${state.goalDaily}`;

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
  }

  function renderQuestion(){
    const q = state.pool[state.index];
    if (!q){
      if ($('#q-text'))    $('#q-text').textContent = 'Aucune question dans la sélection. Ajuste les filtres.';
      if ($('#q-choices')) $('#q-choices').innerHTML = '';
      if ($('#q-feedback'))$('#q-feedback').textContent = '';
      if ($('#q-tag'))     $('#q-tag').textContent = '—';
      if ($('#q-index'))   $('#q-index').textContent = '—';
      return;
    }

    $('#q-text')?.textContent   = q.question;
    $('#q-tag')?.textContent    = q.srcLabel;
    $('#q-index')?.textContent  = `${state.index + 1} / ${state.pool.length}`;

    const wrap = $('#q-choices'); if (wrap) wrap.innerHTML = '';
    q.options.forEach((opt, i) => {
      const lab = document.createElement('label');
      lab.className = 'choice';
      lab.innerHTML = `
        <input type="radio" name="choice">
        <span class="letter">${ABCD[i]}</span>
        <span>${opt}</span>
      `;
      wrap?.appendChild(lab);
    });

    const fb = $('#q-feedback');
    if (fb){ fb.className = 'feedback'; fb.textContent = ''; }
    state.answered = false;
  }

  function mark(correctIdx, chosenIdx){
    const nodes = $$('#q-choices .choice');
    nodes.forEach((n,i) => {
      n.classList.remove('correct','wrong');
      if (i === correctIdx) n.classList.add('correct');
      if (i === chosenIdx && chosenIdx !== correctIdx) n.classList.add('wrong');
    });
  }

  const current = () => state.pool[state.index];

  function validate(){
    if (state.answered) return;
    const q = current(); if (!q) return;

    const radios = $$('#q-choices input[type=radio]');
    const idx = radios.findIndex(r => r.checked);
    if (idx < 0){ toast('Choisis une réponse'); return; }

    const ok = (idx === q.answerIndex);
    mark(q.answerIndex, idx);

    const fb = $('#q-feedback');
    if (fb){
      fb.className = 'feedback ' + (ok ? '' : 'bad');
      const solutionTxt = `Solution : ${ABCD[q.answerIndex]}.`;
      fb.textContent = ok
        ? '✅ Bonne réponse !'
        : `${'❌ Mauvaise réponse. '}${solutionTxt}${q.explanation ? ' ' + q.explanation : ''}`.trim();
    }

    // SRS + stats
    const s = initItemStat(q.id, q.srcUrl, q.srcLabel);
    s.attempts++; if (ok) s.correct++;
    scheduleNext(s, ok);

    // progression du jour
    const k = todayKey(); state.stats.days[k] = (state.stats.days[k] || 0) + 1;

    // mode examen
    if (state.mode === 'exam'){ state.exam.score += ok ? 1 : 0; }

    state.answered = true;
    save(); renderKPIs();
  }

  function reveal(){
    const q = current(); if (!q) return;
    mark(q.answerIndex, -1);
    const fb = $('#q-feedback');
    if (fb){
      fb.className = 'feedback';
      fb.textContent = `Réponse : ${ABCD[q.answerIndex]}. ${q.explanation || ''}`.trim();
    }
  }

  function next(){
    // si rien n'est coché → on valide pour générer le feedback
    const anyChecked = $$('#q-choices input[type=radio]').some(r => r.checked);
    if (!anyChecked){ validate(); return; }

    if (state.index < state.pool.length - 1){
      state.index++; renderQuestion();
    } else {
      toast('Fin de la sélection');
    }
  }

  function pickQueue(mode){
    buildPool();

    if (mode === 'review'){
      const now = Date.now();
      state.pool = state.pool.filter(q => (state.stats.q[q.id]?.dueAt || 0) <= now);
      if (!state.pool.length){
        toast('Aucune carte due. Basculé en Entraînement.');
        state.mode = 'practice';
        $$('.seg').forEach(b => b.classList.remove('active'));
        document.querySelector('.seg[data-mode="practice"]')?.classList.add('active');
      }
    } else if (mode === 'exam'){
      const size = Math.min(state.exam.total, state.pool.length);
      state.pool = shuffle(state.pool).slice(0, size);
      state.exam.startedAt = Date.now();
      state.exam.score = 0;
      tickExam();
    }

    state.index = 0;
    renderQuestion();
  }

  function tickExam(){
    if (state.mode !== 'exam') return;
    const elapsed = Math.floor((Date.now() - state.exam.startedAt) / 1000);
    const remain  = Math.max(0, state.exam.timer - elapsed);
    const mm = String(Math.floor(remain / 60)).padStart(2,'0');
    const ss = String(remain % 60).padStart(2,'0');
    $('#subtitle')?.textContent = `Mode examen — ${mm}:${ss} — Score ${state.exam.score}/${state.pool.length}`;
    if (remain > 0) setTimeout(tickExam, 500);
    else {
      state.mode = 'practice';
      toast(`Examen terminé : ${state.exam.score}/${state.pool.length}`);
      $('#subtitle')?.textContent = SOURCES.map(s => s.label).join(' + ');
      $$('.seg').forEach(b => b.classList.remove('active'));
      document.querySelector('.seg[data-mode="practice"]')?.classList.add('active');
    }
  }

  // ========= Import / Export / Reset =========
  function exportProgress(){
    const payload = JSON.stringify({
      _ver: APP_VER,
      stats: state.stats,
      selection: Array.from(state.selection),
      goal: state.goalDaily
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'julie_progression.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function importProgress(evt){
    const f = evt.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (obj.stats)     state.stats = obj.stats;
        if (obj.selection) state.selection = new Set(obj.selection);
        if (obj.goal)      state.goalDaily = obj.goal;
        if ($('#goal-input')) $('#goal-input').value = state.goalDaily;
        save(); buildPool(); renderKPIs(); renderQuestion();
        toast('Import réussi');
      } catch { toast('Import invalide', true); }
    };
    reader.readAsText(f);
  }

  function resetProgress(){
    if (!confirm('Effacer TOUTE la progression ?')) return;
    state.stats = { q:{}, days:{} };
    state.all.forEach(q => initItemStat(q.id, q.srcUrl, q.srcLabel));
    save(); buildPool(); renderKPIs(); renderQuestion();
    toast('Progression réinitialisée');
  }

  // ========= Init =========
  async function init(){
    // Sous-titre (sources actives)
    $('#subtitle')?.textContent = SOURCES.map(s => s.label).join(' + ');

    restore();
    bindUI();

    try {
      await loadAll();
    } catch {
      toast('Erreur de chargement', true);
    }

    buildPool();
    renderKPIs();
    state.mode = 'practice';
    pickQueue('practice');   // ajuste la file + rend la 1re question

    // Service worker
    if ('serviceWorker' in navigator){
      try { await navigator.serviceWorker.register('./sw.js'); }
      catch { /* ignore */ }
    }
  }

  // Expose quelques actions (debug)
  window.JulieQCM = {
    version: APP_VER,
    state, pickQueue, renderKPIs, renderQuestion
  };

  init();
})();
