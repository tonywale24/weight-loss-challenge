/* Fixture tests for the game rules in logic.js — run with: node tests/logic.test.js */
const L = require('../logic.js');

let passed = 0, failed = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name + '\n      expected ' + e + '\n      got      ' + a); }
}

const P1 = 'p1', P2 = 'p2', M1 = 'm1', M2 = 'm2';
const month1 = { id: M1, label: '2026-06', starts_on: '2026-06-01', ends_on: '2026-06-28' };
const month2 = { id: M2, label: '2026-07', starts_on: '2026-06-29', ends_on: '2026-07-26' };
const wi = (pid, mid, wk, kg) => ({ participant_id: pid, month_id: mid, week_no: wk, weight: kg, logged_on: '2026-07-01' });
const wo = (pid, date, min) => ({ participant_id: pid, workout_date: date, duration_min: min, source: 'manual' });
const fc = (pid, date, on) => ({ participant_id: pid, checkin_date: date, on_plan: on });

// ---------- ISO week helpers ----------
console.log('\n# dates / weeks');
eq(L.mondayOf('2026-07-05'), '2026-06-29', 'Sunday 5 Jul belongs to week of Mon 29 Jun');
eq(L.mondayOf('2026-06-29'), '2026-06-29', 'Monday maps to itself');
eq(L.addDays('2026-06-30', 1), '2026-07-01', 'addDays crosses month');
eq(L.mondayOf('2026-01-02'), '2025-12-29', 'year boundary handled');

// ---------- workout rule: 4x >=45min per ISO week ----------
console.log('\n# workout rule');
const wk = '2026-06-29'; // Mon..Sun 29 Jun - 5 Jul
let workouts = [wo(P1, '2026-06-29', 50), wo(P1, '2026-06-30', 45), wo(P1, '2026-07-01', 60)];
eq(L.qualifyingCountInWeek(workouts, P1, '2026-07-05'), 3, '3 qualifying workouts counted');
eq(L.qualifyingCountInWeek(workouts, P1, '2026-07-05') >= L.WEEKLY_WORKOUT_GOAL, false, '3/4 -> behind');
workouts.push(wo(P1, '2026-07-02', 44));
eq(L.qualifyingCountInWeek(workouts, P1, '2026-07-05'), 3, 'a 44-min workout does NOT count');
workouts.push(wo(P1, '2026-07-03', 45));
eq(L.qualifyingCountInWeek(workouts, P1, '2026-07-05'), 4, '4th >=45min workout -> 4 ✓');
eq(L.qualifyingCountInWeek(workouts, P2, '2026-07-05'), 0, 'other person unaffected');
// streak: last week also 4x
const lastWk = ['2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25'].map((d) => wo(P1, d, 45));
eq(L.workoutWeekStreak(workouts.concat(lastWk), P1, '2026-07-05'), 2, 'two consecutive 4x weeks -> streak 2');
eq(L.workoutWeekStreak(lastWk, P1, '2026-07-05'), 1, 'current week incomplete does not break streak');
eq(L.hasWorkoutWeek(workouts, P1), true, 'workout_week badge condition');
eq(L.hasWorkoutWeek([wo(P1, '2026-06-29', 44), wo(P1, '2026-06-30', 44), wo(P1, '2026-07-01', 44), wo(P1, '2026-07-02', 44)], P1), false, '4 sub-45 workouts never earn workout_week');

// ---------- food streaks ----------
console.log('\n# food');
const days7 = ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
let checkins = days7.map((d) => fc(P1, d, true));
eq(L.foodStreak(checkins, P1, '2026-07-05'), { length: 7, atRisk: false }, '7/7 on-plan -> streak 7');
eq(L.onPlanCountInWeek(checkins, P1, '2026-07-05'), 7, '7 on-plan days in the week');
eq(L.hasPerfectFoodWeek(checkins, P1), true, 'perfect_food_week condition met');
eq(L.hasPerfectFoodWeek(checkins.slice(0, 6), P1), false, '6/7 is not a perfect week');
eq(L.foodStreak(checkins.slice(0, 6), P1, '2026-07-05'), { length: 6, atRisk: true }, 'today unlogged -> streak stands but at risk');
eq(L.foodStreak(checkins.concat([fc(P1, '2026-07-06', false)]), P1, '2026-07-06'), { length: 0, atRisk: false }, 'off-plan today -> streak 0');
const gappy = [fc(P1, '2026-07-01', true), fc(P1, '2026-07-03', true), fc(P1, '2026-07-04', true), fc(P1, '2026-07-05', true)];
eq(L.foodStreak(gappy, P1, '2026-07-05').length, 3, 'unlogged gap breaks the chain');
eq(L.maxFoodStreak(checkins, P1), 7, 'max historical streak');

