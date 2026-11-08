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
- [ ] `node -v` ≥ 22, `pnpm -r test` green, `pnpm contracts:validate` green
- [ ] `spacetime login show` prints an identity
- [ ] Booth answers written in `plans/status/P2.md`

## Architect notes (Codex)

## Implementation report (Claude)
