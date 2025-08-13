/* Julie la championne — Web App QCM (finale)
   Intègre 2 datasets JSON : Annales 2020-2024 + Actualités 2024Q4
   Mobile-first, PWA, révisions espacées, stats, mode examen.
*/

const SOURCES = [
  { url: 'data/annales_qcm_2020_2024_enrichi.json', label: 'Annales 2020–2024' },
  { url: 'data/qcm_actualites_2024Q4.json',        label: 'Actualités 2024Q4' }
];

const LS_KEY = 'julie.v2.state';
const DAY = 24*60*60*1000;

// ----- State -----
const state = {
  mode: 'practice', // practice | exam | review
  all: [],          // toutes les questions normalisées
  pool: [],         // file d'entraînement actuelle
  index: 0,         // index dans pool
  selection: new Set(SOURCES.map(s => s.url)), // sources cochées
  goalDaily: 50,
  exam: { total: 40, timer: 40*60, remaining: 0, startedAt: 0 },
  stats: {
    // par qid: { attempts, correct, streak, easiness, interval, dueAt, lastAt, source }
    q: {},
    // par jour (YYYY-MM-DD) : nb questions faites
    days: {}
  },
  ui: { deferredPrompt: null },
  answered: false    // empêche le double comptage sur la question courante
};

// ----- Utils -----
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmtPct = n => isNaN(n) ? '—' : (Math.round(n*100)+'%');
const todayKey = () => new Date().toISOString().slice(0,10);
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

// Révisions espacées (SM-2 "lite")
function initItemStat(id, source){
  const s = state.stats.q[id] || { attempts:0, correct:0, streak:0, easiness:2.5, interval:0, dueAt:0, lastAt:0, source };
  state.stats.q[id] = s; return s;
}
function scheduleNext(s, wasCorrect){
  const q = wasCorrect ? 5 : 2; // qualité
  s.easiness = Math.max(1.3, s.easiness + (0.1 - (5-q)*(0.08 + (5-q)*0.02)));
  if(!wasCorrect){ s.interval = 1; s.streak = 0; }
  else{
    s.streak++;
    if(s.streak === 1) s.interval = 1;
    else if(s.streak === 2) s.interval = 3;
    else s.interval = Math.round(s.interval * s.easiness);
  }
  s.dueAt = Date.now() + s.interval * DAY;
  s.lastAt = Date.now();
}

// ----- Normalisation -----
function safeAnswerIndex(raw){
  if(typeof raw === 'number'){
    // accepte 0..3 ou 1..4
    if(raw >= 0 && raw <= 3) return raw;
    if(raw >= 1 && raw <= 4) return raw-1;
  }
  return 0;
}

// datasetJson: objet JSON ; sourceLabel: "Annales 2020–2024" / "Actualités 2024Q4"
function normalizeDataset(datasetJson, sourceLabel){
  const theme = datasetJson.title || datasetJson.id || sourceLabel || 'Questions';
  const rawList = Array.isArray(datasetJson.questions) ? datasetJson.questions : [];
  const items = [];

  rawList.forEach((raw, idx) => {
    // options
    let options = [];
    if(raw?.choices){
      const c = raw.choices;
      options = [c.A, c.B, c.C, c.D];
    }else if(Array.isArray(raw?.options)){
      options = raw.options.slice(0,4);
    }
    // vérif stricte : 4 options requises
    if(!options || options.length !== 4 || options.some(o => typeof o !== 'string' || !o.trim())){
      console.warn('Question ignorée (options invalides)', raw?.id ?? idx, sourceLabel);
      return; // skip
    }

    // index de réponse
    let answerIndex = 0;
    if(typeof raw.answer === 'string'){
      answerIndex = ({A:0,B:1,C:2,D:3}[raw.answer.trim().toUpperCase()] ?? 0);
    }else{
      answerIndex = safeAnswerIndex(raw.answer_index);
    }

    // ID stable et unique
    const baseId = (raw.id ?? `${theme}-${idx}`)+'';
    const id = `${sourceLabel}::${baseId}`; // prefixe de source pour unicité cross-datasets

    items.push({
      id,
      question: raw.question || raw.q || '',
      options,
      answerIndex,
      explanation: raw.answer_text || raw.explanation || '',
      source: sourceLabel // on force l'étiquette affichée = label du jeu
    });
  });

  return items;
}

// ----- Chargement -----
async function loadAll(){
  const results = [];
  for(const s of SOURCES){
    try{
      const res = await fetch(s.url, {cache:'no-store'});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = normalizeDataset(json, s.label);
      list.forEach(q => initItemStat(q.id, s.label));
      results.push(...list);
    }catch(e){
      toast(`Erreur de chargement: ${s.label} — ${e.message}`, true);
    }
  }
  state.all = results;
  save();
}