// ---------- weight, forfeit (weight ONLY), target reset ----------
console.log('\n# weight / forfeit / reset');
const t1 = { participant_id: P1, month_id: M1, start_weight: 100, target_weight: 96 };
let weighs = [wi(P1, M1, 1, 99), wi(P1, M1, 2, 98), wi(P1, M1, 3, 97.2), wi(P1, M1, 4, 96.9)];
eq(L.resolveForfeit(t1, weighs), { target_met: false, amount_owed: 200 }, 'week-4 above target -> £200');
weighs[3] = wi(P1, M1, 4, 95.8);
eq(L.resolveForfeit(t1, weighs), { target_met: true, amount_owed: 0 }, 'week-4 below target -> £0');
eq(L.resolveForfeit(t1, weighs.slice(0, 3)), { target_met: false, amount_owed: 200 }, 'no week-4 weigh-in, latest (97.2) above target -> £200');
eq(L.resolveForfeit(t1, []), { target_met: false, amount_owed: 200 }, 'no weigh-ins at all -> £200 (no proof)');
// forfeit is structurally weight-only: resolveForfeit takes no food/workout data.
const horrible = { target_met: L.resolveForfeit(t1, weighs).target_met };
eq(horrible, { target_met: true }, '0 workouts + all off-plan days cannot change a met target (weight-only forfeit)');
// target reset
eq(L.nextStartWeight(t1, weighs), 95.8, "next month's start = this month's week-4 weigh-in");
eq(L.nextStartWeight(t1, weighs.slice(0, 3)), 97.2, 'fallback: latest weigh-in when week 4 missing');
eq(L.nextStartWeight(t1, []), 100, 'fallback: prior start when no weigh-ins');
const draft = L.nextMonthDraft(month1);
eq(draft, { label: '2026-06', starts_on: '2026-06-29', ends_on: '2026-07-26' }, 'next month = 4 weeks starting day after prev end');
// progress %
const ws = L.weightStats(t1, weighs);
eq(Math.round(ws.pctClosed * 100), 105, 'pct closed can exceed 100 when past target');
eq(ws.met, true, 'met flag');
eq(L.pctClosed(100, 100, 100), 1, 'degenerate target (start==goal) guarded');
eq(L.pctClosed(90, 95, 92), 1, 'degenerate goal above start: at/below goal counts met (matches forfeit rule)');

// ---------- month timing ----------
console.log('\n# month timing');
eq(L.currentWeekNo(month1, '2026-06-01'), 1, 'day 1 -> week 1');
eq(L.currentWeekNo(month1, '2026-06-08'), 2, 'day 8 -> week 2');
eq(L.currentWeekNo(month1, '2026-06-28'), 4, 'last day -> week 4');
eq(L.currentWeekNo(month1, '2026-06-29'), 5, 'after end -> ended sentinel');
eq(L.currentWeekNo(month1, '2026-05-31'), 0, 'before start -> 0');
eq(L.weeksLeft(month1, '2026-06-08'), 3, 'weeks left includes current');
eq(L.monthEnded(month1, '2026-06-29'), true, 'ended');
eq(L.pickCurrentMonth([month1, month2], '2026-07-05').id, M2, 'picks active month');
eq(L.pickCurrentMonth([month1], '2026-07-05').id, M1, 'falls back to last ended month');

