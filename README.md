# Agent Deck

A **Telegram Mini App** — a control deck for your AI agents.

- **Central power core** — one big toggle to start/stop the deck; state is unmissable at a glance (standby → running with a live glow).
- **Token usage graph** — live area chart with a running total.
- **Agents** — each with a generated cartoon-robot headshot. Add new agents with a name + use case, pin favourites to the top, open any agent for details, and activate/disable individually.
- **Activity log** — a terminal-style feed; every completed task streams in with a timestamp, agent, and token cost.

Single self-contained `index.html` — no build step. Saves state to the device (localStorage). Light/dark aware and follows the Telegram theme when opened inside Telegram.

## Live

Hosted on GitHub Pages: `https://mobile-valeting.github.io/agent-deck/`

## Wire it to Telegram

1. Open **@BotFather** → your bot → **Bot Settings → Menu Button → Configure menu button** → paste the Pages URL above.
2. (Or) send a `web_app` keyboard/inline button pointing at the same URL from your bot.
3. Open the bot in Telegram and tap the menu button — the deck opens full-screen, themed to match.

## Current status

The token counts, activity log, and running state are **simulated in the browser** so the UI is fully testable today. To drive it from the real `automation-lab` agents, point it at a small endpoint on the VPS (poll or websocket) and verify Telegram `initData` server-side so only the owner can control it.