// ----- Persistance -----
function save(){ localStorage.setItem(LS_KEY, JSON.stringify({ state })); }
function restore(){
  const raw = localStorage.getItem(LS_KEY);
  if(!raw) return;
  try{
    const obj = JSON.parse(raw);
    if(obj?.state){
      Object.assign(state, obj.state);
      state.selection = new Set(Array.from(state.selection || []));
    }
  }catch{ /* ignore */ }
}

// ----- File d'entraînement -----
function buildPool(){
  const allowed = new Set(state.selection);
  const items = state.all.filter(q => {
    const st = state.stats.q[q.id];
    const srcLabel = st?.source || q.source;
    const sourceObj = SOURCES.find(x => x.label === srcLabel);
    if(!sourceObj) return false;
    return allowed.has(sourceObj.url);
  });

  const dueFirst = $('#opt-dueFirst').checked;
  const newOnly  = $('#opt-newOnly').checked;
  const shuffleOn= $('#opt-shuffle').checked;

  const now = Date.now();
  const tagged = items.map(q=>{
    const s = state.stats.q[q.id] || {};
    const isNew = !s.attempts;
    const isDue = (s.dueAt||0) <= now;
    let score = 0;
    if(dueFirst && isDue) score += 3;
    if(newOnly && isNew) score += 2;
    score += Math.random();
    return {q, isNew, isDue, score};
  });

  let sorted = tagged.sort((a,b)=>b.score - a.score).map(x=>x.q);
  if(shuffleOn && !dueFirst && !newOnly) sorted = shuffle(sorted);
  state.pool = sorted;
  state.index = 0;
}

// ----- UI Bindings -----
function bindUI(){
  // sources
  const box = $('#sources'); box.innerHTML = '';
  for(const s of SOURCES){
    const id = 'src-' + btoa(s.url).slice(0,8);
    const wrap = document.createElement('label');
    wrap.className = 'src';
    wrap.innerHTML = `<input type="checkbox" id="${id}" ${state.selection.has(s.url)?'checked':''}>
      <span>${s.label}</span>`;
    box.appendChild(wrap);
    $('#'+id).addEventListener('change', (e)=>{
      if(e.target.checked) state.selection.add(s.url);
      else state.selection.delete(s.url);
      buildPool(); renderKPIs(); save(); renderQuestion();
    });
  }

  // segmented
  $$('.seg').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.seg').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      pickQueue(state.mode);
      renderKPIs(); save();
    });
  });

  // goal
  $('#goal-dec').onclick = ()=>{ setGoal(state.goalDaily-1); };
  $('#goal-inc').onclick = ()=>{ setGoal(state.goalDaily+1); };
  $('#goal-input').addEventListener('change', e => setGoal(+e.target.value || 1) );

  // options
  ['opt-newOnly','opt-dueFirst','opt-shuffle'].forEach(id=>{
    $('#'+id).addEventListener('change', ()=>{ buildPool(); save(); renderQuestion(); });
  });

  // actions
  $('#btn-reveal').onclick = reveal;
  $('#btn-next').onclick = next;
  $('#btn-reset').onclick = resetProgress;
  $('#btn-export').onclick = exportProgress;
  $('#btn-import').onclick = ()=>$('#import-file').click();
  $('#import-file').addEventListener('change', importProgress);

  // keyboard
  document.addEventListener('keydown', (e)=>{
    if(e.code === 'Space'){ e.preventDefault(); validate(); }
    else if(e.key==='n' || e.key==='N'){ next(); }
    else if(e.key==='r' || e.key==='R'){ reveal(); }
    else if(['1','2','3','4','a','b','c','d','A','B','C','D'].includes(e.key)){
      const idx = '1234ABCD'.indexOf(e.key.toUpperCase());
      if(idx>=0 && idx<4){
        const radios = $$('#q-choices input[type=radio]');
        if(radios[idx]){ radios[idx].checked = true; validate(); }
      }
    }
  });

  // install prompt
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    state.ui.deferredPrompt = e;
    $('#btn-install').style.display = 'inline-flex';
  });
  $('#btn-install').onclick = async ()=>{
    if(state.ui.deferredPrompt){ state.ui.deferredPrompt.prompt(); }
  };

  // settings
  $('#btn-settings').onclick = ()=>{
    const v = prompt('Objectif quotidien (questions / jour)', state.goalDaily);
    if(v){ setGoal(clamp(+v,1,500)); }
  };
}

function setGoal(n){
  state.goalDaily = clamp(n,1,500);
  $('#goal-input').value = state.goalDaily;
  renderKPIs(); save();
}

