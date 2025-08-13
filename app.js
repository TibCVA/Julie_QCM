/* ===========================================================
   Entraînement QCM — logique complète (réécrite et corrigée)
   Correctifs inclus :
   1) Bouton "Question suivante" grisé/disabled à la dernière question
   2) Mode sombre : texte des encadrés rouge/vert forcé en noir
   3) Encadré de progression centré et placé au-dessus du Q/R
   4) Historique dédoublonné (ID unique + sauvegarde une seule fois)
   =========================================================== */

(() => {
  // ---------- Sélecteurs ----------
  const el = {
    fileInput: document.getElementById('fileInput'),
    datasetInfo: document.getElementById('datasetInfo'),
    themeSwitch: document.getElementById('themeSwitch'),

    configCard: document.getElementById('configCard'),
    startBtn: document.getElementById('startBtn'),
    configHint: document.getElementById('configHint'),

    statusBox: document.getElementById('statusBox'),
    statusQuestionIdx: document.getElementById('statusQuestionIdx'),
    statusTotal: document.getElementById('statusTotal'),
    statusScore: document.getElementById('statusScore'),
    statusScoreTotal: document.getElementById('statusScoreTotal'),

    qaCard: document.getElementById('qaCard'),
    questionText: document.getElementById('questionText'),
    choices: document.getElementById('choices'),
    feedback: document.getElementById('feedback'),
    nextBtn: document.getElementById('nextBtn'),

    endCard: document.getElementById('endCard'),
    finalScore: document.getElementById('finalScore'),
    finalTotal: document.getElementById('finalTotal'),
    restartBtn: document.getElementById('restartBtn'),
    newSessionBtn: document.getElementById('newSessionBtn'),

    historyCard: document.getElementById('historyCard'),
    historyList: document.getElementById('historyList'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  };

  // ---------- Dataset de démo (pour tester l’UI) ----------
  // Pour faire des sessions 20/50, importez votre vrai fichier .json (même format qu’avant).
  let DATASET = {
    id: 'DEMO',
    title: 'Démo',
    questions: [
      {
        question: "Quelle balise HTML définit un lien hypertexte ?",
        choices: { A: "<a>", B: "<link>", C: "<href>", D: "<url>" },
        answer: "A",
        answer_text: "La balise <a> crée un hyperlien."
      },
      {
        question: "Que renvoie `Array.isArray([])` en JavaScript ?",
        choices: { A: "null", B: "false", C: "true", D: "undefined" },
        answer: "C",
        answer_text: "La méthode renvoie true si l’argument est un tableau."
      },
      {
        question: "Quelle propriété CSS arrondit les angles d’un élément ?",
        choices: { A: "border", B: "border-radius", C: "outline", D: "corner" },
        answer: "B",
        answer_text: "C’est border-radius qui arrondit les coins."
      },
      {
        question: "Quelle méthode JSON convertit un objet en chaîne ?",
        choices: { A: "JSON.parse", B: "JSON.stringify", C: "toString", D: "valueOf" },
        answer: "B",
        answer_text: "JSON.stringify(object) → chaîne JSON."
      },
      {
        question: "Quel est l’opérateur d’égalité stricte en JS ?",
        choices: { A: "==", B: "===", C: "=", D: "=>"},
        answer: "B",
        answer_text: "=== compare valeur + type."
      },
      {
        question: "Quelle est la valeur initiale de `display` pour un <div> ?",
        choices: { A: "inline", B: "inline-block", C: "block", D: "flex" },
        answer: "C",
        answer_text: "Par défaut un <div> est en display: block."
      },
      {
        question: "Quel événement DOM se déclenche sur un clic ?",
        choices: { A: "hover", B: "click", C: "input", D: "focus" },
        answer: "B",
        answer_text: "L’événement est 'click'."
      },
      {
        question: "En CSS, `em` est relatif à…",
        choices: { A: "la racine", B: "la viewport", C: "la taille de police du parent", D: "1px" },
        answer: "C",
        answer_text: "1em = taille de police de l’élément parent."
      },
      {
        question: "Quel type renvoie `typeof null` en JS ?",
        choices: { A: "'null'", B: "'object'", C: "'undefined'", D: "'number'" },
        answer: "B",
        answer_text: "Historiquement, typeof null === 'object'."
      },
      {
        question: "Quelle méthode ajoute un élément à la fin d’un tableau ?",
        choices: { A: "push", B: "pop", C: "shift", D: "unshift" },
        answer: "A",
        answer_text: "push() ajoute en fin de tableau."
      }
    ]
  };

  // ---------- État de session ----------
  let session = null;

  // Lecture préférences (thème)
  initTheme();

  // Init affichage dataset
  updateDatasetInfo();

  // ---------- Écouteurs ----------
  el.fileInput.addEventListener('change', onImportFile, false);
  el.startBtn.addEventListener('click', startSession, false);
  el.nextBtn.addEventListener('click', onNext, false);
  el.restartBtn.addEventListener('click', restartSameSet, false);
  el.newSessionBtn.addEventListener('click', resetToConfig, false);
  el.clearHistoryBtn.addEventListener('click', clearHistory, false);

  // Charger l'historique au démarrage
  renderHistory();

  // Thème
  el.themeSwitch.addEventListener('change', () => {
    const mode = el.themeSwitch.checked ? 'dark' : 'light';
    applyTheme(mode);
  });

  // ---------- Fonctions Thème ----------
  function initTheme() {
    const saved = localStorage.getItem('quiz.theme') || 'light';
    applyTheme(saved);
    el.themeSwitch.checked = saved === 'dark';
  }
  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem('quiz.theme', mode);
  }

  // ---------- Import de dataset ----------
  function onImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        validateAndSetDataset(data);
        updateDatasetInfo();
        el.configHint.textContent = "Fichier chargé avec succès.";
      } catch (err) {
        console.error(err);
        el.configHint.textContent = "Le fichier n’est pas un JSON valide au format attendu.";
      }
    };
    reader.readAsText(file, 'utf-8');
    // Reset input value to allow re-importing same file later
    e.target.value = '';
  }

  function validateAndSetDataset(data) {
    // Format attendu : { id?: string, title?: string, questions: [ {question, choices: {A,B,C,D}, answer, answer_text? } ] }
    if (!data || !Array.isArray(data.questions)) {
      throw new Error('Format de dataset invalide');
    }
    // Nettoyage minimal
    const cleaned = data.questions
      .filter(q => q && q.question && q.choices && q.answer && q.choices[q.answer])
      .map(q => ({
        question: String(q.question),
        choices: q.choices,
        answer: String(q.answer).trim().toUpperCase(),
        answer_text: q.answer_text ? String(q.answer_text) : ''
      }));

    DATASET = {
      id: data.id || 'CUSTOM',
      title: data.title || 'Questions',
      questions: cleaned
    };
  }

  function updateDatasetInfo() {
    const n = DATASET.questions.length;
    el.datasetInfo.textContent = `Dataset : ${DATASET.title} (${n} question${n>1?'s':''})`;
  }

  // ---------- Démarrage de session ----------
  function startSession() {
    const seriesSize = getSeriesSize();
    const available = DATASET.questions.length;

    // Vérifications : il faut >= série demandée
    if (available < seriesSize) {
      el.configHint.innerHTML = `Le dataset contient <strong>${available}</strong> question${available>1?'s':''}. Importez un fichier comportant au moins <strong>${seriesSize}</strong> questions.`;
      return;
    }

    const picked = pickRandom(DATASET.questions, seriesSize);
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

    session = {
      id,
      title: DATASET.title,
      total: seriesSize,
      startedAt: Date.now(),
      endedAt: null,
      index: 0,
      score: 0,
      saved: false, // garde-fou contre double enregistrement
      items: picked
    };

    // UI
    el.configCard.hidden = true;
    el.endCard.hidden = true;
    el.qaCard.hidden = false;
    el.statusBox.hidden = false;

    renderQuestion();
    updateStatusBox();
    el.feedback.textContent = '';
  }

  function getSeriesSize() {
    const checked = document.querySelector('input[name="seriesSize"]:checked');
    return Number(checked?.value || 20);
  }

  // ---------- Rendu question ----------
  function renderQuestion() {
    const q = session.items[session.index];
    el.questionText.textContent = q.question;

    // Réponses (A..D)
    el.choices.replaceChildren();
    const order = Object.keys(q.choices);
    order.forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.type = 'button';
      btn.dataset.key = key;

      // sous-éléments
      const k = document.createElement('span'); k.className = 'choice-key'; k.textContent = key;
      const lbl = document.createElement('span'); lbl.className = 'choice-label'; lbl.textContent = q.choices[key];

      btn.append(k, lbl);

      btn.addEventListener('click', () => onChoose(key, btn), { once: true });
      el.choices.appendChild(btn);
    });

    // Réinitialiser feedback + état du bouton suivant
    el.feedback.className = 'feedback';
    el.feedback.textContent = '';
    el.nextBtn.disabled = true;
    el.nextBtn.classList.remove('disabled');
    el.nextBtn.textContent = 'Question suivante';
  }

  // ---------- Sélection d'une réponse ----------
  function onChoose(chosenKey, chosenBtn) {
    const q = session.items[session.index];
    const correctKey = q.answer;

    // Désactiver tous les boutons et appliquer les classes
    const btns = [...el.choices.querySelectorAll('.choice-btn')];
    btns.forEach(b => b.disabled = true);

    if (chosenKey === correctKey) {
      chosenBtn.classList.add('correct');
      session.score += 1;

      el.feedback.className = 'feedback good';
      el.feedback.innerHTML = `✅ Bonne réponse.<span class="small">${q.answer_text || ''}</span>`;
    } else {
      chosenBtn.classList.add('incorrect');
      const correctBtn = btns.find(b => b.dataset.key === correctKey);
      if (correctBtn) correctBtn.classList.add('correct');

      el.feedback.className = 'feedback bad';
      const right = `${correctKey}: ${q.choices[correctKey]}`;
      el.feedback.innerHTML = `❌ Mauvaise réponse. La bonne réponse était <strong>${right}</strong>.<span class="small">${q.answer_text || ''}</span>`;
    }

    updateStatusBox();

    // Gérer le bouton "Question suivante"
    const isLast = session.index === session.total - 1;
    if (isLast) {
      // Exigence 1 : griser/désactiver à la fin
      el.nextBtn.disabled = true;
      el.nextBtn.classList.add('disabled');
      el.nextBtn.setAttribute('aria-disabled', 'true');
      el.nextBtn.textContent = 'Fin de la série';

      // Finaliser et sauvegarder UNE SEULE FOIS
      finalizeSessionOnce();
    } else {
      el.nextBtn.disabled = false;
      el.nextBtn.classList.remove('disabled');
      el.nextBtn.removeAttribute('aria-disabled');
      el.nextBtn.textContent = 'Question suivante';
    }
  }

  // ---------- Suivante ----------
  function onNext() {
    if (!session) return;
    if (session.index >= session.total - 1) return; // sécurité

    session.index += 1;
    renderQuestion();
    updateStatusBox();
  }

  // ---------- Redémarrer / Nouvelle session ----------
  function restartSameSet() {
    if (!session) return;
    // Relancer avec le même set de questions (même ordre)
    const prev = structuredClone(session.items);
    const size = session.total;

    session = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      title: DATASET.title,
      total: size,
      startedAt: Date.now(),
      endedAt: null,
      index: 0,
      score: 0,
      saved: false,
      items: prev
    };

    el.endCard.hidden = true;
    el.qaCard.hidden = false;
    el.statusBox.hidden = false;

    renderQuestion();
    updateStatusBox();
  }

  function resetToConfig() {
    el.qaCard.hidden = true;
    el.endCard.hidden = true;
    el.statusBox.hidden = true;
    el.configCard.hidden = false;
    session = null;
  }

  // ---------- Status box ----------
  function updateStatusBox() {
    if (!session) return;
    el.statusQuestionIdx.textContent = (session.index + 1).toString();
    el.statusTotal.textContent = session.total.toString();
    el.statusScore.textContent = session.score.toString();
    // score total = nombre déjà vus (index+1) tant que la série n’est pas finie, sinon total
    const answered = Math.min(session.index + 1, session.total);
    el.statusScoreTotal.textContent = answered.toString();
  }

  // ---------- Finalisation + Historique (anti-doublons) ----------
  function finalizeSessionOnce() {
    if (!session || session.saved) return; // évite double sauvegarde
    session.endedAt = Date.now();
    session.saved = true;

    // Sauvegarde locale
    const key = 'quiz.sessions.v2';
    const list = loadSessions();
    // Ne pas pousser si un ID identique existe déjà
    if (!list.some(s => s.id === session.id)) {
      list.push({
        id: session.id,
        title: session.title,
        total: session.total,
        score: session.score,
        startedAt: session.startedAt,
        endedAt: session.endedAt
      });
      localStorage.setItem(key, JSON.stringify(list));
    }

    // Afficher résumé
    el.finalScore.textContent = session.score.toString();
    el.finalTotal.textContent = session.total.toString();
    el.endCard.hidden = false;

    // On laisse le bloc Q/R affiché avec le bouton grisé (exigence 1)
    // Mise à jour historique
    renderHistory();
  }

  function loadSessions() {
    const raw = localStorage.getItem('quiz.sessions.v2');
    try {
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function renderHistory() {
    const list = loadSessions();

    // Dédoublonnage sûr (exigence 4) — Map par ID
    const uniq = [];
    const seen = new Map();
    for (const s of list) {
      if (!s || !s.id) continue;
      if (seen.has(s.id)) continue;
      seen.set(s.id, true);
      uniq.push(s);
    }

    // Si l’ancien stockage contenait des doublons, on réécrit la liste nettoyée.
    localStorage.setItem('quiz.sessions.v2', JSON.stringify(uniq));

    el.historyList.replaceChildren();
    if (uniq.length === 0) {
      el.historyList.classList.add('empty');
      el.historyList.innerHTML = '<p class="muted">Aucune session enregistrée pour le moment.</p>';
      return;
    }
    el.historyList.classList.remove('empty');

    // Affichage
    uniq
      .slice()
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      .forEach(s => {
        const wrap = document.createElement('div');
        wrap.className = 'session-item';

        const title = document.createElement('div');
        const when = new Date(s.endedAt || s.startedAt || Date.now());
        const dateStr = when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

        title.innerHTML = `<strong>${s.title || 'Session'}</strong><div class="meta">${dateStr}</div>`;

        const score = document.createElement('div');
        score.className = 'score';
        score.textContent = `${s.score}/${s.total}`;

        wrap.append(title, score);
        el.historyList.appendChild(wrap);
      });
  }

  function clearHistory() {
    localStorage.removeItem('quiz.sessions.v2');
    renderHistory();
  }

  // ---------- Utilitaires ----------
  function pickRandom(arr, k) {
    // Shuffle (Fisher–Yates) puis slice
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, k);
  }
})();