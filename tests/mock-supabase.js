/* Visual-QA mock: replaces the Supabase client with canned fixtures so the
   full UI can be exercised without a network. Used only by tests/harness.html. */
(function () {
  'use strict';
  const L = window.WLCLogic;
  const today = L.toDateStr(new Date());
  const monday = L.mondayOf(today);

  // Current month started this Monday (so we're in week 1); previous month ended the day before.
  const M2 = { id: 'm2', label: L.monthLabel(monday), starts_on: monday, ends_on: L.addDays(monday, 27) };
  const M1s = L.addDays(monday, -28);
  const M1 = { id: 'm1', label: L.monthLabel(M1s), starts_on: M1s, ends_on: L.addDays(monday, -1) };

  const TONY = { id: 'p-tony', auth_uid: 'uid-tony', name: 'Tony' };
  const AMBER = { id: 'p-amber', auth_uid: 'uid-amber', name: 'Amber' };

  const fixtures = {
    participants: [TONY, AMBER],
    challenge_months: [M1, M2],
    month_targets: [
      { id: 't1', month_id: 'm1', participant_id: 'p-tony', start_weight: 100, target_weight: 96, calorie_target: null },
      { id: 't2', month_id: 'm1', participant_id: 'p-amber', start_weight: 90, target_weight: 86, calorie_target: null },
      { id: 't3', month_id: 'm2', participant_id: 'p-tony', start_weight: 95.8, target_weight: 93, calorie_target: 1800 },
      { id: 't4', month_id: 'm2', participant_id: 'p-amber', start_weight: 88, target_weight: 85, calorie_target: null },
    ],
    weigh_ins: [
      { id: 'w1', month_id: 'm1', participant_id: 'p-tony', week_no: 2, weight: 98, logged_on: M1s },
      { id: 'w2', month_id: 'm1', participant_id: 'p-tony', week_no: 4, weight: 95.8, logged_on: M1s },
      { id: 'w3', month_id: 'm1', participant_id: 'p-amber', week_no: 2, weight: 87, logged_on: M1s },
      { id: 'w4', month_id: 'm1', participant_id: 'p-amber', week_no: 4, weight: 88, logged_on: M1s },
      { id: 'w5', month_id: 'm2', participant_id: 'p-tony', week_no: 1, weight: 95.0, logged_on: today },
    ],
    workouts: [
      // Tony: 4 qualifying this week + 4 last week (streak 2)
      ...[0, 1, 2, 3].map((i) => ({ id: 'wo' + i, participant_id: 'p-tony', workout_date: L.addDays(monday, i), duration_min: 50, source: 'manual', note: i === 0 ? 'Cardio workout' : null, photo_path: i === 0 ? 'uid-tony/mock.jpg' : null })),
      ...[0, 1, 2, 3].map((i) => ({ id: 'wp' + i, participant_id: 'p-tony', workout_date: L.addDays(monday, i - 7), duration_min: 45, source: 'manual' })),
      // Amber: one sub-45 workout (doesn't count)
      { id: 'wa1', participant_id: 'p-amber', workout_date: L.addDays(monday, 1), duration_min: 40, source: 'manual' },
    ],
    food_checkins: [
      // Tony: 6 consecutive on-plan days ending yesterday (today unlogged -> at risk)
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: 'f' + i, participant_id: 'p-tony', checkin_date: L.addDays(today, -i), on_plan: true, calories: 1750 + i * 10 })),
      // Tony: a perfect week further back (for the badge)
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: 'fp' + i, participant_id: 'p-tony', checkin_date: L.addDays(monday, i - 21), on_plan: true, calories: null })),
      { id: 'fa1', participant_id: 'p-amber', checkin_date: L.addDays(today, -1), on_plan: false, calories: 2400 },
    ],
    forfeits: [
      { id: 'ff1', month_id: 'm1', participant_id: 'p-tony', target_met: true, amount_owed: 0 },
      { id: 'ff2', month_id: 'm1', participant_id: 'p-amber', target_met: false, amount_owed: 200 },
    ],
    badges: [
      { id: 'b1', participant_id: 'p-tony', badge_key: 'target_hit', unlocked_on: today },
      { id: 'b2', participant_id: 'p-amber', badge_key: 'streak_7', unlocked_on: today },
    ],
  };

  let nextId = 1000;
  function thenable(result) {
    const p = Promise.resolve(result);
    return {
      then: p.then.bind(p), catch: p.catch.bind(p),
      select: () => ({
        then: (fn) => p.then(fn),
        single: () => p.then((r) => ({ data: (r.data || [])[0] || null, error: r.error })),
      }),
    };
  }

  window.supabase = {
    createClient: () => ({
      storage: {
        from: () => ({
          upload: async () => ({ data: {}, error: null }),
          createSignedUrls: async (paths) => ({
            data: paths.map((p) => ({ path: p, signedUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="#2a2f40"/><text x="22" y="28" font-size="18" text-anchor="middle">📸</text></svg>') })),
            error: null,
          }),
        }),
      },
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'uid-tony' } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithPassword: async () => ({ error: null }),
        signOut: async () => ({ error: null }),
      },
      from: (table) => ({
        select: () => Promise.resolve({ data: fixtures[table] || [], error: null }),
        insert: (rows) => {
          const arr = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: 'x' + nextId++, ...r }));
          (fixtures[table] = fixtures[table] || []).push(...arr);
          return thenable({ data: arr, error: null });
        },
        upsert: (rows) => {
          const arr = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: 'x' + nextId++, ...r }));
          (fixtures[table] = fixtures[table] || []).push(...arr);
          return thenable({ data: arr, error: null });
        },
        delete: () => ({
          eq: (col, val) => {
            fixtures[table] = (fixtures[table] || []).filter((r) => r[col] !== val);
            return Promise.resolve({ data: null, error: null });
          },
        }),
      }),
    }),
  };
})();
