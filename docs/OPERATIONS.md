# Operations

## Service vs Dev

### `systemd` service (`stingyclaw.service`)

Use this for production/stable operation.

- auto-start on login/reboot
- automatic restart policy
- centralized logs in `logs/stingyclaw.log` and `logs/stingyclaw.error.log`
- expected mode for daily use

### `npm run dev`

Use this only for local debugging and active development.

- runs `tsx src/index.ts` directly
- not managed by systemd
- should not run at the same time as service mode

The `predev` guard prevents accidental dual-run conflicts.

## Runbook

- Health snapshot: `npm run doctor`
- Strict health gate: `npm run health:check`
- Restart service: `systemctl --user restart stingyclaw`