// ----- Rendu -----
function renderKPIs(){
  $('#kpi-total').textContent = state.all.length;
  const due = Object.values(state.stats.q).filter(s => (s.dueAt||0) <= Date.now()).length;
  $('#kpi-due').textContent = due;

  const attempts = Object.values(state.stats.q).reduce((a,b)=>a+(b.attempts||0),0);
  const corrects = Object.values(state.stats.q).reduce((a,b)=>a+(b.correct||0),0);
  $('#kpi-accuracy').textContent = attempts ? Math.round(100*corrects/attempts)+'%' : '—';

  const doneToday = state.stats.days[todayKey()] || 0;
  $('#kpi-goal').textContent = `${doneToday}/${state.goalDaily}`;

  // per source list
  const list = $('#by-source'); list.innerHTML='';
  const bySrc = {};
  for(const [id,s] of Object.entries(state.stats.q)){
    const src = s.source || 'Source';
    bySrc[src] = bySrc[src] || { attempts:0, correct:0 };
    bySrc[src].attempts += s.attempts||0;
    bySrc[src].correct  += s.correct||0;
  }
  for(const [src, v] of Object.entries(bySrc)){
    const li = document.createElement('li');
    const pct = v.attempts?Math.round(100*v.correct/v.attempts)+'%':'—';
    li.innerHTML = `<span>${src}</span><span class="muted">${pct} • ${v.attempts} essais</span>`;
    list.appendChild(li);
  }

  // sparkline
  drawSpark();
}

function drawSpark(){
  const el = $('#spark');
  if(!el) return;
  const ctx = el.getContext && el.getContext('2d');
  if(!ctx) return;
  ctx.clearRect(0,0,el.width, el.height);
  // dernières 14 journées
  const days = [];
  for(let i=13;i>=0;i--){
    const d = new Date(Date.now()-i*DAY).toISOString().slice(0,10);
    days.push(state.stats.days[d]||0);
  }
  const W = el.width, H = el.height;
  const max = Math.max(1, ...days);
  ctx.globalAlpha = .3;
  ctx.strokeStyle = '#3b82f6';
  ctx.beginPath(); ctx.moveTo(32,H-24); ctx.lineTo(W-8,H-24); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  days.forEach((v,i)=>{
    const x = 32 + i*((W-48)/13);
    const y = H-24 - (H-60)*(v/max);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
  days.forEach((v,i)=>{
    const x = 32 + i*((W-48)/13);
    const y = H-24 - (H-60)*(v/max);
    ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI*2); ctx.fill();
  });
}

function renderQuestion(){
  if(!state.pool.length){
    $('#q-text').textContent = 'Aucune question dans la sélection. Ajuste les filtres.';
    $('#q-choices').innerHTML = ''; $('#q-feedback').textContent = '';
    $('#q-tag').textContent = '—'; $('#q-index').textContent = '—';
    return;
  }
  const q = state.pool[state.index];
  $('#q-text').textContent = q.question;
  $('#q-tag').textContent = q.source;
  $('#q-index').textContent = `${state.index+1} / ${state.pool.length}`;

  const wrap = $('#q-choices'); wrap.innerHTML = '';
  q.options.forEach((opt,i)=>{
    const id = `c-${i}`;
    const div = document.createElement('label'); div.className='choice';
    div.innerHTML = `
      <input type="radio" name="choice" id="${id}">
      <span class="letter">${'ABCD'[i]}</span>
      <span>${opt}</span>
    `;
    wrap.appendChild(div);
  });
  $('#q-feedback').textContent = '';
  state.answered = false; // reset anti double-comptage
}

function mark(correctIdx, chosenIdx){
  const nodes = $$('#q-choices .choice');
  nodes.forEach((n,i)=>{
    n.classList.remove('correct','wrong');
    if(i===correctIdx) n.classList.add('correct');
    if(i===chosenIdx && chosenIdx!==correctIdx) n.classList.add('wrong');
  });
}

function toast(msg, bad=false){
  const el = document.createElement('div');
  el.className = 'toast'+(bad?' bad':'');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>{ el.classList.add('show'); }, 20);
  setTimeout(()=>{ el.classList.remove('show'); el.remove(); }, 2600);
}

// style toast
const style = document.createElement('style');
style.textContent = `
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(20px);opacity:0;
  background:#0b1326;border:1px solid #1e293b;color:#e2e8f0;padding:10px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);transition:.2s}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.toast.bad{border-color:#7f1d1d;color:#fecaca}
`; document.head.appendChild(style);

// ----- Mécanique QCM -----
function current(){ return state.pool[state.index]; }

