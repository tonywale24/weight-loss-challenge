# Weight-Loss Challenge Tracker

A free, installable PWA for a two-person head-to-head weight-loss challenge.
Static vanilla-JS frontend (no build step) + Supabase (Postgres + Auth) + GitHub Pages. Total running cost: **£0**.

## The game

Challenge periods are variable length (created in-app with start + deciding-day dates; weeks are derived). **Current plan: three 4-week blocks, 6 Jul → 27 Sep 2026** — Block 1 is 6 Jul → 2 Aug; each block ends with a reassessment, target reset, and a £200 forfeit for whoever missed. Blocks 2/3 are created in-app via the roll-over flow (labels are "Block N"). `alter-weeks.sql` is only needed if a period ever exceeds 4 weeks; `update-workouts.sql` (run once) enables workout notes + photo proof via a private Storage bucket.

| Pillar | Rule | Money |
|---|---|---|
| **Weight** | Weekly weigh-in vs the period target | ❌ Miss the target on the deciding day → **£200 forfeit** |
| **Food** | Daily "on plan?" check-in (+ optional calories) | Bragging rights only |
| **Workouts** | ≥4 workouts of ≥45 min per ISO week (shorter ones log but don't count) | Bragging rights only |

- **Forfeit is weight-only.** Food/workout stats can never add money — `resolveForfeit()` in `logic.js` doesn't even receive that data.
- **Target reset:** the next period's start weight = this period's **final weigh-in** (highest week logged), so already-lost kilos are never re-targeted.
- **No weigh-ins at all by the deciding day = no proof = forfeit.** Weigh in.
- Streaks, badges (`first_5kg`, `target_hit`, `perfect_food_week`, `workout_week`, `streak_7`, `streak_30`, `comeback`), "who's winning" headline, and missed-check-in nudges are all derived client-side from raw logs — nothing is double-stored.

## One-time setup (5 minutes, already mostly done)

1. Supabase project with the schema + RLS SQL — **done**.
2. Two auth users (one per person) — **done**.
3. Seed the two participant rows: paste **`seed.sql`** into Dashboard → SQL Editor → Run. ← *the only step left*
4. Recommended: Dashboard → Authentication → Sign In / Up → **disable new sign-ups** (any signed-up account can read the shared scoreboard — that's the RLS design; closing sign-ups keeps it to just you two).

Then each person, on their own phone:

1. Open the app URL, sign in with their email + password.
2. Share → **Add to Home Screen** — it installs like an app.
3. Month tab → create the month, enter your start + target weight (each person sets **their own** target).

## Security model

- The Supabase URL + publishable key in `config.js` are **meant** to be public; every table is protected by Row Level Security: any signed-in user can **read** everything (shared scoreboard), but can only **write rows tagged with their own `participant_id`** (`auth_uid = auth.uid()`). That's what protects the £200 wager — never weaken it.
- Forfeit rows are written client-side, but each person can only write **their own** forfeit row, and any tampering is recomputable from raw weigh-ins (the Month tab always shows the derived truth).

## Development

- `index.html` / `styles.css` / `app.js` — UI. `logic.js` — pure game rules (no DOM/network).
- `node tests/logic.test.js` — 63 fixture tests over the game rules.
- Serve locally: `python -m http.server` or any static server (service worker needs http(s), not `file://`).
- Deploy: push to `main` → GitHub Pages serves the repo root.

## Phase 2 seams (not built, on purpose)

- **Apple Watch workouts:** Health Auto Export app → Supabase Edge Function → `workouts` with `source='apple_watch'` (the `source` column already exists).
- **Lose It CSV import:** client-side parse to fill `food_checkins`/weigh-ins. Lose It has no per-user API; export CSVs **before** cancelling any subscription.
- **Push notifications:** nudges are in-app only for now.
