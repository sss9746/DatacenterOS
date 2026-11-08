# P2-0: Setup + booth questions
**Due:** 8:15 PM · **Status:** ☐ · **Owns:** `plans/status/P2.md`

## Goal
A working toolchain on this Mac and a SpacetimeDB identity, plus answers to the four booth questions.

## Steps (macOS; the lane file shows Windows)
```bash
git pull origin main && git checkout -b lane/p2-db
nvm install 22 && nvm use 22                 # repo needs Node 22+
corepack enable && pnpm install
pnpm -r test                                 # physics + contracts must pass
pip install jsonschema && pnpm contracts:validate
curl -sSf https://install.spacetimedb.com | sh
spacetime --version                          # expect 2.x
spacetime login && spacetime login show
cp .env.example .env.local                   # never commit
```

## Booth questions (record answers in `plans/status/P2.md`)
1. Is the Maincloud URI `wss://maincloud.spacetimedb.com`?
2. What is the reducer time limit? (matters for `advance_tick` running physics at speed 5×)
3. Can a TS module import a workspace package (`@dcos/physics`)? How is it bundled?
4. Is there a hackathon credit?

## Done when
- [x] `node -v` ≥ 22, `pnpm -r test` green, `pnpm contracts:validate` green
- [x] `spacetime login show` prints an identity
- [ ] Booth answers written in `plans/status/P2.md`

## Architect notes (Codex)

## Implementation report (Claude)
- Node 22.23.4 (nvm default), pnpm 10.29.3 via corepack; `pnpm install` OK.
- Tests: contracts 15/15, physics **92/92** (plan says 95; likely tests dropped in `13c2175` cleanup; P1's call).
- `pnpm contracts:validate`: all 6 fixtures valid.
- SpacetimeDB CLI **2.14.1** at `~/.local/bin/spacetime` (PATH added in `~/.zshrc`); logged in, identity `c2001635…0c0f6d`.
- Codex CLI 0.167.0 via `npm i -g @openai/codex` (the Codex.app binary is arm64-only; this Mac is Intel).
- `.env.local` created and git-ignored.
- Open: booth questions.
