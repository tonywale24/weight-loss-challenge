/* WLC game logic — pure functions only. No DOM, no Supabase.
   Loaded by app.js in the browser and by tests/logic.test.js in Node.
   All dates are local 'YYYY-MM-DD' strings; weeks are ISO weeks keyed by
   their Monday's date string (sortable, no year-boundary math). */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.WLCLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const QUALIFYING_MIN = 45;      // minutes for a workout to count
  const WEEKLY_WORKOUT_GOAL = 4;  // qualifying workouts per ISO week
  const FORFEIT_AMOUNT = 200;     // £, weight pillar ONLY — never food/workouts
  const WEEKS_PER_MONTH = 4;

  // ---------- dates ----------
  const pad = (n) => String(n).padStart(2, '0');
  function toDateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return toDateStr(d); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function mondayOf(s) { const d = parseDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toDateStr(d); }

  // ---------- month timing ----------
  // Challenge periods are variable length (default 4 weeks); the week count
  // is always derived from the period's own dates.
  function weeksIn(month) {
    return Math.max(1, Math.ceil((daysBetween(month.starts_on, month.ends_on) + 1) / 7));
  }
  function currentWeekNo(month, today) {
    if (today < month.starts_on) return 0;                       // not started
    const weeks = weeksIn(month);
    if (today > month.ends_on) return weeks + 1;                 // ended
    return Math.min(weeks, Math.floor(daysBetween(month.starts_on, today) / 7) + 1);
  }
  function monthEnded(month, today) { return today > month.ends_on; }
  function weeksLeft(month, today) {
    const weeks = weeksIn(month);
    const wn = currentWeekNo(month, today);
    if (wn === 0) return weeks;
    if (wn > weeks) return 0;
    return weeks - wn + 1; // includes the current week
  }
  function pickCurrentMonth(months, today) {
    if (!months.length) return null;
    const sorted = months.slice().sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    const active = sorted.find((m) => today >= m.starts_on && today <= m.ends_on);
    if (active) return active;
    const past = sorted.filter((m) => m.ends_on < today);
    if (past.length) return past[past.length - 1]; // most recently ended
    return sorted[0];                              // earliest upcoming
  }

  // ---------- workouts ----------
  function workoutQualifies(w) { return Number(w.duration_min) >= QUALIFYING_MIN; }
  function qualifyingCountInWeek(workouts, pid, anyDateInWeek) {
    const wk = mondayOf(anyDateInWeek);
    return workouts.filter((w) => w.participant_id === pid && workoutQualifies(w) && mondayOf(w.workout_date) === wk).length;
  }
  function workoutWeekStreak(workouts, pid, today) {
    // Consecutive ISO weeks hitting the goal. The in-progress current week
    // counts if already met, but doesn't break the streak while unfinished.
    let streak = 0;
    if (qualifyingCountInWeek(workouts, pid, today) >= WEEKLY_WORKOUT_GOAL) streak++;
    let cursor = addDays(mondayOf(today), -7);
    while (qualifyingCountInWeek(workouts, pid, cursor) >= WEEKLY_WORKOUT_GOAL) { streak++; cursor = addDays(cursor, -7); }
    return streak;
  }
  function hasWorkoutWeek(workouts, pid) {
    const perWeek = new Map();
    for (const w of workouts) {
      if (w.participant_id !== pid || !workoutQualifies(w)) continue;
      const wk = mondayOf(w.workout_date);
      perWeek.set(wk, (perWeek.get(wk) || 0) + 1);
    }
    for (const n of perWeek.values()) if (n >= WEEKLY_WORKOUT_GOAL) return true;
    return false;
  }

  // ---------- food ----------
  function foodMap(checkins, pid) {
    const m = new Map();
    for (const c of checkins) if (c.participant_id === pid) m.set(c.checkin_date, !!c.on_plan);
    return m;
  }
  function foodStreak(checkins, pid, today) {
    // Consecutive on-plan days ending today; if today is unlogged the streak
    // still stands (through yesterday) but is flagged at-risk. A logged
    // off-plan day or an unlogged gap breaks the chain.
    const m = foodMap(checkins, pid);
    let cursor = today, atRisk = false;
    if (!m.has(today)) { atRisk = true; cursor = addDays(today, -1); }
    else if (m.get(today) === false) return { length: 0, atRisk: false };
    let len = 0;
    while (m.get(cursor) === true) { len++; cursor = addDays(cursor, -1); }
    return { length: len, atRisk: atRisk && len > 0 };
  }
  function maxFoodStreak(checkins, pid) {
    const m = foodMap(checkins, pid);
    const dates = [...m.keys()].filter((d) => m.get(d)).sort();
    let best = 0, run = 0, prev = null;
    for (const d of dates) {
      run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
    return best;
  }
  function onPlanCountInWeek(checkins, pid, anyDateInWeek) {
    const wk = mondayOf(anyDateInWeek);
    const m = foodMap(checkins, pid);
    let n = 0;
    for (let i = 0; i < 7; i++) if (m.get(addDays(wk, i)) === true) n++;
    return n;
  }
  function hasPerfectFoodWeek(checkins, pid) {
    const m = foodMap(checkins, pid);
    const weeks = new Set([...m.keys()].map(mondayOf));
    for (const wk of weeks) if (onPlanCountInWeek(checkins, pid, wk) === 7) return true;
    return false;
  }

  // ---------- weight ----------
  function monthWeighIns(weighIns, pid, monthId) {
    return weighIns
      .filter((w) => w.participant_id === pid && w.month_id === monthId)
      .sort((a, b) => a.week_no - b.week_no);
  }
  function finalWeighIn(weighIns, pid, monthId) {
    // The highest-week weigh-in is the official close (ideally the final
    // week; a skipped final week falls back to the last one logged).
    const ws = monthWeighIns(weighIns, pid, monthId);
    return ws[ws.length - 1] || null;
  }
  function pctClosed(start, goal, current) {
    if (!(start > goal)) return current <= goal ? 1 : 0; // degenerate/unset target
    return (start - current) / (start - goal);
  }
  function weightStats(target, weighIns) {
    const ws = monthWeighIns(weighIns, target.participant_id, target.month_id);
    const latest = ws.length ? ws[ws.length - 1] : null;
    const start = Number(target.start_weight), goal = Number(target.target_weight);
    const current = latest ? Number(latest.weight) : start;
    return {
      start, goal, current,
      latestWeek: latest ? latest.week_no : null,
      lost: start - current,
      toGo: current - goal,
      pctClosed: pctClosed(start, goal, current),
      met: latest !== null && current <= goal,
    };
  }
  function pctAtWeek(target, weighIns, weekNo) {
    const ws = monthWeighIns(weighIns, target.participant_id, target.month_id).filter((w) => w.week_no <= weekNo);
    if (!ws.length) return 0;
    return pctClosed(Number(target.start_weight), Number(target.target_weight), Number(ws[ws.length - 1].weight));
  }

  // ---------- forfeit (WEIGHT ONLY — takes no food/workout data by design) ----------
  function resolveForfeit(target, weighIns) {
    const fin = finalWeighIn(weighIns, target.participant_id, target.month_id);
    const met = fin !== null && Number(fin.weight) <= Number(target.target_weight);
    return { target_met: met, amount_owed: met ? 0 : FORFEIT_AMOUNT };
  }

  // ---------- target reset ----------
  function nextStartWeight(prevTarget, weighIns) {
    // Next month starts from this month's final (week-4) weigh-in, so
    // already-lost kilos are never re-targeted.
    if (!prevTarget) return null;
    const fin = finalWeighIn(weighIns, prevTarget.participant_id, prevTarget.month_id);
    return fin ? Number(fin.weight) : Number(prevTarget.start_weight);
  }
  function nextMonthDraft(prevMonth) {
    const starts = addDays(prevMonth.ends_on, 1);
    return { label: monthLabel(starts), starts_on: starts, ends_on: addDays(starts, WEEKS_PER_MONTH * 7 - 1) };
  }
  function monthLabel(dateStr) { return dateStr.slice(0, 7); }

  // ---------- head-to-head ----------
  function pillarStats(pid, { target, weighIns, workouts, checkins, today }) {
    return {
      weightPct: target ? weightStats(target, weighIns).pctClosed : 0,
      workoutsThisWeek: qualifyingCountInWeek(workouts, pid, today),
      foodThisWeek: onPlanCountInWeek(checkins, pid, today),
    };
  }
  function headline(mine, theirs) {
    // Pillar wins: weight % closed, this week's qualifying workouts (capped
    // at goal), this week's on-plan days. Ties broken by weight (the wager).
    let score = 0;
    score += Math.sign(mine.weightPct - theirs.weightPct);
    score += Math.sign(Math.min(mine.workoutsThisWeek, WEEKLY_WORKOUT_GOAL) - Math.min(theirs.workoutsThisWeek, WEEKLY_WORKOUT_GOAL));
    score += Math.sign(mine.foodThisWeek - theirs.foodThisWeek);
    if (score !== 0) return Math.sign(score);
    return Math.sign(mine.weightPct - theirs.weightPct);
  }

  // ---------- nudges (about the person who is behind on logging) ----------
  function nudgesFor(name, pid, { month, weighIns, workouts, checkins, today }) {
    const out = [];
    if (month && !monthEnded(month, today)) {
      const wn = currentWeekNo(month, today);
      if (wn >= 1 && wn <= weeksIn(month) &&
          !weighIns.some((w) => w.participant_id === pid && w.month_id === month.id && w.week_no === wn)) {
        out.push('⚖️ ' + name + " hasn't weighed in for week " + wn + ' yet');
      }
    }
    if (!foodMap(checkins, pid).has(today)) out.push('🍽️ ' + name + " hasn't logged food today");
    const q = qualifyingCountInWeek(workouts, pid, today);
    if (q < WEEKLY_WORKOUT_GOAL) out.push('💪 ' + name + ' is at ' + q + '/' + WEEKLY_WORKOUT_GOAL + ' workouts this week');
    return out;
  }

  // ---------- badges ----------
  const BADGE_DEFS = {
    first_5kg:         { emoji: '⚡', name: 'First 5 kg', desc: '5 kg down since day one' },
    target_hit:        { emoji: '🎯', name: 'Target hit', desc: 'Reached a monthly target' },
    perfect_food_week: { emoji: '🥗', name: 'Perfect food week', desc: '7/7 on-plan days in one week' },
    workout_week:      { emoji: '💪', name: 'Workout week', desc: '4 qualifying workouts in one week' },
    streak_7:          { emoji: '🔥', name: 'On fire ×7', desc: '7-day on-plan streak' },
    streak_30:         { emoji: '🌋', name: 'Unstoppable ×30', desc: '30-day on-plan streak' },
    comeback:          { emoji: '🦅', name: 'Comeback', desc: 'Behind at week 2, still hit the target' },
  };
  function latestWeighInEver(weighIns, pid, months) {
    const order = new Map(months.map((m) => [m.id, m.starts_on]));
    const mine = weighIns
      .filter((w) => w.participant_id === pid)
      .sort((a, b) => ((order.get(a.month_id) || '') + a.week_no).localeCompare((order.get(b.month_id) || '') + b.week_no));
    return mine[mine.length - 1] || null;
  }
  function earnedBadges(pid, otherPid, { months, targets, weighIns, checkins, workouts, today }) {
    const earned = new Set();
    const order = new Map(months.map((m) => [m.id, m.starts_on]));
    const myTargets = targets
      .filter((t) => t.participant_id === pid)
      .sort((a, b) => (order.get(a.month_id) || '').localeCompare(order.get(b.month_id) || ''));

    // first_5kg — total lost from the very first start weight
    const latestEver = latestWeighInEver(weighIns, pid, months);
    if (myTargets.length && latestEver && Number(myTargets[0].start_weight) - Number(latestEver.weight) >= 5) earned.add('first_5kg');

    // target_hit — any month where a weigh-in reached the target
    if (myTargets.some((t) => weightStats(t, weighIns).met)) earned.add('target_hit');

    if (hasPerfectFoodWeek(checkins, pid)) earned.add('perfect_food_week');
    if (hasWorkoutWeek(workouts, pid)) earned.add('workout_week');

    const best = maxFoodStreak(checkins, pid);
    if (best >= 7) earned.add('streak_7');
    if (best >= 30) earned.add('streak_30');

    // comeback — behind the partner at week 2 of a finished month, yet met target
    for (const t of myTargets) {
      const month = months.find((m) => m.id === t.month_id);
      const otherT = targets.find((x) => x.month_id === t.month_id && x.participant_id === otherPid);
      if (!month || !otherT || !monthEnded(month, today)) continue;
      if (pctAtWeek(t, weighIns, 2) < pctAtWeek(otherT, weighIns, 2) && resolveForfeit(t, weighIns).target_met) {
        earned.add('comeback');
        break;
      }
    }
    return earned;
  }

  return {
    QUALIFYING_MIN, WEEKLY_WORKOUT_GOAL, FORFEIT_AMOUNT, WEEKS_PER_MONTH, BADGE_DEFS,
    toDateStr, parseDate, addDays, daysBetween, mondayOf,
    weeksIn, currentWeekNo, monthEnded, weeksLeft, pickCurrentMonth,
    workoutQualifies, qualifyingCountInWeek, workoutWeekStreak, hasWorkoutWeek,
    foodMap, foodStreak, maxFoodStreak, onPlanCountInWeek, hasPerfectFoodWeek,
    monthWeighIns, finalWeighIn, pctClosed, weightStats, pctAtWeek,
    resolveForfeit, nextStartWeight, nextMonthDraft, monthLabel,
    pillarStats, headline, nudgesFor,
    latestWeighInEver, earnedBadges,
  };
});
