# Stingyclaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers, providing:
- **Process isolation** — Container processes cannot affect the host
- **Filesystem isolation** — Only explicitly mounted directories are visible
- **Non-root execution** — Runs as unprivileged `node` user (uid 1000) when host is not root
- **Ephemeral containers** — Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** — Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.stingyclaw/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session Isolation

Each group has isolated sessions at `data/sessions/{group}/.stingyclaw/sessions/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Secrets passed via stdin only** — never written to disk, never mounted as files:
```typescript
container.stdin.write(JSON.stringify({ ...input, secrets: readSecrets() }))
container.stdin.end()
delete input.secrets  // removed from memory immediately
```

**Allowed credentials (read from `.env`, passed via stdin):**
```
GEMINI_API_KEY
OPENROUTER_API_KEY
MODEL_NAME
OPENROUTER_BASE_URL
```

**NOT mounted or passed:**
- WhatsApp session (`store/auth/`) — host only, never inside containers
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns

The agent can access API keys via `process.env` during its run, but they are not written to any mounted path.

### 6. Workflow Script Security

Workflows are shell scripts in `groups/{name}/workflows/`. They run inside the container (same sandbox as Bash tool calls). The agent can only run scripts that exist in the mounted group folder — it cannot upload or create arbitrary scripts via tool calls unless `Write` access is used (which is intentional and expected for the main group).

For non-main groups with `nonMainReadOnly`, the workflow directory is read-only, preventing agents in those groups from modifying or adding scripts.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Writable | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| Tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering (secrets via stdin only)                  │
│  • Error notifications                                            │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, secrets via stdin
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution (model-agnostic loop)                          │
│  • Bash commands (sandboxed, no host access)                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted — needed for API calls)           │
│  • Cannot modify security config                                  │
│  • Cannot access WhatsApp auth                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Known Limitations

- **Network access is unrestricted** inside the container. An agent could make arbitrary outbound connections. Mitigation: container runs as non-root, no host network privileges.
- **API keys are accessible to the agent** via `process.env` during its run. The agent could theoretically exfiltrate them via network calls. Mitigation: keys have limited scope (model inference only, no billing/admin access).
- **Prompt injection** via WhatsApp messages is possible in theory. Mitigation: only registered groups are processed, and the main group is private (self-chat).
