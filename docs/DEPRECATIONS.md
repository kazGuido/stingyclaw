# Deprecations

This project now treats the old skills workflow as **legacy**.

## Legacy Components

- `skills-engine/`
- `.claude/skills/`
- scripts: `apply-skill`, `update-core`, `uninstall-skill`, `rebase`, `run-migrations`

These remain for compatibility and migration support, but are not required for normal
Stingyclaw runtime operation.

## Runtime Contract

Primary runtime path is:

1. `systemctl --user enable --now stingyclaw`
2. `npm run doctor`

`npm run dev` is for local debugging only and is blocked when the service is active.

## Testing Contract

- `npm test` => full suite (core + legacy)
- `npm run test:core` => runtime-focused checks
- `npm run test:legacy` => skills-engine compatibility checks
