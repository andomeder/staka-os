# Staka demo walkthrough

The full scenario: a figure selected in the Staka-managed Chromium
dashboard moves into a spreadsheet on the invisible headless workspace,
a related local report is read (sandboxed), a named colleague is
resolved from the org directory, the result is delivered and logged,
and the interaction is remembered. The user's display never changes
hands.

Not CI. Rehearse twice: once dry, once recorded.

## Preconditions

- [ ] Org server reachable (prod `https://org.staka.cc` or local `http://127.0.0.1:8080`) and the machine is active in the admin dashboard
- [ ] Agent daemon running: `systemctl --user status staka-agent`; panel opens on Super+A (`CTRL ALT, A` inside QEMU)
- [ ] Compositor driver available for the headless step: `staka-compositor` running in the Hyprland session (check `compositor_status`)
- [ ] Chromium installed (system package)
- [ ] Staka-managed browser profile dir exists at `$XDG_DATA_HOME/staka/browser` (created on first `browser_open`)
- [ ] Agent allowlist includes a report dir: `STAKA_FS_ALLOWLIST` set (or the demo report staged via `test/demo/run-walkthrough.ts`)
- [ ] Colleague exists in the org directory (e.g. `John Mwangi` with a known employee id)

## Script

1. Open the demo dashboard in the Staka-managed browser:
   ask the agent "open the dashboard at file:///.../test/demo/demo-dashboard.html"
   or run `browser_open` with that URL. The dashboard is visible on the
   user's display in an app-mode window.
2. Select the headline figure ("Q3 revenue: 4.82M KES") with the mouse.
3. Press the panel keybind and type:
   "pull this figure into a spreadsheet and send it to John with the Q3 report file."
4. The agent (narrate the ladder as it works):
   - `browser_get_selection` -> captures exactly the selected text (structured access, no screenshot reading)
   - `compositor_status` / `compositor_start_app { app: "spreadsheet" }` -> LibreOffice Calc opens on the invisible headless output; the user's cursor and windows never move
   - `compositor_type` -> the figure lands in a cell; `compositor_screenshot` verifies state
   - `fs_read_file` -> reads the allowlisted report, audited server-side
   - `org_users_search { query: "John" }` -> resolves the colleague
   - `org_deliver` -> delivery recorded; admin dashboard shows the row under Deliveries
   - `memory` -> the interaction is remembered for future sessions
5. Show the admin dashboard: machine active, usage log, delivery row.

Runner (drive the same chain from a terminal, useful for rehearsal and
recording without the panel):

```bash
ORG_URL=... TOKEN=... bun test/demo/run-walkthrough.ts
```

## Failure drills (run each once; the agent must report honestly)

- [ ] Browser closed: kill Chromium, then ask the agent to read the selection -> it reports `browser_unreachable` and offers `browser_open`; no invented result
- [ ] No selection: clear the selection and ask again -> `empty_selection`; the agent asks the user to select
- [ ] Missing element: ask for a click on `#does-not-exist` -> `selector_not_found`
- [ ] Disallowed path: ask to read `/etc/passwd` -> `path_denied` (audited)
- [ ] Compositor down: stop the driver -> the agent reports it and finishes the delivery as text (org API + CDP + delivery + memory still work)
- [ ] Ambiguous colleague: two "John"s in the directory -> the agent lists candidates and asks, no guessing

## Record

| Field | Value |
|---|---|
| Date | |
| Machine | |
| Org server | |
| Steps ok / degraded / failed | |
| Video path | |
| Notes | |
