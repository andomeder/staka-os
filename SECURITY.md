# Security model

This document describes what Staka protects, where its trust boundaries
are, and what happens when a boundary fails. It is written for
organisational review.

## Assets

| Asset | Where it lives |
|---|---|
| Machine identity (JWT signing keys) | Org server process environment |
| Machine access tokens | Per-machine token file, root-readable |
| Hardware identity components (PII) | Org server database, restricted columns |
| Employee records, activation codes | Org server database |
| Organisational knowledge base | Retrieval engine, private network only |
| Personal agent memory | Local machine, user data directory |
| Model API key | Desktop keyring or deployment secret |
| Encrypted database backups | Backup host plus offsite copy |

## Trust boundaries

1. **Machine to org server.** Every workstation authenticates with a
   short-lived machine JWT (EdDSA, pinned algorithm, key id allowlist)
   issued after hardware-ID activation. The server checks machine status
   on every request; suspended or revoked machines are refused (with a
   60-second cache window). Activation endpoints are rate limited per IP,
   per code, and per hardware ID.
2. **User seat versus agent seat.** The agent never injects input into the
   user's physical seat. Background automation runs in an isolated nested
   compositor with its own Wayland seat on an invisible output. Browser
   automation talks to a dedicated Chromium profile over the DevTools
   protocol, never to the user's personal browser.
3. **Local process boundary.** The agent's local API, the compositor
   driver socket, and the managed browser's debug port all live inside the
   user's session runtime directory (mode 0700) or on the loopback
   interface. Anything running as the user can reach them; nothing from
   the network can. This is deliberate: on a single-user workstation the
   user's own processes are inside the trust boundary, and the surfaces
   are kept loopback-only so a network attacker gains nothing.
4. **Org boundary.** The knowledge base is scoped per organisation. Space
   identifiers are resolved server-side from the org record; request
   bodies cannot name a space, container tag, or engine id. Documents
   flagged sensitive are filtered out before they reach any agent, and
   their existence is not confirmed by document reads.

## Attack surfaces and mitigations

### Agent local API (127.0.0.1:7920)

Unauthenticated by design, loopback-only. A local process can converse
with the agent and read basic status. Mitigations: prompts are capped in
size; tool behaviour is allowlisted (fixed app list for the headless
workspace, structured reads instead of screen takeover); the agent logs
tool activity to the org server. Residual risk: a malicious process
running as the user can use the agent's capabilities - which is
equivalent to it running the tools itself, and strictly narrower than the
user's own powers.

### Compositor driver socket

Unix socket in the session runtime directory (socket mode 0600, parent
directory 0700). The wire protocol is length-prefixed frames with a hard
32 MiB cap and strict command parsing; malformed input yields an error
response, never a crash. Application launches use a fixed allowlist and
whitespace splitting - no shell interpolation. Virtual input goes only to
the nested compositor's seat, structurally unable to reach the user's
seat.

### Managed browser (CDP)

Chromium is launched with an ephemeral debug port (port 0), which binds
to loopback only, and a dedicated profile directory; personal browser
profiles are never attached. Any local process could connect to the same
debug port - accepted at the same trust level as the agent API above.
Browser tools perform DOM reads and clicks, not screenshots of the user's
desktop.

### Org server HTTP

Unauthenticated endpoints (activation, admin login) are rate limited and
return generic errors. Hardware identity components are stored in a
column the application database role cannot SELECT; viewing them requires
the admin role and every reveal is written to the audit log. Admin
sessions are server-side, CSRF-signed, and cookie flags are configurable
per deployment.

### Knowledge base

Machine JWT required; per-machine request rate limiting; queries are
always bound to the organisation's space server-side; sensitive documents
are dropped from results and hidden from direct reads; document content
returned to agents is capped in size. The retrieval engine has no public
port - only the org server can reach it.

### Backups

Database dumps are encrypted with GPG on the server before touching disk;
the private key is held off the server. Backups exclude database roles
and grants, so a restored system must re-apply them before serving
traffic (documented in the restore runbook). The restore procedure has
been executed and verified against production row counts.

## Column encryption decision (hardware identity PII)

Hardware identity components are protected today by: column-level grants
(the application role cannot read them), admin-only reveal with audit
logging, redaction in all listings, and encrypted backups. We evaluated
adding pgcrypto column encryption on top and decided against it:

- The encryption key would have to live on the same server as the
  database (process environment or secrets file), so host compromise
  yields both ciphertext and key. The realistic at-rest exfiltration path
  is backups, which are already end-to-end encrypted with an off-host
  key.
- Column encryption would remove the ability to filter or join on the
  column without decrypting everything, complicating the audit queries
  the admin dashboard depends on.
- The added key-management burden (rotation, escrow, app-side caching)
  is not justified while the database role boundary and encrypted backups
  already cover the threat.

This decision is revisited if the deployment model changes (for example,
a managed database service with server-side key management).

## Residual risks

- Single-server deployment: the org server is one VPS. Availability and
  the machine JWT signing keys share that host's fate.
- The local trust boundary assumes the workstation runs trusted software.
  Malware running as the user can do everything the agent can.
- The knowledge base inherits the sanitisation quality of the ingestion
  pipeline: documents uploaded without the sensitive flag are retrievable
  by every machine in the org.
- The rolling browser dependency (Chromium) and retrieval engine are
  upstream-supplied software; supply-chain scanning runs on every
  dependency change.

## Disclosure

Report security issues to the repository owner privately (GitHub security
advisory or direct contact). Fixes are prioritised before new features.
