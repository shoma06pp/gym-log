(() => {
  'use strict';

  const STORE_KEY = 'gymlog.v1';
  const TIMER_KEY = 'gymlog.timerEnd';
  const PRESETS = [60, 90, 120, 180];
  const APP_VERSION = 'v17'; // sw.js の CACHE の番号と揃える
  const VOLUMES = { mid: 0.5, high: 0.85, max: 1 }; // 休憩終了の音量
  const PARTS = ['胸', '背中', '肩', '腕', '脚', '腹', 'その他'];
  const NO_PART = '未分類';

  const $ = (sel, root = document) => root.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(c));
    }
    return el;
  }

  /* ---------- データ ---------- */
  const defaults = () => ({
    machines: [],
    sets: [],
    lastMachine: null,
    lastPart: 'all', // 記録画面で選んでいる部位 ('all' = すべて)
    lastMode: 'strength', // 記録画面で選んでいる種類 ('strength' = 筋トレ / 'cardio' = 有酸素)
    owner: null, // クラウドと同期した Firebase ユーザーID
    // sound: 内蔵の音の名前(beep / chime / bell / arp / siren / coin) または 'custom' = 自分で選んだ音声ファイル(端末内に保存、同期しない)
    settings: { interval: 90, autoStart: true, step: 2.5, volume: 'high', sound: 'beep', soundName: '' },
  });

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.machines) && Array.isArray(s.sets)) {
        const d = defaults();
        const st = { ...d, ...s, settings: { ...d.settings, ...s.settings } };
        if (st.settings.sound === 'default') st.settings.sound = 'beep'; // 旧バージョンの設定値
        st.machines.forEach((m, i) => {
          if (!Number.isFinite(m.createdAt)) m.createdAt = i;
          m.kind = m.kind === 'cardio' ? 'cardio' : 'strength';
        });
        return st;
      }
    } catch (e) { /* 壊れていたら初期化 */ }
    return defaults();
  }

  let state = load();

  // cloud.js が読み込めなかった場合でも、ローカル保存だけで動くようにする
  const noop = () => {};
  const Cloud = window.GymCloud || {
    init: noop, signIn: noop, signOut: noop, signedIn: false,
    upsertMachine: noop, upsertSet: noop, removeSet: noop, removeMachineAndSets: noop, bulkUpsert: noop,
    saveToDrive: async () => { throw new Error('unavailable'); },
  };

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('保存できませんでした(ブラウザの保存領域を確認してください)');
    }
  }

  const machineById = (id) => state.machines.find((m) => m.id === id);
  const isCardio = (m) => !!m && m.kind === 'cardio';
  const isCardioSet = (s) => Number.isFinite(s.distance);
  const strengthMachines = () => state.machines.filter((m) => !isCardio(m));
  const cardioMachines = () => state.machines.filter(isCardio);
  const partOf = (m) => (PARTS.includes(m.part) ? m.part : NO_PART);
  const partsPresent = () => {
    const present = new Set(strengthMachines().map(partOf));
    return [...PARTS, NO_PART].filter((p) => present.has(p));
  };
  const fmtW = (n) => (n === 0 ? '自重' : Number.isInteger(n) ? `${n}kg` : `${+n.toFixed(2)}kg`);
  const fmtDist = (n) => `${+n.toFixed(2)}km`;
  const fmtCal = (n) => `${Math.round(n)}kcal`;
  const fmtSet = (s) => (isCardioSet(s) ? `${fmtDist(s.distance)} / ${fmtCal(s.calories)}` : `${fmtW(s.weight)} × ${s.reps}`);

  // 同じ重量・回数(有酸素なら同じ距離・カロリー)が続いたセットを1行にまとめる。
  // 例: 30kg × 10 を3セット → { sets: [3つ], count: 3 }
  const setKey = (s) => (isCardioSet(s) ? `c|${s.distance}|${s.calories}` : `s|${s.weight}|${s.reps}`);
  function groupSets(sets) {
    const groups = [];
    for (const s of sets) {
      const last = groups[groups.length - 1];
      if (last && last.key === setKey(s)) last.sets.push(s);
      else groups.push({ key: setKey(s), sets: [s] });
    }
    return groups.map((g) => ({ ...g, first: g.sets[0], last: g.sets[g.sets.length - 1], count: g.sets.length }));
  }
  const fmtGroup = (g) => (g.count > 1 ? `${fmtSet(g.first)} ×${g.count}` : fmtSet(g.first));

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function dayLabel(key) {
    const [y, m, d] = key.split('-').map(Number);
    const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
    return `${m}/${d}(${w})`;
  }
  const timeLabel = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  /* ---------- トースト ---------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ---------- タブ ---------- */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'history') renderHistory();
    if (name === 'admin') renderAdmin();
    if (name === 'record') renderRecord();
    $('main').scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

  /* ---------- 記録 ---------- */
  let selId = null;

  function latestSet(mid) {
    let best = null;
    for (const s of state.sets) if (s.machineId === mid && (!best || s.ts > best.ts)) best = s;
    return best;
  }

  function lastSession(mid) {
    const today = dayKey(Date.now());
    const prev = state.sets.filter((s) => s.machineId === mid && dayKey(s.ts) !== today);
    if (!prev.length) return null;
    const key = dayKey(Math.max(...prev.map((s) => s.ts)));
    return { key, sets: prev.filter((s) => dayKey(s.ts) === key).sort((a, b) => a.ts - b.ts) };
  }

  // 入力欄の初期値は、そのマシンの直近の記録にする(なければ標準値)
  function prefillInputs(id) {
    const last = latestSet(id);
    if (isCardio(machineById(id))) {
      $('#distance').value = last && isCardioSet(last) ? last.distance : 3;
      $('#calories').value = last && isCardioSet(last) ? last.calories : 200;
    } else {
      $('#weight').value = last && !isCardioSet(last) ? last.weight : 20;
      $('#reps').value = last && !isCardioSet(last) ? last.reps : 10;
    }
  }

  function selectMachine(id) {
    selId = id;
    state.lastMachine = id;
    save();
    prefillInputs(id);
    renderRecord();
  }

  function setMode(mode) {
    state.lastMode = mode;
    save();
    renderRecord();
  }

  function renderRecord() {
    const has = state.machines.length > 0;
    $('#record-empty').hidden = has;
    $('#record-body').hidden = !has;
    if (!has) return;

    // 筋トレ / 有酸素 の切り替え
    const mode = state.lastMode === 'cardio' ? 'cardio' : 'strength';
    const cardio = mode === 'cardio';
    $('#mode-chips').replaceChildren(...[['strength', '筋トレ'], ['cardio', '有酸素']].map(([key, label]) =>
      h('button', {
        class: 'chip', type: 'button', role: 'radio',
        'aria-checked': String(key === mode),
        onclick: () => setMode(key),
      }, label)));

    const pool = cardio ? cardioMachines() : strengthMachines();
    $('#mode-empty').hidden = pool.length > 0;
    $('#mode-body').hidden = pool.length === 0;
    if (!pool.length) {
      $('#mode-empty-text').textContent = cardio
        ? '有酸素のマシンがまだありません。「管理」で、種類を「有酸素」にして登録してください。'
        : '筋トレのマシンがまだありません。';
      return;
    }

    // 筋トレは部位で絞り込む。選んだ部位にマシンがなければ「すべて」に戻す
    const parts = cardio ? [] : partsPresent();
    let partSel = state.lastPart;
    if (partSel !== 'all' && !parts.includes(partSel)) partSel = 'all';
    const visible = partSel === 'all' ? pool : pool.filter((m) => partOf(m) === partSel);

    if (!visible.some((m) => m.id === selId)) {
      const next = visible.find((m) => m.id === state.lastMachine) || visible[0];
      selId = next.id;
      prefillInputs(next.id);
    }

    $('#part-wrap').hidden = cardio || parts.length < 2;
    $('#part-chips').replaceChildren(...['all', ...parts].map((p) =>
      h('button', {
        class: 'chip', type: 'button', role: 'radio',
        'aria-checked': String(p === partSel),
        onclick: () => { state.lastPart = p; save(); renderRecord(); },
      }, p === 'all' ? 'すべて' : p)));

    $('#strength-inputs').hidden = cardio;
    $('#cardio-inputs').hidden = !cardio;

    const chips = $('#machine-chips');
    chips.replaceChildren(...visible.map((m) =>
      h('button', {
        class: 'chip', type: 'button', role: 'radio',
        'aria-checked': String(m.id === selId),
        onclick: () => selectMachine(m.id),
      }, m.name)));

    const ls = lastSession(selId);
    const lastBox = $('#last-session');
    lastBox.replaceChildren(
      ls
        ? h('div', {}, '前回 ', h('strong', {}, dayLabel(ls.key)), h('div', { class: 'sets' }, groupSets(ls.sets).map(fmtGroup).join(' / ')))
        : h('div', {}, 'このマシンの前回の記録はまだありません'));

    const today = dayKey(Date.now());
    const todays = state.sets.filter((s) => s.machineId === selId && dayKey(s.ts) === today).sort((a, b) => a.ts - b.ts);
    const box = $('#today-sets');
    if (!todays.length) {
      box.replaceChildren(h('div', { class: 'none' }, '今日はまだ記録がありません'));
    } else {
      box.replaceChildren(...todays.map((s, i) => h('div', { class: 'row' },
        h('span', { class: 'num' }, String(i + 1)),
        h('span', { class: 'grow val' }, fmtSet(s)),
        h('span', { class: 'time' }, timeLabel(s.ts)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'この記録を削除', onclick: () => deleteSet(s.id) }, '✕'))));
    }
  }

  function deleteSet(id, count = 1) {
    const msg = count > 1 ? `この記録(${count}セット)から、最後の1セットを削除しますか?` : 'この記録を削除しますか?';
    if (!confirm(msg)) return;
    state.sets = state.sets.filter((s) => s.id !== id);
    save();
    Cloud.removeSet(id);
    renderRecord();
    renderHistory();
  }

  // ＋/− ボタン: 入力欄ごとの刻みと下限
  const stepConfig = {
    weight: () => ({ step: Number(state.settings.step) || 2.5, min: 0 }),
    reps: () => ({ step: 1, min: 1 }),
    distance: () => ({ step: 0.1, min: 0 }),
    calories: () => ({ step: 10, min: 0 }),
  };
  document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
    const input = $(`#${b.dataset.target}`);
    const { step, min } = stepConfig[b.dataset.target]();
    const cur = parseFloat(input.value);
    const next = Math.max(min, Math.round(((Number.isNaN(cur) ? 0 : cur) + Number(b.dataset.dir) * step) * 100) / 100);
    input.value = next;
  }));

  $('#add-set').addEventListener('click', () => {
    const weight = parseFloat($('#weight').value);
    const reps = parseInt($('#reps').value, 10);
    if (!machineById(selId)) return toast('マシンを選んでください');
    if (!(weight >= 0) || !(reps > 0)) return toast('重量と回数を入力してください');
    const set = { id: uid(), machineId: selId, weight, reps, ts: Date.now() };
    state.sets.push(set);
    save();
    Cloud.upsertSet(set);
    renderRecord();
    if (state.settings.autoStart) startTimer();
    toast(`記録しました: ${fmtW(weight)} × ${reps}`);
  });

  // 有酸素は距離とカロリーだけ。休憩のインターバルは動かさない
  $('#add-cardio').addEventListener('click', () => {
    const distance = Math.round(parseFloat($('#distance').value) * 100) / 100;
    const calories = Math.round(parseFloat($('#calories').value));
    if (!isCardio(machineById(selId))) return toast('マシンを選んでください');
    if (!(distance >= 0) || !(calories >= 0) || (distance === 0 && calories === 0)) return toast('距離かカロリーを入力してください');
    const set = { id: uid(), machineId: selId, distance, calories, ts: Date.now() };
    state.sets.push(set);
    save();
    Cloud.upsertSet(set);
    renderRecord();
    toast(`記録しました: ${fmtSet(set)}`);
  });

  /* ---------- 履歴 ---------- */
  function renderHistory() {
    const root = $('#history-list');
    if (!state.sets.length) {
      root.replaceChildren(h('div', { class: 'empty' }, 'まだ記録がありません'));
      return;
    }
    const days = new Map();
    for (const s of [...state.sets].sort((a, b) => a.ts - b.ts)) {
      const k = dayKey(s.ts);
      if (!days.has(k)) days.set(k, new Map());
      const byMachine = days.get(k);
      if (!byMachine.has(s.machineId)) byMachine.set(s.machineId, []);
      byMachine.get(s.machineId).push(s);
    }
    const out = [];
    for (const k of [...days.keys()].sort().reverse()) {
      const dayEl = h('div', { class: 'day' }, h('div', { class: 'day-head' },
        h('h3', {}, dayLabel(k)),
        h('button', { class: 'btn small', type: 'button', onclick: (e) => saveDayToDrive(k, e.currentTarget) }, 'ドライブへ')));
      for (const [mid, sets] of days.get(k)) {
        // 同じ重量・回数のセットは1行にまとめ、「3セット」のように回数を示す
        const rows = groupSets(sets).map((g) => h('div', { class: 'row' },
          h('span', { class: 'grow val' }, fmtSet(g.first)),
          g.count > 1 || !isCardioSet(g.first) ? h('span', { class: 'pill' }, `${g.count}セット`) : null,
          h('span', { class: 'time' }, timeLabel(g.last.ts)),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'この記録を削除', onclick: () => deleteSet(g.last.id, g.count) }, '✕')));
        dayEl.append(h('div', { class: 'card' },
          h('div', { class: 'mname' }, machineById(mid)?.name ?? '(削除済みのマシン)'),
          ...rows));
      }
      out.push(dayEl);
    }
    root.replaceChildren(...out);
  }

  /* ---------- Googleドライブへの出力(日記用) ---------- */
  function buildDayJson(key) {
    const byMachine = new Map();
    for (const s of state.sets.filter((x) => dayKey(x.ts) === key).sort((a, b) => a.ts - b.ts)) {
      if (!byMachine.has(s.machineId)) byMachine.set(s.machineId, []);
      byMachine.get(s.machineId).push(s);
    }
    return {
      date: key,
      exportedAt: new Date().toISOString(),
      workouts: [...byMachine].map(([mid, sets]) => {
        const m = machineById(mid);
        const cardio = isCardio(m) || isCardioSet(sets[0]);
        return {
          machine: m?.name ?? '(削除済み)',
          type: cardio ? 'cardio' : 'strength',
          ...(m && m.part && !cardio ? { part: m.part } : {}),
          summary: groupSets(sets).map(fmtGroup).join(', '),
          sets: sets.map((s) => (cardio
            ? { time: timeLabel(s.ts), distanceKm: s.distance, calories: s.calories }
            : { time: timeLabel(s.ts), weightKg: s.weight, reps: s.reps })),
        };
      }),
    };
  }

  async function saveDayToDrive(key, btn) {
    if (!Cloud.signedIn) return toast('管理タブでGoogleにログインしてください');
    btn.disabled = true;
    try {
      const r = await Cloud.saveToDrive(`gymlog-${key}.json`, buildDayJson(key));
      toast(r.updated ? 'ドライブのファイルを更新しました' : 'ドライブに保存しました(ジムログ フォルダ)');
    } catch (e) {
      console.warn(e);
      const msg = String(e && (e.code || e.message));
      toast(/popup|cancel/.test(msg) ? 'ドライブへの保存を中止しました' : `ドライブに保存できませんでした: ${msg.slice(0, 60)}`);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- 管理 ---------- */
  function renderAdmin() {
    const list = $('#machine-list');
    if (!state.machines.length) {
      list.replaceChildren(h('div', { class: 'none' }, 'マシンを追加してください'));
    } else {
      const rows = [];
      const strength = strengthMachines();
      for (const part of [...PARTS, NO_PART]) {
        const ms = strength.filter((m) => partOf(m) === part);
        if (!ms.length) continue;
        rows.push(h('div', { class: 'group-head' }, `筋トレ・${part}(${ms.length})`));
        for (const m of ms) {
          rows.push(h('div', { class: 'row' },
            h('span', { class: 'grow' }, m.name),
            h('select', {
              class: 'part-select', 'aria-label': `${m.name}の部位`,
              onchange: (e) => changePart(m.id, e.target.value),
            }, partOptions(partOf(m) === NO_PART ? '' : m.part)),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${m.name}の名前を変更`, onclick: () => renameMachine(m.id) }, '✎'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${m.name}を削除`, onclick: () => deleteMachine(m.id) }, '✕')));
        }
      }
      const cardio = cardioMachines();
      if (cardio.length) {
        rows.push(h('div', { class: 'group-head' }, `有酸素(${cardio.length})`));
        for (const m of cardio) {
          rows.push(h('div', { class: 'row' },
            h('span', { class: 'grow' }, m.name),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${m.name}の名前を変更`, onclick: () => renameMachine(m.id) }, '✎'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${m.name}を削除`, onclick: () => deleteMachine(m.id) }, '✕')));
        }
      }
      list.replaceChildren(...rows);
    }
    $('#opt-auto').checked = !!state.settings.autoStart;
    $('#opt-step').value = String(state.settings.step);
    $('#opt-volume').value = state.settings.volume in VOLUMES ? state.settings.volume : 'high';
    renderSoundName();
    renderCloud();
    renderDiag();
  }

  // iPhone のホーム画面アプリでは、window の高さが実画面より上端の安全領域の分(約59pt)低く報告され、
  // アプリの描画範囲の下に、アプリの外の余白ができる(伸ばしても切り取られるため、アプリ側では埋められない)。
  // その外側にホームバーが入るので、タブバー内の下の安全余白(env(safe-area-inset-bottom))は重複して不要になる。
  // 差(gap)が上の安全領域と一致するときだけ、この不具合とみなす(ステータスバーが画面に重ならない設定のときの差は不具合ではない)。
  let noBottomInset = false;
  function measureInsetTop() {
    const probe = h('div', { style: 'position:fixed;visibility:hidden;left:0;top:0;padding-top:env(safe-area-inset-top)' });
    document.body.append(probe);
    const v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return v;
  }
  function fitFooter() {
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    const gap = standalone && innerHeight > innerWidth ? Math.max(screen.width, screen.height) - innerHeight : 0;
    noBottomInset = gap > 0 && gap <= 100 && Math.abs(gap - measureInsetTop()) <= 2;
    document.documentElement.style.setProperty('--safe-bottom', noBottomInset ? '0px' : 'env(safe-area-inset-bottom)');
  }
  fitFooter();
  ['resize', 'orientationchange', 'pageshow'].forEach((ev) => window.addEventListener(ev, fitFooter));

  // 表示のずれを調べるための情報。画面のスクリーンショットを送ってもらう用
  function renderDiag() {
    const probe = h('div', { style: 'position:fixed;visibility:hidden;left:0;top:0;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom) 0' });
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const inset = `上 ${cs.paddingTop} / 下 ${cs.paddingBottom}`;
    probe.remove();
    const px = (n) => Math.round(n * 10) / 10;
    const rect = (sel) => { const r = $(sel).getBoundingClientRect(); return `上${px(r.top)} 下${px(r.bottom)}`; };
    const vv = window.visualViewport;
    const lines = [
      `版: ${APP_VERSION}`,
      `ホーム画面起動: ${navigator.standalone === true || matchMedia('(display-mode: standalone)').matches ? 'はい' : 'いいえ'}`,
      `window: ${innerWidth} x ${innerHeight}`,
      `visualViewport: ${vv ? `${px(vv.width)} x ${px(vv.height)} (上${px(vv.offsetTop)})` : '-'}`,
      `screen: ${screen.width} x ${screen.height}`,
      `安全領域: ${inset}`,
      `下の安全余白を外す: ${noBottomInset ? 'はい' : 'いいえ'}`,
      `body: ${rect('body')}`,
      `main: ${rect('main')}`,
      `タイマー: ${rect('#timer')}`,
      `タブ: ${rect('.tabs')}`,
    ];
    $('#diag').textContent = lines.join('\n');
  }
  window.addEventListener('resize', () => { if ($('#view-admin').classList.contains('active')) renderDiag(); });

  const partOptions = (selected) => [
    h('option', { value: '', selected: !selected }, NO_PART),
    ...PARTS.map((p) => h('option', { value: p, selected: p === selected }, p)),
  ];

  function changePart(id, part) {
    const m = machineById(id);
    if (!m) return;
    m.part = part;
    save();
    Cloud.upsertMachine(m);
    renderAdmin();
  }

  // 登録フォームの種類・部位は、続けて登録しやすいよう前回の選択を覚えておく
  $('#machine-part').replaceChildren(...partOptions(''));
  // 有酸素には部位がないので、種類が有酸素のときは部位の選択を隠す
  $('#machine-kind').addEventListener('change', () => {
    $('#machine-part').hidden = $('#machine-kind').value === 'cardio';
  });

  $('#machine-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#machine-name');
    const name = input.value.trim();
    if (!name) return;
    if (state.machines.some((m) => m.name === name)) return toast('同じ名前のマシンがあります');
    const kind = $('#machine-kind').value === 'cardio' ? 'cardio' : 'strength';
    const machine = { id: uid(), name, createdAt: Date.now(), kind, part: kind === 'cardio' ? '' : $('#machine-part').value };
    state.machines.push(machine);
    save();
    Cloud.upsertMachine(machine);
    input.value = '';
    renderAdmin();
    toast(`追加しました: ${name}`);
  });

  function renameMachine(id) {
    const m = machineById(id);
    const name = (prompt('新しい名前', m.name) || '').trim();
    if (!name || name === m.name) return;
    if (state.machines.some((x) => x.id !== id && x.name === name)) return toast('同じ名前のマシンがあります');
    m.name = name;
    save();
    Cloud.upsertMachine(m);
    renderAdmin();
  }

  function deleteMachine(id) {
    const m = machineById(id);
    const n = state.sets.filter((s) => s.machineId === id).length;
    if (!confirm(`「${m.name}」を削除しますか?${n ? `\nこのマシンの記録 ${n} セットも削除されます。` : ''}`)) return;
    const setIds = state.sets.filter((s) => s.machineId === id).map((s) => s.id);
    state.machines = state.machines.filter((x) => x.id !== id);
    state.sets = state.sets.filter((s) => s.machineId !== id);
    if (selId === id) selId = null;
    save();
    Cloud.removeMachineAndSets(id, setIds);
    renderAdmin();
  }

  $('#opt-auto').addEventListener('change', (e) => { state.settings.autoStart = e.target.checked; save(); });
  $('#opt-step').addEventListener('change', (e) => { state.settings.step = Number(e.target.value); save(); });
  $('#opt-volume').addEventListener('change', (e) => { state.settings.volume = e.target.value; save(); });
  $('#test-sound').addEventListener('click', () => { ensureAudio(); rebuildAudioIfStuck(); beep(); });

  // 音を選んだら、すぐに鳴らして確かめられるようにする
  $('#sound-kind').addEventListener('change', (e) => {
    state.settings.sound = e.target.value;
    save();
    ensureAudio();
    rebuildAudioIfStuck();
    beep();
  });

  $('#sound-pick').addEventListener('click', () => $('#sound-file').click());
  $('#sound-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('ファイルが大きすぎます(10MBまで)');
    try {
      const data = await file.arrayBuffer();
      const buffer = await decodeAudio(data); // 先に再生できるか確かめる
      await idb.set('custom', { name: file.name, data });
      customBuffer = buffer;
      state.settings.sound = 'custom';
      state.settings.soundName = file.name;
      save();
      renderSoundName();
      toast('休憩終了の音を設定しました');
      beep();
    } catch (err) {
      toast('この音声ファイルは使えません(wav / mp3 / m4a を選んでください)');
    }
  });
  $('#sound-reset').addEventListener('click', async () => {
    try { await idb.del('custom'); } catch (e) { /* 無視 */ }
    customBuffer = null;
    state.settings.sound = 'beep';
    state.settings.soundName = '';
    save();
    renderSoundName();
    toast('保存した音声を削除しました');
  });

  /* ---------- バックアップ / Claudeへの共有 ---------- */
  function buildSummaryText() {
    const lines = ['# Gym Log 記録'];
    const days = new Map();
    for (const s of [...state.sets].sort((a, b) => a.ts - b.ts)) {
      const k = dayKey(s.ts);
      if (!days.has(k)) days.set(k, new Map());
      const bm = days.get(k);
      if (!bm.has(s.machineId)) bm.set(s.machineId, []);
      bm.get(s.machineId).push(s);
    }
    for (const k of [...days.keys()].sort().reverse()) {
      lines.push('', `## ${k}`);
      for (const [mid, sets] of days.get(k)) {
        const m = machineById(mid);
        const label = `${m?.name ?? '(削除済み)'}${isCardio(m) ? '(有酸素)' : ''}`;
        lines.push(`- ${label}: ${groupSets(sets).map(fmtGroup).join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  $('#copy-btn').addEventListener('click', async () => {
    if (!state.sets.length) return toast('記録がまだありません');
    const text = buildSummaryText();
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました。Claudeに貼り付けてください');
    } catch (e) {
      prompt('コピーして使ってください', text);
    }
  });

  $('#export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `gymlog-${dayKey(Date.now())}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const machines = (data.machines || []).filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string');
      const sets = (data.sets || []).filter((s) => s && typeof s.machineId === 'string' && Number.isFinite(s.ts)
        && ((Number.isFinite(s.weight) && Number.isFinite(s.reps)) || (Number.isFinite(s.distance) && Number.isFinite(s.calories))));
      if (!machines.length && !sets.length) throw new Error('empty');
      const merge = Cloud.signedIn; // クラウド同期中は、他の端末の記録を消さないよう「追加」にする
      const msg = merge
        ? `マシン ${machines.length} 件、記録 ${sets.length} セットを追加します。\n同じIDの記録は上書きされます。よろしいですか?`
        : `マシン ${machines.length} 件、記録 ${sets.length} セットを読み込みます。\n今のデータは置き換えられます。よろしいですか?`;
      if (!confirm(msg)) return;
      const nm = machines.map((m, i) => ({
        id: m.id, name: m.name, createdAt: Number.isFinite(m.createdAt) ? m.createdAt : i, part: PARTS.includes(m.part) ? m.part : '',
        kind: m.kind === 'cardio' ? 'cardio' : 'strength',
      }));
      const ns = sets.map((s) => {
        const base = { id: typeof s.id === 'string' ? s.id : uid(), machineId: s.machineId, ts: s.ts };
        return Number.isFinite(s.distance) && Number.isFinite(s.calories)
          ? { ...base, distance: s.distance, calories: s.calories }
          : { ...base, weight: s.weight, reps: s.reps };
      });
      if (merge) {
        const byId = (list, add) => [...new Map([...list, ...add].map((x) => [x.id, x])).values()];
        state.machines = byId(state.machines, nm).sort((a, b) => a.createdAt - b.createdAt);
        state.sets = byId(state.sets, ns);
        Cloud.bulkUpsert(nm, ns);
      } else {
        const d = defaults();
        state = {
          ...d,
          machines: nm,
          sets: ns,
          lastMachine: data.lastMachine ?? null,
          settings: { ...d.settings, ...(data.settings || {}) },
        };
      }
      selId = null;
      save();
      renderAdmin();
      renderRecord();
      toast('読み込みました');
    } catch (err) {
      toast('読み込めませんでした。ファイルを確認してください');
    }
  });

  /* ---------- タイマー ---------- */
  const T = { endAt: 0, doneAt: 0, tickId: 0, ctx: null, wake: null };
  try { T.endAt = Number(localStorage.getItem(TIMER_KEY)) || 0; } catch (e) { /* 無視 */ }

  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  function persistTimer() {
    try { localStorage.setItem(TIMER_KEY, String(T.endAt)); } catch (e) { /* 無視 */ }
  }

  // 音の出力(AudioContext)を、鳴らせる状態にしておく。
  // iPhone では、別アプリの音声・電話・画面ロックなどで 'suspended' や 'interrupted' になり、
  // 画面をタップするまで鳴らなくなる。そのため、タップのたびに状態を確かめて復帰させる。
  function ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!T.ctx || T.ctx.state === 'closed') T.ctx = new AC();
      if (T.ctx.state !== 'running') T.ctx.resume().catch(() => { /* 次のタップで再試行 */ });
    } catch (e) { /* 音なしで続行 */ }
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, ensureAudio, { passive: true }));

  // 復帰できなかった出力は作り直す(タップの直後に呼ぶ)
  function rebuildAudioIfStuck() {
    setTimeout(() => {
      if (T.ctx && T.ctx.state !== 'running') {
        try { T.ctx.close(); } catch (e) { /* 無視 */ }
        T.ctx = null;
        ensureAudio();
      }
    }, 300);
  }

  /* 自分の音声ファイル: この端末の IndexedDB にだけ保存する(サーバーや公開サイトには置かない) */
  const idb = {
    open() {
      return new Promise((resolve, reject) => {
        const r = indexedDB.open('gymlog-sound', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      });
    },
    async set(key, value) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(value, key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
    async del(key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').delete(key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
  };
  let customBuffer = null; // デコード済みの音声(AudioBuffer)

  function decodeAudio(arrayBuffer) {
    ensureAudio();
    if (!T.ctx) return Promise.reject(new Error('no audio'));
    // Safari はコールバック形式のほうが確実。元のデータは壊れないよう複製して渡す
    return new Promise((resolve, reject) => T.ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject));
  }

  // 音の選択欄を、いまの設定に合わせて作り直す。「自分の音声」は、保存してあるときだけ出す
  function renderSoundName() {
    const sel = $('#sound-kind');
    const hasCustom = !!state.settings.soundName && !!customBuffer;
    sel.replaceChildren(
      ...Object.entries(SOUNDS).map(([key, s]) => h('option', { value: key }, s.label)),
      hasCustom ? h('option', { value: 'custom' }, `自分の音声: ${state.settings.soundName}`) : null);
    sel.value = state.settings.sound in SOUNDS || hasCustom ? state.settings.sound : 'beep';
  }

  async function loadCustomSound() {
    try {
      if (state.settings.soundName) {
        const rec = await idb.get('custom');
        customBuffer = rec ? await decodeAudio(rec.data) : null;
        if (!rec) {
          state.settings.soundName = '';
          if (state.settings.sound === 'custom') state.settings.sound = 'beep';
          save();
        }
      }
    } catch (e) {
      customBuffer = null; // 読めなければ標準の音で鳴らす
    }
    renderSoundName();
  }

  /* 内蔵の音(アプリ内で合成するオリジナルの音)。それぞれ (ctx, out, t0) で、t0 秒後から out へ鳴らす */
  const tone = (ctx, out, { f, t, d, type = 'sine', g = 1, a = 0.01 }) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = f;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(g, t + a);
    env.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + d + 0.02);
  };

  const SOUNDS = {
    // 高めの矩形波の「ピピピピッ」。いちばん目立つ
    beep: {
      label: 'ピピピピッ(標準)',
      play: (ctx, out, t0) => [0, 0.25, 0.5, 0.75, 1.3, 1.55, 1.8, 2.05].forEach((off, i) =>
        tone(ctx, out, { f: i % 4 === 3 ? 2093 : 1568, t: t0 + off, d: 0.19, type: 'square' })),
    },
    // ドアチャイムの「ピンポーン」
    chime: {
      label: 'ピンポーン',
      play: (ctx, out, t0) => {
        [[1319, 0, 0.7], [1047, 0.5, 1.4], [1319, 1.9, 0.7], [1047, 2.4, 1.4]].forEach(([f, off, d]) => {
          tone(ctx, out, { f, t: t0 + off, d, g: 1 });
          tone(ctx, out, { f: f * 2, t: t0 + off, d: d * 0.6, g: 0.35 });
        });
      },
    },
    // 金属的なベルの「カーン」。倍音を重ねる
    bell: {
      label: 'ベル(カーン)',
      play: (ctx, out, t0) => [0, 1.1, 2.2].forEach((off) =>
        [[1, 1], [2.76, 0.6], [5.4, 0.35], [8.93, 0.2]].forEach(([mul, g]) =>
          tone(ctx, out, { f: 880 * mul, t: t0 + off, d: 1.6 / Math.sqrt(mul), g, a: 0.003 }))),
    },
    // ドミソド〜と駆け上がるアルペジオ
    arp: {
      label: 'ファンファーレ',
      play: (ctx, out, t0) => {
        [523, 659, 784, 1047, 1319].forEach((f, i) => tone(ctx, out, { f, t: t0 + i * 0.12, d: i === 4 ? 1.2 : 0.3, type: 'triangle' }));
        [523, 659, 784, 1047, 1319].forEach((f, i) => tone(ctx, out, { f, t: t0 + 1.8 + i * 0.12, d: i === 4 ? 1.2 : 0.3, type: 'triangle' }));
      },
    },
    // 2つの音を交互に鳴らす警報
    siren: {
      label: 'サイレン',
      play: (ctx, out, t0) => [0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1, 2.45].forEach((off, i) =>
        tone(ctx, out, { f: i % 2 ? 660 : 880, t: t0 + off, d: 0.33, type: 'sawtooth', g: 0.7 })),
    },
    // コインを取ったような「ピロリン」
    coin: {
      label: 'ピロリン',
      play: (ctx, out, t0) => [0, 0.9, 1.8].forEach((off) => {
        tone(ctx, out, { f: 988, t: t0 + off, d: 0.1, type: 'square' });
        tone(ctx, out, { f: 1319, t: t0 + off + 0.1, d: 0.6, type: 'square' });
      }),
    },
  };

  // 休憩終了の音。選んだ音(内蔵 or 自分の音声ファイル)を鳴らす。
  // コンプレッサーで音割れを抑えつつ音量を稼ぐ
  function beep() {
    if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 500]);
    ensureAudio();
    const ctx = T.ctx;
    if (!ctx) return;
    const vol = VOLUMES[state.settings.volume] ?? VOLUMES.high;
    const master = ctx.createGain();
    master.gain.value = vol;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);

    if (state.settings.sound === 'custom' && customBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = customBuffer;
      master.gain.value = vol * 2; // 録音された音は小さめのことが多いので持ち上げる
      src.connect(master);
      src.start();
      return;
    }
    (SOUNDS[state.settings.sound] || SOUNDS.beep).play(ctx, master, ctx.currentTime + 0.05);
  }

  async function requestWake() {
    try {
      if (navigator.wakeLock && !T.wake) {
        T.wake = await navigator.wakeLock.request('screen');
        T.wake.addEventListener('release', () => { T.wake = null; });
      }
    } catch (e) { /* 非対応・拒否は無視 */ }
  }
  function releaseWake() {
    try { if (T.wake) T.wake.release(); } catch (e) { /* 無視 */ }
    T.wake = null;
  }

  function startTimer(secs = state.settings.interval) {
    ensureAudio();
    rebuildAudioIfStuck();
    T.endAt = Date.now() + secs * 1000;
    T.doneAt = 0;
    persistTimer();
    requestWake();
    ensureTick();
    tick();
  }

  function stopTimer() {
    T.endAt = 0;
    T.doneAt = 0;
    persistTimer();
    releaseWake();
    clearInterval(T.tickId);
    T.tickId = 0;
    tick();
  }

  function ensureTick() {
    if (!T.tickId) T.tickId = setInterval(tick, 250);
  }

  function tick() {
    const el = $('#timer');
    let left = 0;
    if (T.endAt) {
      left = Math.ceil((T.endAt - Date.now()) / 1000);
      if (left <= 0) {
        T.endAt = 0;
        T.doneAt = Date.now();
        persistTimer();
        releaseWake();
        beep();
      }
    }
    const running = T.endAt > 0;
    const done = !running && T.doneAt && Date.now() - T.doneAt < 6000;
    if (!running && !done) {
      clearInterval(T.tickId);
      T.tickId = 0;
      T.doneAt = 0;
    } else {
      ensureTick();
    }
    el.classList.toggle('running', running);
    el.classList.toggle('done', !!done);
    el.classList.toggle('idle', !running && !done);
    $('#timer-time').textContent = running ? fmtTime(left) : done ? 'GO!' : fmtTime(state.settings.interval);
    $('#timer-label').textContent = running ? '休憩中' : done ? '休憩おわり' : 'インターバル';
    $('#timer-toggle').textContent = running ? 'リセット' : 'スタート';
    $('#timer-add').hidden = !running;
  }

  function renderPresets() {
    $('#presets').replaceChildren(...PRESETS.map((sec) => h('button', {
      class: 'preset', type: 'button', role: 'radio',
      'aria-checked': String(sec === state.settings.interval),
      onclick: () => {
        state.settings.interval = sec;
        save();
        renderPresets();
        if (T.endAt) startTimer(sec); else tick();
      },
    }, sec >= 60 && sec % 60 === 0 ? `${sec / 60}分` : `${sec}秒`)));
  }

  $('#timer-toggle').addEventListener('click', () => (T.endAt ? stopTimer() : startTimer()));
  $('#timer-add').addEventListener('click', () => {
    if (!T.endAt) return;
    T.endAt += 30000;
    persistTimer();
    tick();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureAudio();
      if (T.endAt) {
        requestWake();
        tick();
      }
    }
  });

  /* ---------- クラウド同期 ---------- */
  let cloudStatus = { phase: 'loading', email: '', pending: false };
  let lastErrorAt = 0;

  function renderCloud() {
    const box = $('#cloud-card');
    const { phase, email, pending } = cloudStatus;
    const note = (t) => h('p', { class: 'muted' }, t);
    let body;
    if (phase === 'loading') {
      body = [note('クラウド機能を準備しています…')];
    } else if (phase === 'unavailable') {
      body = [note('クラウドに接続できません。電波のある場所で開き直すと使えるようになります。それまでは、この端末だけに記録されます。')];
    } else if (phase === 'signedout') {
      body = [
        note('Googleアカウントでログインすると、記録がクラウドに保存され、ほかの端末と共有できます。この端末にある今の記録は、初回ログイン時にクラウドへ移されます。'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => Cloud.signIn() }, 'Googleでログイン'),
      ];
    } else {
      const label = phase === 'error' ? '同期に失敗しました' : phase === 'syncing' ? '同期しています…' : pending ? '同期待ち(オフライン、または送信中)' : '同期済み';
      body = [
        h('div', { class: 'cloud-user' }, h('strong', {}, email || 'ログイン中'), h('span', { class: `sync-state${pending || phase !== 'ready' ? ' wait' : ''}` }, label)),
        h('button', { class: 'btn', type: 'button', onclick: doSignOut }, 'ログアウト'),
      ];
    }
    box.replaceChildren(...body);
  }

  async function doSignOut() {
    if (!confirm('ログアウトします。\nこの端末の記録は消去されます(クラウドには残り、次回ログインで戻ります)。\nよろしいですか?')) return;
    await Cloud.signOut();
    state = defaults();
    selId = null;
    save();
    renderRecord();
    renderHistory();
    renderAdmin();
  }

  function errorMessage(e) {
    const code = (e && e.code) || '';
    if (code === 'permission-denied') return '同期が許可されていません(Firestoreのルールを確認してください)';
    if (code === 'auth/unauthorized-domain') return 'このドメインはFirebaseで許可されていません';
    if (code === 'auth/operation-not-allowed') return 'FirebaseでGoogleログインが有効になっていません';
    if (code === 'auth/network-request-failed' || code === 'unavailable') return '通信できませんでした';
    return `同期エラー: ${code || (e && e.message) || '不明'}`;
  }

  const cloudHooks = {
    getLocal: () => state,
    dropLocal: () => { state = defaults(); selId = null; },
    setOwner: (uid) => { state.owner = uid; save(); },
    onStatus: (s) => { cloudStatus = s; renderCloud(); },
    onError: (e) => {
      console.error(e);
      if (Date.now() - lastErrorAt < 3000) return;
      lastErrorAt = Date.now();
      toast(errorMessage(e));
    },
    onRemote: (kind, items) => {
      if (kind === 'machines') {
        state.machines = items.filter((m) => m.name).sort((a, b) => a.createdAt - b.createdAt);
      } else {
        state.sets = items.filter((s) => s.machineId && Number.isFinite(s.ts)
          && ((Number.isFinite(s.weight) && s.reps > 0) || (Number.isFinite(s.distance) && Number.isFinite(s.calories))));
      }
      save();
      renderRecord();
      if ($('#view-history').classList.contains('active')) renderHistory();
      if ($('#view-admin').classList.contains('active')) renderAdmin();
    },
  };

  /* ---------- 起動 ---------- */
  renderCloud();
  Cloud.init(cloudHooks);
  renderPresets();
  if (T.endAt && T.endAt <= Date.now()) { T.endAt = 0; persistTimer(); }
  if (T.endAt) { requestWake(); ensureTick(); }
  tick();
  renderRecord();
  loadCustomSound();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 非対応環境では無視 */ });
    });
  }
})();