function validate(){
  if(state.answered) return; // anti double-compte
  const q = current(); if(!q) return;
  const radios = $$('#q-choices input[type=radio]');
  const idx = radios.findIndex(r => r.checked);
  if(idx<0){ toast('Choisis une réponse'); return; }

  const ok = (idx === q.answerIndex);
  mark(q.answerIndex, idx);
  const fb = $('#q-feedback');
  fb.className = 'feedback ' + (ok?'':'bad');
  fb.textContent = ok ? '✅ Bonne réponse !' : `❌ Mauvaise réponse. Solution : ${'ABCD'[q.answerIndex]}. ${q.explanation || ''}`;

  // stats + planification (une seule fois)
  const s = initItemStat(q.id, q.source);
  s.attempts++; if(ok) s.correct++;
  scheduleNext(s, ok);

  // progression du jour
  const k = todayKey(); state.stats.days[k] = (state.stats.days[k]||0) + 1;

  // mode examen : score
  if(state.mode==='exam'){ state.exam.score = (state.exam.score||0) + (ok?1:0); }

  state.answered = true;
  save(); renderKPIs();
}

function reveal(){
  const q = current(); if(!q) return;
  mark(q.answerIndex, -1);
  $('#q-feedback').className='feedback';
  $('#q-feedback').textContent = `Réponse : ${'ABCD'[q.answerIndex]}. ${q.explanation || ''}`;
}

function next(){
  // si rien n'a été coché, valider automatiquement pour forcer feedback
  const radios = $$('#q-choices input[type=radio]');
  const any = radios.some(r=>r.checked);
  if(!any){ validate(); return; }

  if(state.index < state.pool.length-1){ state.index++; renderQuestion(); }
  else{ toast('Fin de la sélection'); }
}

function pickQueue(mode){
  buildPool();
  if(mode === 'review'){
    const now = Date.now();
    state.pool = state.pool.filter(q => (state.stats.q[q.id]?.dueAt||0) <= now);
    if(!state.pool.length) toast('Aucune carte due. Basculé en Entraînement.');
  }else if(mode === 'exam'){
    const size = Math.min(state.exam.total, state.pool.length);
    state.pool = shuffle(state.pool).slice(0,size);
    state.exam.remaining = state.exam.timer;
    state.exam.startedAt = Date.now();
    state.exam.score = 0;
    tickExam();
  }
  state.index = 0;
  renderQuestion();
}

function tickExam(){
  if(state.mode!=='exam') return;
  const now = Date.now();
  const elapsed = Math.floor((now - state.exam.startedAt)/1000);
  const remain = Math.max(0, state.exam.timer - elapsed);
  const mm = String(Math.floor(remain/60)).padStart(2,'0');
  const ss = String(remain%60).padStart(2,'0');
  $('#subtitle').textContent = `Mode examen — ${mm}:${ss} — Score ${state.exam.score||0}/${state.pool.length}`;
  if(remain>0) setTimeout(tickExam, 500);
  else{
    state.mode='practice';
    toast(`Examen terminé : ${state.exam.score}/${state.pool.length}`);
    $('#subtitle').textContent = 'Annales 2020–2024 + Actualités 2024Q4';
    $$('.seg').forEach(b=>b.classList.remove('active'));
    $$('.seg')[0].classList.add('active');
  }
}

// ----- Import/Export -----
function exportProgress(){
  const data = JSON.stringify({ stats: state.stats, selection: Array.from(state.selection), goal: state.goalDaily }, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'julie_progression.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function importProgress(evt){
  const f = evt.target.files[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = ()=> {
    try{
      const obj = JSON.parse(reader.result);
      if(obj.stats){ state.stats = obj.stats; }
      if(obj.selection){ state.selection = new Set(obj.selection); }
      if(obj.goal){ state.goalDaily = obj.goal; $('#goal-input').value = state.goalDaily; }
      save(); buildPool(); renderKPIs(); renderQuestion();
      toast('Import réussi');
    }catch(e){ toast('Import invalide', true); }
  };
  reader.readAsText(f);
}

// ----- Reset -----
function resetProgress(){
  if(!confirm('Effacer TOUTE la progression ?')) return;
  state.stats = { q:{}, days:{} };
  state.all.forEach(q => initItemStat(q.id, q.source));
  save(); buildPool(); renderKPIs(); renderQuestion();
  toast('Progression réinitialisée');
}

// ----- Init -----
async function init(){
  restore();
  bindUI();
  try{
    await loadAll();
  }catch(e){ toast('Erreur de chargement', true); }
  buildPool();
  renderKPIs();
  state.mode='practice';
  pickQueue('practice');
  renderQuestion();

  // SW
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('./sw.js'); }
}

init();
