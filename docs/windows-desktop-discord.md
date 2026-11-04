# Windows desktop control via WTAgent

**Status:** prototype / requires an unlocked interactive Windows desktop and live Windows acceptance testing. This layer is intentionally stacked on the independent Discord reliability fixes. It is not enabled on a Linux/macOS host.

## Data and control path

1. A Discord message from an allowlisted user/channel creates a task through the bearer-authenticated loopback Supervisor.
2. The WTAgent web model (for example ChatGPT) receives a tool catalog that includes desktop operations only on Windows.
3. \`desktop.observe\` requests the owner's one-time approval, captures all visible monitors via a fixed local PowerShell helper, scales the screenshot to at most 1600 px, and saves it under \`.wtagent/desktop-captures/\` in the selected workspace.
4. The AgentRuntime verifies the screenshot is a regular file inside the workspace and no larger than 8 MiB, then attaches it as an actual image to the following web-model tool-result message. No screenshot bytes are saved in Supervisor's event stream or pushed into Discord.
5. The model interprets that visual attachment. \`desktop.click\` uses **preview-image coordinates**, automatically mapping them to the physical multi-monitor desktop, including negative monitor origins. \`desktop.type\` and \`desktop.hotkey\` target the currently focused application.
6. Every desktop action is individually approved through Discord, including observation, **even when an existing WTAgent session had "always allow" enabled**.
7. The runtime persists non-read desktop input as a side effect before execution, and uncertain outcomes are not automatically replayed.

The PowerShell helper accepts only four predefined actions and a Base64-encoded JSON argument payload. It never executes arbitrary scripts supplied by the model or Discord. Native commands are restricted to known Windows APIs/SendKeys. There is no public HTTP desktop port.

## Tool catalog

| Tool | Input | Result |
| --- | --- | --- |
| \`desktop.observe\` | No arguments | screenshot attached to next web-model message |
| \`desktop.click\` | \`x\`, \`y\`, \`button=left/right\`, \`clicks=1/2\` | sends mouse click in latest screenshot-preview coordinates |
| \`desktop.type\` | \`text\` up to 500 characters | types into focused application without touching clipboard |
| \`desktop.hotkey\` | \`combo\` e.g. \`CTRL+L\`, \`ALT+TAB\`, \`CTRL+S\` | sends a supported modifier/key combination |

Screenshots and GUI actions are sensitive: don't approve observation of password managers, banking screens, one-time codes, confidential work data, or other private applications. Do not use \`desktop.type\` for passwords or tokens (the text is sent through a model-visible tool call and subprocess arguments). All click/type/hotkey outcomes must be verified with a new observation or independent app evidence. Windows UAC secure desktop, lock screen, and elevated application input are not supported.

## Acceptance test on Windows (unmerged)

1. Ensure the original code is backed up and the interactive desktop is unlocked. Use the desktop feature branch in a separate clean checkout; do **not** switch branches beneath an active WTAgent Worker.
2. Run \`npm run check\` and \`node --test test/desktop-tools.test.js\`. The latter includes a PowerShell parser test on Windows.
3. Start WTAgent Supervisor from the same interactive user session as DiscordBOT. Confirm a Discord \`诊断\` command succeeds.
4. In Discord, ask: "先截图看看桌面布局，不要点击任何东西". Review and approve the \`desktop.observe\` request. Verify the web model actually receives the screenshot; mere creation of a PNG is **not** sufficient.
5. Ask to open Notepad using the allowed terminal tool, then observe, click a blank text area, type a harmless test phrase, and observe again. Approve each operation. Verify screenshot coordinates line up at different DPI and monitor layouts.
6. Pause during a GUI action and check the next task status. If the input outcome is uncertain, never retry the same click/type automatically. Test Discord reconnect after a non-destructive task; do not test destructive actions.
7. Confirm captured images remain in the selected workspace, not in Supervisor events or the Discord task ledger. Remove screenshots when no longer needed.

## Remaining roadmap

- Durable per-goal planner and verification loop integrated into the Supervisor API; the existing CLI DurableOrchestrator is **not** yet invoked by Discord tasks.
- Window targeting by stable process/window identity, screenshot freshness IDs, richer accessible UI element inspection, and app-specific adapters.
- Better health/incident surfacing for browser send uncertainty and model-provider access challenges.
- Explicit workspace and external system permissions; no unchecked email, payments, deletions, publishing, system settings changes or credential transfer.
- Windows acceptance and multi-provider attachment compatibility tests before merging or deploying.

This implementation provides an initial visual desktop control primitive, **not** guaranteed autonomous end-to-end PC operation.
