/* Weight-Loss Challenge — app wiring. Game rules live in logic.js. */
(function () {
  'use strict';
  const L = window.WLCLogic;
  const sb = window.supabase.createClient(WLC_CONFIG.supabaseUrl, WLC_CONFIG.supabaseKey);

  const state = {
    session: null,
    participants: [],
    me: null,          // my participants row (null => spectator/read-only)
    partner: null,
    months: [],
    month: null,       // the month currently in play (or most relevant)
    targets: [],
    weighIns: [],
    workouts: [],
    checkins: [],
    forfeits: [],
    badges: [],
    view: 'dashboard',
    leaderMode: 'week',
    foodOnPlan: null,
    lastLoad: 0,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => L.toDateStr(new Date());
  const fmtKg = (n) => (Math.round(Number(n) * 10) / 10).toFixed(1);
  const fmtDate = (s) => { const d = L.parseDate(s); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };

  // ---------- toasts ----------
  function toast(msg, cls) {
    const el = document.createElement('div');
    el.className = 'toast' + (cls ? ' ' + cls : '');
    el.textContent = msg;
    $('toast-root').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  const oops = (err) => { console.error(err); toast('⚠️ ' + (err.message || err), 'error'); };

  // ---------- auth ----------
  async function init() {
    registerSW();
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);

    $('login-form').addEventListener('submit', onLogin);
    $('signout-btn').addEventListener('click', onSignOut);
    $('refresh-btn').addEventListener('click', () => { state.userTapped = true; refresh(true); });
    document.querySelectorAll('#tabbar .tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
    wireForms();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.session && Date.now() - state.lastLoad > 10000) refresh(false);
    });

    const { data: { session } } = await sb.auth.getSession();
    state.session = session;
    sb.auth.onAuthStateChange((_event, s) => {
      const had = !!state.session;
      state.session = s;
      if (!!s !== had) route();
    });
    route();
  }

  async function onLogin(e) {
    e.preventDefault();
    const btn = $('login-btn'), errEl = $('login-error');
    btn.disabled = true; btn.textContent = 'Signing in…'; errEl.hidden = true;
    const { error } = await sb.auth.signInWithPassword({
      email: $('login-email').value.trim(),
      password: $('login-password').value,
    });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) { errEl.textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message; errEl.hidden = false; }
  }

  async function onSignOut() {
    if (confirm('Sign out?')) await sb.auth.signOut();
  }

  function route() {
    const authed = !!state.session;
    $('view-login').hidden = authed;
    $('app-shell').hidden = !authed;
    if (authed) refresh(true);
  }

  // ---------- data ----------
  async function loadAll() {
    const q = (t, sel) => sb.from(t).select(sel || '*');
    const [pa, mo, ta, wi, wo, fc, ff, ba] = await Promise.all([
      q('participants'), q('challenge_months'), q('month_targets'), q('weigh_ins'),
      q('workouts'), q('food_checkins'), q('forfeits'), q('badges'),
    ]);
    for (const r of [pa, mo, ta, wi, wo, fc, ff, ba]) if (r.error) throw r.error;
    state.participants = (pa.data || []).sort((a, b) => a.name.localeCompare(b.name));
    state.months = (mo.data || []).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    state.targets = ta.data || [];
    state.weighIns = wi.data || [];
    state.workouts = wo.data || [];
    state.checkins = fc.data || [];
    state.forfeits = ff.data || [];
    state.badges = ba.data || [];
    const uid = state.session && state.session.user.id;
    state.me = state.participants.find((p) => p.auth_uid === uid) || null;
    state.partner = state.me ? state.participants.find((p) => p.id !== state.me.id) || null : null;
    state.month = L.pickCurrentMonth(state.months, today());
    state.lastLoad = Date.now();
  }

  async function refresh(showSpin) {
    if (showSpin) $('refresh-btn').classList.add('spin');
    try {
      await loadAll();
      renderAll();
      if (showSpin && state.userTapped) toast('✓ Up to date');
      state.userTapped = false;
      await autoResolveForfeits();
      await awardBadges();
    } catch (err) { oops(err); }
    $('refresh-btn').classList.remove('spin');
  }

  const colorOf = (pid) => (state.participants.findIndex((p) => p.id === pid) === 0 ? 'var(--p1)' : 'var(--p2)');
  const targetOf = (pid, monthId) => state.targets.find((t) => t.participant_id === pid && t.month_id === (monthId || (state.month && state.month.id))) || null;
  const dataBag = () => ({ month: state.month, months: state.months, targets: state.targets, weighIns: state.weighIns, workouts: state.workouts, checkins: state.checkins, today: today() });

  // ---------- derived writes (self rows only; RLS enforces) ----------
  async function autoResolveForfeits() {
    if (!state.me) return;
    for (const m of state.months) {
      if (!L.monthEnded(m, today())) continue;
      const t = targetOf(state.me.id, m.id);
      if (!t) continue;
      if (state.forfeits.some((f) => f.month_id === m.id && f.participant_id === state.me.id)) continue;
      const res = L.resolveForfeit(t, state.weighIns);
      const row = { month_id: m.id, participant_id: state.me.id, target_met: res.target_met, amount_owed: res.amount_owed };
      const { data, error } = await sb.from('forfeits').upsert(row, { onConflict: 'month_id,participant_id' }).select();
      if (error) { oops(error); continue; }
      if (data && data[0]) state.forfeits.push(data[0]);
      toast(res.target_met ? '🎉 ' + m.label + ' resolved — target met, £0 owed!' : '😬 ' + m.label + ' resolved — £' + res.amount_owed + ' forfeit.', res.target_met ? '' : 'error');
      renderAll();
    }
  }

  async function awardBadges() {
    if (!state.me || !state.partner) return;
    const earned = L.earnedBadges(state.me.id, state.partner.id, dataBag());
    const have = new Set(state.badges.filter((b) => b.participant_id === state.me.id).map((b) => b.badge_key));
    const fresh = [...earned].filter((k) => !have.has(k));
    if (!fresh.length) return;
    const rows = fresh.map((k) => ({ participant_id: state.me.id, badge_key: k }));
    const { data, error } = await sb.from('badges').upsert(rows, { onConflict: 'participant_id,badge_key', ignoreDuplicates: true }).select();
    if (error) { oops(error); return; }
    (data || []).forEach((b) => state.badges.push(b));
    fresh.forEach((k) => { const d = L.BADGE_DEFS[k]; if (d) toast('🏅 Badge unlocked: ' + d.emoji + ' ' + d.name + '!', 'badge-toast'); });
    renderAll();
  }

  // ---------- views ----------
  function switchView(v) {
    state.view = v;
    document.querySelectorAll('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    ['dashboard', 'weigh', 'food', 'workout', 'month'].forEach((name) => { $('view-' + name).hidden = name !== v; });
    renderAll();
    window.scrollTo(0, 0);
  }

  function renderAll() {
    if (!state.session) return;
    renderHeader();
    renderDashboard();
    renderWeigh();
    renderFood();
    renderWorkout();
    renderMonth();
  }

  function renderHeader() {
    const m = state.month, t = today();
    let label = 'No month yet';
    if (m) {
      const wn = L.currentWeekNo(m, t), wk = L.weeksIn(m);
      label = m.label + (wn === 0 ? ' · starts ' + fmtDate(m.starts_on) : wn > wk ? ' · finished' : ' · week ' + wn + '/' + wk);
    }
    $('month-pill').textContent = label;
    $('signout-btn').textContent = (state.me ? state.me.name : 'Spectator') + ' ⏻';
  }

  // ----- dashboard -----
  function renderDashboard() {
    const root = $('view-dashboard');
    const t = today();
    if (state.participants.length < 2) {
      root.innerHTML = '<div class="empty"><span class="big-emoji">🚧</span><b>Setup incomplete</b><br><span class="muted">The two participants haven\'t been seeded in the database yet. Run the seed SQL from the README, then refresh.</span></div>';
      return;
    }
    const a = state.me || state.participants[0];
    const b = state.me ? state.partner : state.participants[1];
    let html = '';

    if (!state.me) html += '<div class="banner">👀 Signed in as a spectator — this account isn\'t one of the two participants, so everything is read-only.</div>';

    // headline
    const bagA = { target: targetOf(a.id), weighIns: state.weighIns, workouts: state.workouts, checkins: state.checkins, today: t };
    const bagB = { target: targetOf(b.id), weighIns: state.weighIns, workouts: state.workouts, checkins: state.checkins, today: t };
    const sA = L.pillarStats(a.id, bagA), sB = L.pillarStats(b.id, bagB);
    const h = L.headline(sA, sB);
    if (state.me) {
      const cls = h > 0 ? 'ahead' : h < 0 ? 'behind' : 'tie';
      const big = h > 0 ? '🏆 You\'re ahead!' : h < 0 ? '😤 You\'re behind!' : '🤝 Neck and neck';
      const why = whyLine(sA, sB, b.name);
      html += '<div class="headline ' + cls + '"><span class="big">' + big + '</span><span class="why">' + esc(why) + '</span></div>';
    } else {
      const big = h > 0 ? esc(a.name) + ' leads!' : h < 0 ? esc(b.name) + ' leads!' : 'Dead heat';
      html += '<div class="headline tie"><span class="big">⚔️ ' + big + '</span><span class="why">' + esc(a.name) + ' vs ' + esc(b.name) + '</span></div>';
    }

    // set-my-target banner
    if (state.me && state.month && !targetOf(state.me.id)) {
      html += '<div class="banner">🎯 You haven\'t set your target for ' + esc(state.month.label) + ' yet. <button class="btn" data-go="month">Set it now</button></div>';
    }

    // fighters
    html += '<div class="board">' + fighterCard(a, a.id === (state.me && state.me.id)) + fighterCard(b, false) + '</div>';

    // leaderboard compare
    html += '<div class="section-title">Head to head</div><div class="card">';
    html += '<div class="seg" id="leader-seg"><button data-mode="week" class="' + (state.leaderMode === 'week' ? 'active' : '') + '">This week</button><button data-mode="month" class="' + (state.leaderMode === 'month' ? 'active' : '') + '">This month</button></div>';
    html += cmpTable(a, b);
    html += '</div>';

    // nudges
    const nudges = buildNudges(a, b);
    if (nudges.length) {
      html += '<div class="section-title">Check-in radar</div><div class="card">' +
        nudges.map((n) => '<div class="nudge' + (n.self ? ' self' : '') + '">' + esc(n.text) + '</div>').join('') + '</div>';
    }

    // badges
    html += '<div class="section-title">Badges</div><div class="card">' + badgesBlock(a, b) + '</div>';

    // forfeit ledger
    html += '<div class="section-title">💷 Forfeit ledger — £' + L.FORFEIT_AMOUNT + ' a miss (weight only)</div><div class="card">' + ledgerBlock() + '</div>';

    // how it works (expandable)
    html += '<details class="card rules"' + (state.rulesOpen ? ' open' : '') + '><summary>ℹ️ How the challenge works<span class="chev">▾</span></summary><div class="rules-body">' +
      '<p>The Summer 2026 Challenge is a head-to-head weight-loss contest between Tony and Amber running from 6 July to 27 September, split into three 4-week blocks.</p>' +
      '<p>At the start of each block, both set their own target weight, then weigh in every Monday morning, and the week-4 weigh-in is the one that counts: finish a block above your target and you owe the other person <b>£200</b>. The slate is wiped clean after each checkpoint, with the next block starting from wherever you finished, so lost kilos are never re-counted.</p>' +
      '<p>Alongside the money, two bragging-rights battles run all summer: a daily "on plan?" food check-in and at least four workouts of 45+ minutes every week. These feed streaks, badges, and the live "who\'s winning" scoreboard above, where every weigh-in, meal verdict, and workout (screenshot proof optional) gets logged from each person\'s own phone.</p>' +
      '</div></details>';

    root.innerHTML = html;
    const rules = root.querySelector('details.rules');
    if (rules) rules.addEventListener('toggle', () => { state.rulesOpen = rules.open; });
    const seg = $('leader-seg');
    if (seg) seg.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => { state.leaderMode = btn.dataset.mode; renderDashboard(); }));
    root.querySelectorAll('[data-go]').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.go)));
  }

  function whyLine(sA, sB, otherName) {
    const bits = [];
    if (sA.weightPct !== sB.weightPct) bits.push((sA.weightPct > sB.weightPct ? 'winning' : 'losing') + ' on weight (' + pct(sA.weightPct) + '% vs ' + pct(sB.weightPct) + '%)');
    if (sA.workoutsThisWeek !== sB.workoutsThisWeek) bits.push('workouts ' + sA.workoutsThisWeek + '–' + sB.workoutsThisWeek);
    if (sA.foodThisWeek !== sB.foodThisWeek) bits.push('food days ' + sA.foodThisWeek + '–' + sB.foodThisWeek);
    return bits.length ? bits.join(' · ') : 'Level with ' + otherName + ' on every stat';
  }
  const pct = (x) => Math.round(Math.max(-99, Math.min(1.5, x)) * 100);

  function fighterCard(p, isMe) {
    const t = today();
    const tgt = targetOf(p.id);
    const col = colorOf(p.id);
    let html = '<div class="fighter' + (isMe ? ' me' : '') + '">';
    html += '<div class="fighter-name"><span class="dot" style="background:' + col + '"></span>' + esc(p.name) + (isMe ? ' <span class="you-chip">YOU</span>' : '') + '</div>';

    // weight
    if (tgt) {
      const ws = L.weightStats(tgt, state.weighIns);
      const width = Math.round(Math.max(0, Math.min(1, ws.pctClosed)) * 100);
      html += '<div class="stat"><div class="stat-label">Target ' + fmtKg(ws.goal) + ' kg</div>';
      html += '<div class="stat-value ' + (ws.met ? 'good' : '') + '">' + (ws.met ? '🎯 Target hit!' : fmtKg(Math.max(0, ws.toGo)) + ' <small>kg to go</small>') + '</div>';
      html += '<div class="bar"><span style="width:' + width + '%;background:' + (ws.met ? 'var(--good)' : col) + '"></span></div>';
      html += '<div class="hint">' + (ws.latestWeek ? 'wk' + ws.latestWeek + ': ' + fmtKg(ws.current) + ' kg · ' + pct(ws.pctClosed) + '% closed' : 'no weigh-in yet · start ' + fmtKg(ws.start) + ' kg') + '</div></div>';
    } else {
      html += '<div class="stat"><div class="stat-label">Target</div><div class="stat-value muted">not set</div></div>';
    }

    // workouts (this ISO week)
    const q = L.qualifyingCountInWeek(state.workouts, p.id, t);
    const hitGoal = q >= L.WEEKLY_WORKOUT_GOAL;
    html += '<div class="stat"><div class="stat-label">Workouts this week</div><div class="stat-value ' + (hitGoal ? 'good' : '') + '">' + q + '<small>/' + L.WEEKLY_WORKOUT_GOAL + (hitGoal ? ' ✓' : '') + '</small></div><div class="dots">' +
      [0, 1, 2, 3].map((i) => '<span class="d' + (i < q ? ' on' : '') + '"></span>').join('') + '</div></div>';

    // food (this ISO week, Mon..Sun)
    const monday = L.mondayOf(t);
    const fm = L.foodMap(state.checkins, p.id);
    html += '<div class="stat"><div class="stat-label">Food this week</div><div class="dots small">' +
      [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const d = L.addDays(monday, i);
        const v = fm.get(d);
        return '<span class="d' + (v === true ? ' on' : v === false ? ' off' : '') + '"></span>';
      }).join('') + '</div></div>';

    // streaks
    const fs = L.foodStreak(state.checkins, p.id, t);
    const wws = L.workoutWeekStreak(state.workouts, p.id, t);
    html += '<div class="streak-line">🔥 ' + fs.length + ' <small class="muted">day' + (fs.length === 1 ? '' : 's') + ' on-plan</small>' +
      (wws > 0 ? ' &nbsp;🏋️ ' + wws + ' <small class="muted">wk' + (wws === 1 ? '' : 's') + '</small>' : '') +
      (fs.atRisk && isMe ? '<span class="risk">⚠️ log today or the chain breaks</span>' : '') + '</div>';

    html += '</div>';
    return html;
  }

  function cmpTable(a, b) {
    const t = today();
    const rows = [];
    if (state.leaderMode === 'week') {
      rows.push(['💪 Workouts (of 4)', L.qualifyingCountInWeek(state.workouts, a.id, t), L.qualifyingCountInWeek(state.workouts, b.id, t)]);
      rows.push(['🥗 On-plan days (of 7)', L.onPlanCountInWeek(state.checkins, a.id, t), L.onPlanCountInWeek(state.checkins, b.id, t)]);
      rows.push(['🔥 Food streak', L.foodStreak(state.checkins, a.id, t).length, L.foodStreak(state.checkins, b.id, t).length]);
    } else {
      const ta = targetOf(a.id), tb = targetOf(b.id);
      rows.push(['🎯 Target closed %', ta ? pct(L.weightStats(ta, state.weighIns).pctClosed) : 0, tb ? pct(L.weightStats(tb, state.weighIns).pctClosed) : 0]);
      rows.push(['⚖️ Kg still to go', ta ? +fmtKg(Math.max(0, L.weightStats(ta, state.weighIns).toGo)) : '—', tb ? +fmtKg(Math.max(0, L.weightStats(tb, state.weighIns).toGo)) : '—', true]);
      rows.push(['🏋️ Workout-week streak', L.workoutWeekStreak(state.workouts, a.id, t), L.workoutWeekStreak(state.workouts, b.id, t)]);
    }
    let html = '<table class="cmp"><tr><td></td><td><b>' + esc(a.name) + '</b></td><td><b>' + esc(b.name) + '</b></td></tr>';
    for (const r of rows) {
      const lowerWins = r[3] === true;
      const va = r[1], vb = r[2];
      let ca = '', cb = '';
      if (typeof va === 'number' && typeof vb === 'number' && va !== vb) {
        const aWins = lowerWins ? va < vb : va > vb;
        ca = aWins ? 'win' : 'lose'; cb = aWins ? 'lose' : 'win';
      }
      html += '<tr><td>' + r[0] + '</td><td class="' + ca + '">' + va + '</td><td class="' + cb + '">' + vb + '</td></tr>';
    }
    return html + '</table>';
  }

  function buildNudges(a, b) {
    const out = [];
    const bag = dataBag();
    if (state.me) {
      L.nudgesFor(b.name, b.id, bag).forEach((text) => out.push({ text }));
      const fs = L.foodStreak(state.checkins, state.me.id, today());
      if (fs.atRisk) out.push({ text: '⚠️ Log today\'s food or lose your 🔥' + fs.length + ' streak!', self: true });
      const m = state.month;
      if (m && !L.monthEnded(m, today())) {
        const wn = L.currentWeekNo(m, today());
        if (wn >= 1 && wn <= L.weeksIn(m) && !state.weighIns.some((w) => w.participant_id === state.me.id && w.month_id === m.id && w.week_no === wn)) {
          out.push({ text: '⚖️ Your week-' + wn + ' weigh-in is due', self: true });
        }
      }
    } else {
      L.nudgesFor(a.name, a.id, bag).forEach((text) => out.push({ text }));
      L.nudgesFor(b.name, b.id, bag).forEach((text) => out.push({ text }));
    }
    return out;
  }

  function badgesBlock(a, b) {
    const keys = Object.keys(L.BADGE_DEFS);
    const has = (pid, k) => state.badges.some((x) => x.participant_id === pid && x.badge_key === k);
    const rowFor = (p, showLocked) => {
      const chips = keys
        .filter((k) => showLocked || has(p.id, k))
        .map((k) => {
          const d = L.BADGE_DEFS[k];
          const owned = has(p.id, k);
          return '<span class="badge-chip' + (owned ? '' : ' locked') + '" title="' + esc(d.desc) + '">' + d.emoji + ' ' + esc(d.name) + '</span>';
        }).join('');
      return '<div class="hint" style="margin-top:10px">' + esc(p.name) + '</div><div class="badge-row">' + (chips || '<span class="muted">none yet — go earn one!</span>') + '</div>';
    };
    return rowFor(a, true) + rowFor(b, false);
  }

  function ledgerBlock() {
    const t = today();
    let rows = '';
    let owed = new Map(state.participants.map((p) => [p.id, 0]));
    for (const m of state.months) {
      if (!L.monthEnded(m, t)) continue;
      for (const p of state.participants) {
        if (!targetOf(p.id, m.id)) continue;
        const f = state.forfeits.find((x) => x.month_id === m.id && x.participant_id === p.id);
        let status;
        if (f) {
          status = f.amount_owed > 0 ? '<span class="owes">owes £' + f.amount_owed + '</span>' : '<span class="clear">✓ target met</span>';
          owed.set(p.id, owed.get(p.id) + f.amount_owed);
        } else {
          status = '<span class="pending">awaiting resolution</span>';
        }
        rows += '<div class="ledger-row"><span>' + esc(m.label) + ' — ' + esc(p.name) + '</span>' + status + '</div>';
      }
    }
    const totals = state.participants
      .filter((p) => owed.get(p.id) > 0)
      .map((p) => '<div class="ledger-row"><b>' + esc(p.name) + ' total</b><span class="owes">£' + owed.get(p.id) + '</span></div>')
      .join('');
    if (!rows) rows = '<div class="hint">No months settled yet. Hit your target and keep it that way. 💪</div>';
    return rows + totals;
  }

  // ----- weigh view -----
  function renderWeigh() {
    const seg = $('weigh-week-seg');
    const m = state.month;
    const weeks = m ? L.weeksIn(m) : 4;
    const wn = m ? Math.min(weeks, Math.max(1, L.currentWeekNo(m, today()))) : 1;
    if (seg.dataset.built !== String(weeks)) {
      const range = []; for (let w = 1; w <= weeks; w++) range.push(w);
      seg.innerHTML = range.map((w) => '<button type="button" data-w="' + w + '">Wk ' + w + '</button>').join('');
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        $('weigh-week').value = b.dataset.w;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      }));
      seg.dataset.built = String(weeks);
    }
    if (!seg.dataset.userTouched) {
      $('weigh-week').value = wn;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', +x.dataset.w === wn));
    }
    const dis = !state.me || !m;
    $('weigh-form').querySelectorAll('input,button').forEach((el) => { el.disabled = dis; });

    // history: current month, both people
    let html = '';
    if (m) {
      html += '<div class="section-title">' + esc(m.label) + ' weigh-ins</div><div class="card">';
      for (let w = 1; w <= weeks; w++) {
        const cells = state.participants.map((p) => {
          const row = state.weighIns.find((x) => x.month_id === m.id && x.participant_id === p.id && x.week_no === w);
          return esc(p.name) + ': ' + (row ? '<b>' + fmtKg(row.weight) + '</b>' : '<span class="muted">—</span>');
        }).join(' &nbsp;·&nbsp; ');
        html += '<div class="hist-row"><span>Week ' + w + '</span><span>' + cells + '</span></div>';
      }
      html += '</div>';
    } else {
      html = '<div class="empty"><span class="big-emoji">📅</span>No month set up yet — create one in the Month tab.</div>';
    }
    $('weigh-history').innerHTML = html;
  }

  // ----- food view -----
  function renderFood() {
    if (!$('food-date').value) $('food-date').value = today();
    const dis = !state.me;
    $('food-form').querySelectorAll('input,button').forEach((el) => { el.disabled = dis; });
    if (!state.me) return;
    const fm = L.foodMap(state.checkins, state.me.id);
    let html = '<div class="section-title">Your last 7 days</div><div class="card">';
    for (let i = 0; i < 7; i++) {
      const d = L.addDays(today(), -i);
      const row = state.checkins.find((c) => c.participant_id === state.me.id && c.checkin_date === d);
      const tag = !fm.has(d) ? '<span class="tag warn">not logged</span>' : fm.get(d) ? '<span class="tag good">on plan</span>' : '<span class="tag bad">off plan</span>';
      const cal = row && row.calories ? ' <span class="hist-note">' + row.calories + ' kcal</span>' : '';
      html += '<div class="hist-row"><span>' + (i === 0 ? 'Today' : i === 1 ? 'Yesterday' : fmtDate(d)) + cal + '</span>' + tag + '</div>';
    }
    $('food-history').innerHTML = html + '</div>';
  }

  // ----- workout view -----
  function renderWorkout() {
    if (!$('workout-date').value) $('workout-date').value = today();
    const dis = !state.me;
    $('workout-form').querySelectorAll('input,button').forEach((el) => { el.disabled = dis; });
    workoutHint();
    if (!state.me) return;
    const mine = state.workouts
      .filter((w) => w.participant_id === state.me.id)
      .sort((a, b) => b.workout_date.localeCompare(a.workout_date))
      .slice(0, 10);
    const q = L.qualifyingCountInWeek(state.workouts, state.me.id, today());
    let html = '<div class="section-title">This week: ' + q + '/' + L.WEEKLY_WORKOUT_GOAL + ' qualifying</div><div class="card">';
    if (!mine.length) html += '<div class="hint">No workouts logged yet.</div>';
    for (const w of mine) {
      const counts = L.workoutQualifies(w);
      html += '<div class="hist-row"><span>' + fmtDate(w.workout_date) + ' · <b>' + w.duration_min + ' min</b> ' +
        (counts ? '<span class="tag good">counts</span>' : '<span class="tag warn">&lt;45 — doesn\'t count</span>') +
        (w.source !== 'manual' ? ' <span class="hist-note">' + esc(w.source) + '</span>' : '') +
        (w.note ? '<div class="hist-note">' + esc(w.note) + '</div>' : '') + '</span>' +
        '<span class="row-actions">' +
        (w.photo_path ? '<img class="proof-thumb" data-proof="' + esc(w.photo_path) + '" alt="workout proof">' : '') +
        '<button class="btn-danger-ghost" data-del="' + esc(w.id) + '" title="Delete">✕</button></span></div>';
    }
    $('workout-list').innerHTML = html + '</div>';
    hydrateProofThumbs($('workout-list'));
    $('workout-list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this workout?')) return;
      const { error } = await sb.from('workouts').delete().eq('id', b.dataset.del);
      if (error) return oops(error);
      state.workouts = state.workouts.filter((w) => w.id !== b.dataset.del);
      renderAll();
      awardBadges();
    }));
  }

  function workoutHint() {
    const v = +($('workout-duration').value || 0);
    $('workout-hint').textContent = v >= L.QUALIFYING_MIN ? '✅ counts toward your 4-a-week' : '⚠️ under ' + L.QUALIFYING_MIN + ' min — logged, but won\'t count';
  }

  // ----- month view -----
  function renderMonth() {
    const root = $('month-content');
    const t = today();
    if (state.participants.length < 2) { root.innerHTML = '<div class="empty"><span class="big-emoji">🚧</span>Seed the participants first (see README).</div>'; return; }
    let html = '';
    const m = state.month;

    if (!m) {
      html += '<div class="card"><h3>🚀 Start the first month</h3><p class="hint">Four weeks. Miss your target and you owe £' + L.FORFEIT_AMOUNT + '.</p>' + monthForm('first', t, null) + '</div>';
      root.innerHTML = html;
      wireMonthForm('first', null);
      return;
    }

    const wn = L.currentWeekNo(m, t);
    const wk = L.weeksIn(m);
    const ended = L.monthEnded(m, t);
    html += '<div class="card"><h3>' + esc(m.label) + '</h3><p class="hint">' + fmtDate(m.starts_on) + ' → ' + fmtDate(m.ends_on) + ' · ' +
      (ended ? 'finished' : wn === 0 ? 'starts ' + fmtDate(m.starts_on) : 'week ' + wn + ' of ' + wk + ' · ' + L.weeksLeft(m, t) + ' week' + (L.weeksLeft(m, t) === 1 ? '' : 's') + ' left') + '</p>' +
      (ended ? '' : '<p class="hint">🏁 Deciding day: <b>' + fmtDate(m.ends_on) + '</b> — final weigh-in vs target settles the £' + L.FORFEIT_AMOUNT + '.</p>');

    // targets per person
    for (const p of state.participants) {
      const tgt = targetOf(p.id, m.id);
      const isMe = state.me && p.id === state.me.id;
      html += '<div class="hist-row"><span><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + colorOf(p.id) + '"></span> ' + esc(p.name) + '</span><span>' +
        (tgt ? '<b>' + fmtKg(tgt.start_weight) + '</b> → <b>' + fmtKg(tgt.target_weight) + '</b> kg' : '<span class="muted">no target yet</span>') + '</span></div>';
      if (isMe && !tgt && !ended) {
        html += '<div id="set-target-slot"></div>';
      }
    }
    html += '</div>';

    // my target editor
    if (state.me) {
      const myTgt = targetOf(state.me.id, m.id);
      if (myTgt && !ended) {
        html += '<div class="card"><h3>🎯 Edit my target</h3>' +
          '<form id="edit-target-form" class="form-card">' +
          '<label>Start weight (kg)</label><input id="et-start" type="number" step="0.1" min="20" max="400" inputmode="decimal" value="' + esc(myTgt.start_weight) + '" required>' +
          '<label>Target weight (kg)</label><input id="et-target" type="number" step="0.1" min="20" max="400" inputmode="decimal" value="' + esc(myTgt.target_weight) + '" required>' +
          '<label>Daily calorie target <span class="muted">(optional)</span></label><input id="et-cal" type="number" min="0" max="20000" inputmode="numeric" value="' + esc(myTgt.calorie_target || '') + '">' +
          '<button class="btn btn-primary btn-big" type="submit">Save target</button></form></div>';
      }
    }

    // resolution + next month
    if (ended) {
      html += '<div class="card"><h3>🏁 ' + esc(m.label) + ' result</h3>';
      for (const p of state.participants) {
        const tgt = targetOf(p.id, m.id);
        if (!tgt) { html += '<div class="hist-row"><span>' + esc(p.name) + '</span><span class="muted">no target set</span></div>'; continue; }
        const fin = L.finalWeighIn(state.weighIns, p.id, m.id);
        const res = L.resolveForfeit(tgt, state.weighIns);
        html += '<div class="hist-row"><span>' + esc(p.name) + ' · final ' + (fin ? fmtKg(fin.weight) + ' kg (wk' + fin.week_no + ')' : '—') + ' vs ' + fmtKg(tgt.target_weight) + '</span>' +
          (res.target_met ? '<span class="clear">✓ £0</span>' : '<span class="owes">£' + res.amount_owed + '</span>') + '</div>';
      }
      html += '<p class="hint">Forfeits are written automatically for each person when they open the app after month end.</p></div>';

      const hasNext = state.months.some((x) => x.starts_on > m.ends_on);
      if (!hasNext) {
        const draft = L.nextMonthDraft(m);
        html += '<div class="card"><h3>📆 Start Block ' + (state.months.length + 1) + '</h3><p class="hint">Your new start weight is pre-filled from your final weigh-in — already-lost kilos are never re-targeted.</p>' +
          monthForm('next', draft.starts_on, draft) + '</div>';
      }
    }

    // past months
    const past = state.months.filter((x) => x.id !== m.id);
    if (past.length) {
      html += '<div class="section-title">Other months</div><div class="card">';
      for (const pm of past.slice().reverse()) {
        const bits = state.participants.map((p) => {
          const f = state.forfeits.find((x) => x.month_id === pm.id && x.participant_id === p.id);
          return esc(p.name) + ': ' + (f ? (f.amount_owed > 0 ? '<span class="owes">£' + f.amount_owed + '</span>' : '<span class="clear">✓</span>') : '<span class="muted">—</span>');
        }).join(' · ');
        html += '<div class="hist-row"><span>' + esc(pm.label) + '</span><span>' + bits + '</span></div>';
      }
      html += '</div>';
    }

    root.innerHTML = html;

    // wire set-target (mid-card slot)
    const slot = root.querySelector('#set-target-slot');
    if (slot) {
      slot.innerHTML = '<form id="set-target-form" class="form-card" style="margin:8px 0 14px">' +
        '<label>My start weight (kg)</label><input id="st-start" type="number" step="0.1" min="20" max="400" inputmode="decimal" value="' + esc(suggestedStart() || '') + '" required>' +
        '<label>My target weight (kg)</label><input id="st-target" type="number" step="0.1" min="20" max="400" inputmode="decimal" required>' +
        '<button class="btn btn-primary" type="submit">Set my target</button></form>';
      $('set-target-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await upsertMyTarget(m.id, $('st-start').value, $('st-target').value, null);
      });
    }
    const etf = root.querySelector('#edit-target-form');
    if (etf) etf.addEventListener('submit', async (e) => {
      e.preventDefault();
      await upsertMyTarget(m.id, $('et-start').value, $('et-target').value, $('et-cal').value || null);
    });
    if (root.querySelector('#month-form-next')) wireMonthForm('next', m);
  }

  function suggestedStart() {
    if (!state.me) return null;
    const t = today();
    const prev = state.months.filter((x) => L.monthEnded(x, t)).pop();
    const prevTgt = prev ? targetOf(state.me.id, prev.id) : null;
    return prevTgt ? L.nextStartWeight(prevTgt, state.weighIns) : null;
  }

  function monthForm(kind, defaultStart, draft) {
    const start = state.me ? (kind === 'next' && draft ? L.nextStartWeight(targetOf(state.me.id, state.month.id), state.weighIns) : null) : null;
    const defaultEnd = draft ? draft.ends_on : L.addDays(defaultStart, L.WEEKS_PER_MONTH * 7 - 1);
    return '<form id="month-form-' + kind + '" class="form-card">' +
      '<label>Starts</label><input id="mf-start-date" type="date" value="' + esc(defaultStart) + '" ' + (kind === 'next' ? 'disabled' : '') + ' required>' +
      '<label>Ends (deciding day)</label><input id="mf-end-date" type="date" value="' + esc(defaultEnd) + '" required>' +
      '<label>My start weight (kg)</label><input id="mf-start" type="number" step="0.1" min="20" max="400" inputmode="decimal" value="' + esc(start != null ? start : '') + '" required>' +
      '<label>My target weight (kg)</label><input id="mf-target" type="number" step="0.1" min="20" max="400" inputmode="decimal" required>' +
      '<p class="hint">Your partner sets their own target when they next open the app.</p>' +
      '<button class="btn btn-primary btn-big" type="submit"' + (state.me ? '' : ' disabled') + '>Create month</button></form>';
  }

  function wireMonthForm(kind, prevMonth) {
    $('month-form-' + kind).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.me) return;
      try {
        const startsOn = kind === 'next' ? L.nextMonthDraft(prevMonth).starts_on : $('mf-start-date').value;
        const endsOn = $('mf-end-date').value;
        if (!(endsOn > startsOn)) throw new Error('End date must be after the start date.');
        // "Block N" labels: 4-week blocks can share a calendar month, so
        // YYYY-MM labels would collide in the ledger.
        const month = { label: 'Block ' + (state.months.length + 1), starts_on: startsOn, ends_on: endsOn };
        if (state.months.some((x) => x.starts_on === month.starts_on)) throw new Error('That month already exists.');
        const { data: mrow, error: e1 } = await sb.from('challenge_months').insert(month).select().single();
        if (e1) throw e1;
        const { error: e2 } = await sb.from('month_targets').insert({
          month_id: mrow.id, participant_id: state.me.id,
          start_weight: +$('mf-start').value, target_weight: +$('mf-target').value,
        });
        if (e2) throw e2;
        toast('📆 ' + month.label + ' created — game on!');
        await refresh(true);
        switchView('dashboard');
      } catch (err) { oops(err); }
    });
  }

  async function upsertMyTarget(monthId, start, target, cal) {
    try {
      const row = { month_id: monthId, participant_id: state.me.id, start_weight: +start, target_weight: +target, calorie_target: cal ? +cal : null };
      const { error } = await sb.from('month_targets').upsert(row, { onConflict: 'month_id,participant_id' });
      if (error) throw error;
      toast('🎯 Target saved. No backing out now.');
      await refresh(false);
    } catch (err) { oops(err); }
  }

  // ---------- forms ----------
  function wireForms() {
    $('weigh-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.me || !state.month) return;
      try {
        const row = {
          month_id: state.month.id, participant_id: state.me.id,
          week_no: +$('weigh-week').value, weight: +$('weigh-weight').value, logged_on: today(),
        };
        const { error } = await sb.from('weigh_ins').upsert(row, { onConflict: 'month_id,participant_id,week_no' });
        if (error) throw error;
        toast('⚖️ Week ' + row.week_no + ' logged: ' + fmtKg(row.weight) + ' kg');
        $('weigh-weight').value = '';
        await refresh(false);
      } catch (err) { oops(err); }
    });

    $('food-yes').addEventListener('click', () => setOnPlan(true));
    $('food-no').addEventListener('click', () => setOnPlan(false));
    $('food-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.me) return;
      if (state.foodOnPlan === null) { toast('Pick ✅ or ❌ first', 'error'); return; }
      try {
        const row = {
          participant_id: state.me.id, checkin_date: $('food-date').value,
          on_plan: state.foodOnPlan, calories: $('food-calories').value ? +$('food-calories').value : null,
        };
        const { error } = await sb.from('food_checkins').upsert(row, { onConflict: 'participant_id,checkin_date' });
        if (error) throw error;
        toast(row.on_plan ? '🥗 On plan — chain intact!' : '🍕 Logged. Tomorrow\'s a new day.');
        $('food-calories').value = '';
        setOnPlan(null);
        await refresh(false);
      } catch (err) { oops(err); }
    });

    $('workout-duration').addEventListener('input', workoutHint);
    $('workout-photo-btn').addEventListener('click', () => $('workout-photo').click());
    $('workout-photo').addEventListener('change', () => {
      const f = $('workout-photo').files[0];
      $('workout-photo-name').hidden = !f;
      if (f) $('workout-photo-name').textContent = '📎 ' + f.name + ' — tap Log workout to upload';
    });
    $('workout-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.me) return;
      const btn = $('workout-form').querySelector('.btn-primary');
      btn.disabled = true;
      try {
        const row = {
          participant_id: state.me.id, workout_date: $('workout-date').value,
          duration_min: +$('workout-duration').value, source: 'manual',
        };
        const note = $('workout-note').value.trim();
        if (note) row.note = note;
        const file = $('workout-photo').files[0];
        if (file) {
          btn.textContent = 'Uploading photo…';
          row.photo_path = await uploadProof(file);
        }
        let { error } = await sb.from('workouts').insert(row);
        if (error && /note|photo_path|column|schema/i.test(error.message)) {
          // DB not migrated yet — save the workout itself, flag the rest
          const basic = { participant_id: row.participant_id, workout_date: row.workout_date, duration_min: row.duration_min, source: 'manual' };
          ({ error } = await sb.from('workouts').insert(basic));
          if (!error) toast('Saved, but notes/photos need update-workouts.sql run first', 'error');
        }
        if (error) throw error;
        toast(row.duration_min >= L.QUALIFYING_MIN ? '💪 Counts! Nice work.' : '🙂 Logged (under 45 — doesn\'t count)');
        $('workout-note').value = '';
        $('workout-photo').value = '';
        $('workout-photo-name').hidden = true;
        await refresh(false);
      } catch (err) { oops(err); }
      btn.disabled = false;
      btn.textContent = 'Log workout';
    });

    $('weigh-week-seg').addEventListener('click', () => { $('weigh-week-seg').dataset.userTouched = '1'; }, true);
  }

  function setOnPlan(v) {
    state.foodOnPlan = v;
    $('food-yes').classList.toggle('sel-yes', v === true);
    $('food-no').classList.toggle('sel-no', v === false);
  }

  // ---------- workout proof photos (Supabase Storage) ----------
  const PROOF_BUCKET = 'workout-proofs';
  async function compressImage(file) {
    // iPhone screenshots are 1-3MB PNGs; shrink to <=1600px JPEG to stay tiny
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 500000) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      return blob || file;
    } catch (_) { return file; }
  }
  async function uploadProof(file) {
    const blob = await compressImage(file);
    const path = state.session.user.id + '/' + Date.now() + '.jpg';
    const { error } = await sb.storage.from(PROOF_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw new Error('Photo upload failed: ' + error.message + ' (has update-workouts.sql been run?)');
    return path;
  }
  async function hydrateProofThumbs(root) {
    const imgs = [...root.querySelectorAll('img[data-proof]')];
    if (!imgs.length || !sb.storage) return;
    try {
      const { data, error } = await sb.storage.from(PROOF_BUCKET).createSignedUrls(imgs.map((i) => i.dataset.proof), 3600);
      if (error || !data) return;
      const byPath = new Map(data.map((d) => [d.path, d.signedUrl]));
      imgs.forEach((img) => {
        const url = byPath.get(img.dataset.proof);
        if (!url) return;
        img.src = url;
        img.addEventListener('click', () => window.open(url, '_blank'));
      });
    } catch (_) { /* thumbs are best-effort */ }
  }

  // ---------- PWA / offline ----------
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    // When a NEW version replaces the old SW, reload once so updates apply
    // on the next open instead of needing two manual refreshes. First-ever
    // visit (no prior controller) never reloads — assets are already fresh.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
  function updateOnline() { $('offline-banner').hidden = navigator.onLine; }

  init();
})();
