/* Julie la championne — Web App QCM (rev. 2025‑08‑13b)
   - Sessions : Entraînement (20), Examen (50, chrono), Révisions (20 ratées)
   - Historique persistant, UI claire, feedback conforme
   - Chemins relatifs (GitHub Pages)
*/

(() => {
  'use strict';

  // ========= Constantes & config =========
  const APP_VER = '4.1.0';
  const LS_KEY  = 'julie.v3.state';     // on garde la clé pour ne pas perdre la progression existante
  const DAY     = 24 * 60 * 60 * 1000;

  const SOURCES = [
    { id:'annales',  label:'Annales 2020–2024', url:'./data/annales_qcm_2020_2024_enrichi.json', enabled:true },
    { id:'actu24q4', label:'Actualités 2024Q4', url:'./data/qcm_actualites_2024Q4.json',          enabled:true }
  ];

  // ========= État global =========
  const state = {
    _ver: APP_VER,
    mode: 'practice', // practice | exam | review
    all: [],          // toutes les questions normalisées
    pool: [],         // sélection courante (session)
    index: 0,
    selection: new Set(SOURCES.map(s => s.url)), // sources cochées par défaut
    goalDaily: 20,
    exam: { total: 50, timer: 50*60, startedAt: 0 }, // 50 questions / 50 min
    stats: {
      // par qid: { attempts, correct, streak, easiness, interval, dueAt, lastAt, srcUrl, srcLabel }
      q: {},
      // par jour (YYYY-MM-DD): validations (tentatives comptées)
      days: {}
    },
    // session en cours
    session: {
      kind: 'practice', // practice | exam | review
      startedAt: 0,
      finishedAt: 0,
      answers: [],      // index choisi par question ou null
      revealed: [],     // bool par question (examen)
      score: 0,
      total: 0
    },
    history: {
      practice: [], // {ts, score, total, durationSec, sources[]}
      exam: []      // {ts, score, total, durationSec, sources[], items:[{qid, chosen, correct}]}
    },
    ui: { deferredPrompt: null },
    answered: false,   // question courante validée ?
    readyForNext: false // 1er clic “Suivante” = montrer explication ; 2e clic = avancer
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

  // Style toasts (utilise variables CSS)
  (function injectToastCSS(){
    const style = document.createElement('style');
    style.textContent = `
      .toast{position:fixed;left:50%;bottom:18px;transform:translate(-50%,20px);opacity:0;
        background:var(--panel);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:10px;
        box-shadow:0 8px 24px rgba(2,6,23,.12);transition:.2s;font-size:14px;z-index:9999}
      .toast.show{transform:translate(-50%,0);opacity:1}
      .toast.bad{border-color:#fecaca;color:#7f1d1d;background:#fee2e2}
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
    const q = wasCorrect ? 5 : 2;
    s.easiness = Math.max(1.3, s.easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    if (!wasCorrect){
      s.interval = 1; s.streak = 0;
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

  // ========= Normalisation datasets =========
  function safeAnswerIndex(raw){
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

  // { id, question, options[4], answerIndex, explanation, srcUrl, srcLabel, meta? }
  function normalizeDataset(json, src){
    const out = [];
    const { label: srcLabel, url: srcUrl, id: srcId } = src;

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

    list.forEach((raw, i) => {
      const qtext = pickFirstNonEmpty(
        raw.question, raw.q, raw.text, raw.prompt, raw.enonce, raw.enoncé, raw.title
      );
      const question = (qtext || '').toString().trim();
      if (!question) return;

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

  // ========= Chargement =========
  async function fetchJson(url){
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
      stats: state.stats,
      history: state.history
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
      }
    } catch { /* ignore */ }
  }

  // ========= Pool / file =========
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
    // Sources
    const box = $('#sources'); if (box) box.innerHTML = '';
    for (const src of SOURCES){
      const id = `src-${src.id}`;
      const label = document.createElement('label');
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
          startSession(state.mode); save();
        });
      }
    }

    // Modes
    $$('.seg').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.seg').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;
        state.mode = mode;
        startSession(mode); save();
      });
    });

    // Options
    ['opt-newOnly','opt-dueFirst','opt-shuffle'].forEach(id => {
      const el = $('#'+id);
      if (el) el.addEventListener('change', () => { startSession(state.mode); save(); });
    });

    // Objectif
    $('#goal-dec')?.addEventListener('click', () => setGoal(state.goalDaily - 1));
    $('#goal-inc')?.addEventListener('click', () => setGoal(state.goalDaily + 1));
    $('#goal-input')?.addEventListener('change', e => setGoal(+e.target.value || 1));
    if ($('#goal-input')) $('#goal-input').value = state.goalDaily;

    // Actions question
    $('#btn-reveal')?.addEventListener('click', reveal);
    $('#btn-next')?.addEventListener('click', onNext);
    $('#btn-restart')?.addEventListener('click', () => startSession(state.mode));

    // Résultats
    $('#btn-close-results')?.addEventListener('click', () => { $('#results')?.classList.add('hidden'); });

    // Reset progression (SRS + historique conservé)
    $('#btn-reset')?.addEventListener('click', resetProgress);

    // Hard reset (vraie remise à zéro app + cache SW)
    $('#btn-hard-reset')?.addEventListener('click', hardReset);

    // Raccourcis clavier
    document.addEventListener('keydown', (e) => {
      if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.code === 'Space'){ e.preventDefault(); validateOrRecord(); }
      else if (e.key === 'n' || e.key === 'N'){ onNext(); }
      else if (e.key === 'r' || e.key === 'R'){ reveal(); }
      else if ('1234ABCDabcd'.includes(e.key)){
        const idx = '1234ABCD'.indexOf(e.key.toUpperCase());
        if (idx >= 0 && idx < 4){
          const radios = $$('#q-choices input[type=radio]');
          if (radios[idx]){ radios[idx].checked = true; }
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
    ctx.globalAlpha = .25; ctx.strokeStyle = '#94a3b8';
    ctx.beginPath(); ctx.moveTo(32, H-24); ctx.lineTo(W-8, H-24); ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2;
    ctx.beginPath();
    days.forEach((v,i) => {
      const x = 32 + i * ((W - 48) / 13);
      const y = H - 24 - (H - 60) * (v / max);
      if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    days.forEach((v,i) => {
      const x = 32 + i * ((W - 48) / 13);
      const y = H - 24 - (H - 60) * (v / max);
      ctx.beginPath(); ctx.arc(x,y,2.2,0,Math.PI*2); ctx.fill();
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
    for (const [qid,s] of Object.entries(state.stats.q)){
      const key = s.srcLabel || 'Source';
      agg[key] ||= { attempts:0, correct:0 };
      agg[key].attempts += s.attempts || 0;
      agg[key].correct  += s.correct  || 0;
    }
    if (list){
      Object.entries(agg).forEach(([label,v]) => {
        const li = document.createElement('li');
        const pct = v.attempts ? Math.round(100*v.correct/v.attempts)+'%' : '—';
        li.innerHTML = `<span>${label}</span><span class="muted">${pct} • ${v.attempts} essais</span>`;
        list.appendChild(li);
      });
    }

    drawSpark();
  }

  function renderSessionBar(){
    const el = $('#sessionbar'); if (!el) return;
    const kind = state.session.kind;
    const idx = state.index + 1;
    const total = state.session.total || state.pool.length || 0;

    if (kind === 'exam'){
      // Chrono affiché
      const elapsed = Math.max(0, Math.floor((Date.now() - state.exam.startedAt)/1000));
      const remain  = Math.max(0, state.exam.timer - elapsed);
      const mm = String(Math.floor(remain / 60)).padStart(2,'0');
      const ss = String(remain % 60).padStart(2,'0');
      el.textContent = `Examen — ${idx}/${total} — ${mm}:${ss}`;
      el.classList.remove('hidden');
    } else if (kind === 'practice'){
      el.textContent = `Entraînement — score ${state.session.score}/${total} — ${idx}/${total}`;
      el.classList.remove('hidden');
    } else if (kind === 'review'){
      el.textContent = `Révisions — ${idx}/${total}`;
      el.classList.remove('hidden');
    }
  }

  function renderQuestion(){
    const q = state.pool[state.index];
    if (!q){
      $('#q-text') && ($('#q-text').textContent = 'Aucune question dans la sélection. Ajuste les filtres.');
      $('#q-choices') && ($('#q-choices').innerHTML = '');
      $('#q-feedback') && ($('#q-feedback').textContent = '');
      $('#q-tag') && ($('#q-tag').textContent = '—');
      $('#q-index') && ($('#q-index').textContent = '—');
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
    if (fb){ fb.className = 'feedback hidden'; fb.textContent = ''; }

    // boutons selon mode
    if (state.mode === 'exam'){ $('#btn-reveal')?.classList.remove('hidden'); }
    else { $('#btn-reveal')?.classList.add('hidden'); }

    $('#btn-next') && ($('#btn-next').textContent = 'Suivante ↵');

    state.answered = false;
    state.readyForNext = false;
    renderSessionBar();
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

  function bumpStats(q, ok){
    const s = initItemStat(q.id, q.srcUrl, q.srcLabel);
    s.attempts++; if (ok) s.correct++;
    scheduleNext(s, ok);
    const k = todayKey(); state.stats.days[k] = (state.stats.days[k] || 0) + 1;
  }

  function validateOrRecord(){
    // utilisé par barre d’espace
    if (state.mode === 'exam'){
      recordChoiceExam();
    } else {
      validateWithFeedback();
    }
  }

  function validateWithFeedback(){
    if (state.answered) return;
    const q = current(); if (!q) return;
    const radios = $$('#q-choices input[type=radio]');
    const idx = radios.findIndex(r => r.checked);
    if (idx < 0){ toast('Choisis une réponse'); return; }

    const ok = (idx === q.answerIndex);
    state.session.answers[state.index] = idx;
    state.session.score += ok ? 1 : 0;

    mark(q.answerIndex, idx);

    const fb = $('#q-feedback');
    if (fb){
      fb.classList.remove('hidden');
      fb.classList.toggle('bad', !ok);
      const sol = `Solution : ${ABCD[q.answerIndex]}.`;
      fb.textContent = ok
        ? '✅ Bonne réponse ! ' + (q.explanation ? q.explanation : '')
        : `❌ Mauvaise réponse. ${sol}${q.explanation ? ' ' + q.explanation : ''}`;
    }

    bumpStats(q, ok);
    state.answered = true;
    state.readyForNext = true;
    $('#btn-next') && ($('#btn-next').textContent = 'Question suivante →');
    renderSessionBar();
    save(); renderKPIs();
  }

  function recordChoiceExam(){
    const q = current(); if (!q) return;
    const radios = $$('#q-choices input[type=radio]');
    const idx = radios.findIndex(r => r.checked);
    if (idx < 0){ toast('Choisis une réponse'); return; }

    state.session.answers[state.index] = idx;
    // on met à jour le SRS/compteurs sans afficher la solution
    const ok = (idx === q.answerIndex);
    bumpStats(q, ok);

    // pas de feedback automatique
    nextQuestionOrFinish();
    save(); renderKPIs();
  }

  function reveal(){
    if (state.mode !== 'exam') return; // training/review affichent déjà au clic Suivante
    const q = current(); if (!q) return;
    mark(q.answerIndex, state.session.answers[state.index] ?? -1);
    const fb = $('#q-feedback');
    if (fb){
      fb.classList.remove('hidden'); fb.classList.remove('bad');
      fb.textContent = `Réponse : ${ABCD[q.answerIndex]}. ${q.explanation || ''}`.trim();
    }
    state.session.revealed[state.index] = true;
  }

  function onNext(){
    if (state.mode === 'exam'){
      // En examen : un clic = on enregistre si pas fait, sinon on passe
      const hasAnswer = Number.isInteger(state.session.answers[state.index]);
      if (!hasAnswer){ recordChoiceExam(); return; }
      nextQuestionOrFinish(); return;
    }

    // Entraînement / Révisions : 1er clic = feedback, 2e clic = question suivante
    if (!state.answered){ validateWithFeedback(); return; }
    nextQuestionOrFinish();
  }

  function nextQuestionOrFinish(){
    if (state.index < state.pool.length - 1){
      state.index++; renderQuestion();
    } else {
      finishSession();
    }
  }

  function startSession(mode){
    buildPool();

    const keep = new Set(state.selection);
    const items = state.all.filter(q => keep.has(q.srcUrl));

    let chosen = [];
    if (mode === 'practice'){
      chosen = shuffle(items).slice(0, 20);
    } else if (mode === 'review'){
      const missed = items.filter(q => {
        const s = state.stats.q[q.id];
        return s && s.attempts > 0 && s.correct < s.attempts; // déjà manquée
      });
      if (!missed.length){
        toast('Aucune question manquée. Basculé en Entraînement.');
        state.mode = 'practice';
        $$('.seg').forEach(b => b.classList.remove('active'));
        document.querySelector('.seg[data-mode="practice"]')?.classList.add('active');
        chosen = shuffle(items).slice(0, 20);
      } else {
        chosen = shuffle(missed).slice(0, Math.min(20, missed.length));
      }
    } else if (mode === 'exam'){
      chosen = shuffle(items).slice(0, Math.min(state.exam.total, items.length));
      state.exam.startedAt = Date.now();
      tickExam();
    }

    state.pool = chosen;
    state.index = 0;

    state.session = {
      kind: state.mode,
      startedAt: Date.now(),
      finishedAt: 0,
      answers: Array(chosen.length).fill(null),
      revealed: Array(chosen.length).fill(false),
      score: 0,
      total: chosen.length
    };

    $('#subtitle')?.textContent = SOURCES.map(s => s.label).join(' + ');
    $('#results')?.classList.add('hidden');
    renderQuestion();
    renderKPIs();
    renderHistory();
    save();
  }

  function tickExam(){
    if (state.mode !== 'exam') return;
    const elapsed = Math.floor((Date.now() - state.exam.startedAt) / 1000);
    const remain  = Math.max(0, state.exam.timer - elapsed);
    renderSessionBar();
    if (remain > 0) setTimeout(tickExam, 500);
    else finishSession(); // fin chrono
  }

  function finishSession(){
    const kind = state.session.kind;
    state.session.finishedAt = Date.now();
    const durationSec = Math.round((state.session.finishedAt - state.session.startedAt)/1000);
    const total = state.session.total || state.pool.length;

    // Calcul final (examen : on calcule le score ici pour fiabilité)
    let score = state.session.score;
    if (kind === 'exam'){
      score = state.pool.reduce((acc,q,i) => acc + ((state.session.answers[i] === q.answerIndex) ? 1 : 0), 0);
    }

    // Sauvegarde historique (pas pour review)
    const histItem = {
      ts: Date.now(),
      score, total,
      durationSec,
      sources: Array.from(state.selection)
    };
    if (kind === 'practice'){
      state.history.practice.unshift(histItem);
      state.history.practice = state.history.practice.slice(0, 50);
    } else if (kind === 'exam'){
      histItem.items = state.pool.map((q,i) => ({
        qid: q.id, chosen: state.session.answers[i], correct: q.answerIndex
      }));
      state.history.exam.unshift(histItem);
      state.history.exam = state.history.exam.slice(0, 50);
    }

    // Résumé / détails
    showResults(kind, score, total, durationSec);

    // Revenir au mode entraînement après un examen
    if (kind === 'exam'){
      state.mode = 'practice';
      $$('.seg').forEach(b => b.classList.remove('active'));
      document.querySelector('.seg[data-mode="practice"]')?.classList.add('active');
    }

    renderHistory();
    save();
  }

  function showResults(kind, score, total, durationSec){
    const secToMMSS = (s) => {
      const mm = String(Math.floor(s/60)).padStart(2,'0');
      const ss = String(s%60).padStart(2,'0');
      return `${mm}:${ss}`;
    };
    $('#results')?.classList.remove('hidden');
    $('#results-title') && ($('#results-title').textContent =
      kind === 'exam' ? 'Examen terminé' : (kind === 'practice' ? 'Entraînement terminé' : 'Révisions terminées')
    );
    const pct = total ? Math.round(100*score/total) : 0;
    $('#results-summary') && ($('#results-summary').textContent =
      (kind === 'review')
        ? `Durée ${secToMMSS(durationSec)} — ${total} question(s) révisée(s).`
        : `Score ${score}/${total} (${pct} %) — Durée ${secToMMSS(durationSec)}.`
    );

    const list = $('#results-list'); if (list) list.innerHTML = '';
    if (kind === 'exam' && list){
      state.pool.forEach((q,i) => {
        const chosen = state.session.answers[i];
        const ok = (chosen === q.answerIndex);
        const li = document.createElement('li');
        const chosenTxt = Number.isInteger(chosen) ? ABCD[chosen] : '—';
        li.innerHTML = `
          <div><span class="${ok?'ok':'ko'}">${ok?'✓':'✗'}</span> ${q.question}</div>
          <div class="muted">Votre réponse : ${chosenTxt} • Juste : ${ABCD[q.answerIndex]}</div>
        `;
        list.appendChild(li);
      });
    }
  }

  function renderHistory(){
    const el = $('#history-list'); if (!el) return;
    el.innerHTML = '';
    const items = [
      ...state.history.exam.map(x => ({...x, kind:'Examen'})),
      ...state.history.practice.map(x => ({...x, kind:'Entraînement'}))
    ].sort((a,b)=>b.ts-a.ts).slice(0,12);

    const secToMMSS = (s) => {
      const mm = String(Math.floor(s/60)).padStart(2,'0');
      const ss = String(s%60).padStart(2,'0');
      return `${mm}:${ss}`;
    };

    items.forEach(h => {
      const li = document.createElement('li');
      const date = new Date(h.ts).toLocaleString();
      const pct = h.total ? Math.round(100*h.score/h.total)+'%' : '—';
      li.innerHTML = `
        <span>${h.kind} • ${date}</span>
        <span class="muted">${h.score}/${h.total} (${pct}) • ${secToMMSS(h.durationSec)}</span>
      `;
      el.appendChild(li);
    });
  }

  // ========= Import/Export (caché dans l’UI) — conservé si besoin technique =========
  function exportProgress(){ /* retiré de l’UI */ }
  function importProgress(){ /* retiré de l’UI */ }

  function resetProgress(){
    if (!confirm('Effacer TOUTE la progression (SRS), mais conserver l’historique ?')) return;
    state.stats = { q:{}, days:{} };
    state.all.forEach(q => initItemStat(q.id, q.srcUrl, q.srcLabel));
    save(); startSession(state.mode); renderKPIs(); renderHistory();
    toast('Progression réinitialisée');
  }

  async function hardReset(){
    if (!confirm('Rebooter l’app (effacer progression + historique + cache) ?')) return;
    try { localStorage.removeItem(LS_KEY); } catch {}
    try {
      if ('caches' in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch {}
    location.reload();
  }

  // ========= Init =========
  async function init(){
    $('#subtitle')?.textContent = SOURCES.map(s => s.label).join(' + ');
    restore();
    bindUI();

    try { await loadAll(); }
    catch { toast('Erreur de chargement', true); }

    startSession('practice');   // par défaut on part sur entraînement (20)
    renderKPIs();

    // Service worker
    if ('serviceWorker' in navigator){
      try { await navigator.serviceWorker.register('./sw.js'); }
      catch { /* ignore */ }
    }
  }

  // Expose (debug)
  window.JulieQCM = {
    version: APP_VER,
    state, startSession, renderKPIs, renderQuestion
  };

  init();
})();