// ---------- head-to-head headline ----------
console.log('\n# leaderboard');
const me = { weightPct: 0.5, workoutsThisWeek: 4, foodThisWeek: 6 };
const them = { weightPct: 0.3, workoutsThisWeek: 2, foodThisWeek: 7 };
eq(L.headline(me, them), 1, 'winning 2 pillars of 3 -> ahead');
eq(L.headline(them, me), -1, 'mirror -> behind');
eq(L.headline(me, me), 0, 'identical -> tie');
eq(L.headline({ weightPct: 0.6, workoutsThisWeek: 2, foodThisWeek: 5 }, { weightPct: 0.2, workoutsThisWeek: 4, foodThisWeek: 7 }), -1, 'losing 2 pillars -> behind even if leading weight');
eq(L.headline({ weightPct: 0.6, workoutsThisWeek: 2, foodThisWeek: 7 }, { weightPct: 0.2, workoutsThisWeek: 4, foodThisWeek: 7 }), 1, '1-1 pillar split -> weight (the wager) breaks the tie');
eq(L.headline({ weightPct: 0.5, workoutsThisWeek: 6, foodThisWeek: 0 }, { weightPct: 0.5, workoutsThisWeek: 4, foodThisWeek: 0 }), 0, 'workouts capped at goal: 6 vs 4 is not an edge');

// ---------- nudges ----------
console.log('\n# nudges');
const bag = { month: month2, weighIns: [], workouts: [], checkins: [], today: '2026-07-05' };
const n = L.nudgesFor('Amber', P2, bag);
eq(n.some((x) => x.includes("hasn't weighed in for week 1")), true, 'weigh-in nudge');
eq(n.some((x) => x.includes("hasn't logged food today")), true, 'food nudge');
eq(n.some((x) => x.includes('0/4 workouts')), true, 'workout nudge 0/4');
const bag2 = { month: month2, weighIns: [wi(P2, M2, 1, 80)], workouts: [wo(P2, '2026-07-01', 50), wo(P2, '2026-06-30', 50), wo(P2, '2026-07-02', 50), wo(P2, '2026-07-03', 50)], checkins: [fc(P2, '2026-07-05', true)], today: '2026-07-05' };
eq(L.nudgesFor('Amber', P2, bag2), [], 'all caught up -> no nudges');

// ---------- badges ----------
console.log('\n# badges');
const months = [month1, month2];
const targets = [t1, { participant_id: P2, month_id: M1, start_weight: 90, target_weight: 87 }];
const badgeBag = { months, targets, weighIns: weighs, checkins, workouts, today: '2026-07-05' };
let earned = L.earnedBadges(P1, P2, badgeBag);
eq(earned.has('perfect_food_week'), true, 'perfect_food_week earned');
eq(earned.has('streak_7'), true, 'streak_7 earned');
eq(earned.has('workout_week'), true, 'workout_week earned');
eq(earned.has('target_hit'), true, 'target_hit earned (95.8 <= 96)');
eq(earned.has('streak_30'), false, 'streak_30 not earned at 7 days');
eq(earned.has('first_5kg'), false, 'first_5kg not earned at 4.2kg');
const bigLoss = weighs.concat([wi(P1, M2, 1, 94.9)]);
const t2 = { participant_id: P1, month_id: M2, start_weight: 95.8, target_weight: 93 };
earned = L.earnedBadges(P1, P2, { ...badgeBag, weighIns: bigLoss, targets: targets.concat([t2]) });
eq(earned.has('first_5kg'), true, 'first_5kg: 100 -> 94.9 across months = 5.1kg');
// comeback: behind at wk2, met target, month ended
const cbTargets = [t1, { participant_id: P2, month_id: M1, start_weight: 90, target_weight: 86 }];
const cbWeighs = [wi(P1, M1, 2, 99.5), wi(P1, M1, 4, 95.5), wi(P2, M1, 2, 87), wi(P2, M1, 4, 88)];
earned = L.earnedBadges(P1, P2, { months, targets: cbTargets, weighIns: cbWeighs, checkins: [], workouts: [], today: '2026-07-05' });
eq(earned.has('comeback'), true, 'comeback: behind at wk2 (12.5% vs 75%), met target at wk4');
earned = L.earnedBadges(P2, P1, { months, targets: cbTargets, weighIns: cbWeighs, checkins: [], workouts: [], today: '2026-07-05' });
eq(earned.has('comeback'), false, 'no comeback for the one who led at wk2 and missed');

// ---------- award-once diff (app-side pattern) ----------
console.log('\n# award-once');
const have = new Set(['streak_7']);
const fresh = [...new Set(['streak_7', 'perfect_food_week'])].filter((k) => !have.has(k));
eq(fresh, ['perfect_food_week'], 'already-awarded badge is not re-awarded');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
