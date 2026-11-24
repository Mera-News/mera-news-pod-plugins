# Mera News for AI apps

News picked for what you follow, from thousands of publishers in many languages. What you follow
stays on your computer, in a Mera News Pod that this plugin starts while your AI app is open and
stops when it closes. The news comes from Mera News at `api.mera.news`, with a key from Mera Labs:
message Mera on WhatsApp or write to contact@mera.news.

It needs Node.js 22.13 or newer on macOS (Claude Desktop brings its own). Picks made while you are
away need an AI service with an OpenAI-compatible API; without one, your assistant picks for you when
you ask.

| App | Install | Key |
|---|---|---|
| Claude Desktop | Double-click `mera-news.mcpb` from the [latest release](https://github.com/Mera-News/mera-news-pod-plugins/releases) | asked at install |
| Claude Code | `/plugin marketplace add Mera-News/mera-news-pod-plugins`, then `/plugin install mera-news@mera-news` | asked at install |
| Grok Build | `grok plugin install mera-news` once listed, or add this repo as a marketplace | `secrets.json` |
| Codex | add this repo as a marketplace (`.agents/plugins/marketplace.json`) | `secrets.json` |
| OpenClaw | install the Claude plugin from this repo's marketplace | `secrets.json` |

Claude is tested by Mera Labs. Grok Build, Codex and OpenClaw follow their published formats and are
tested by the community: open an issue with what you find.

**Where the key goes outside Claude:** `~/.mera-news-pod/secrets.json`, as
`{ "dataApiKey": "<your key>" }`. The file is readable by you only.

## Your profile and your news

The first time, your assistant offers to set up your news profile: where you live, then your work,
then the news you care about, one question at a time. You can skip any of them, and it reads each
fact back and asks before saving it. Mera Labs keeps no copy of your profile. It stays on this
computer, and your assistant sees what you tell it.

Without an AI service in the pod, your assistant writes the news topics for each fact and picks the
stories itself from `news_for_profile`, with a headline, a link and one sentence on why each one
matters to you. No AI key is needed.

In Claude Code, the plugin's session start hook adds one sentence when there is no profile yet or a
digest is due. It reads two small files in `~/.mera-news-pod/data/plugins/mcp` and never shows a fact.

## Your news when you want it

Tell your assistant when you want your news. Two or three times a day works well for most people,
and any number of times, or every so many minutes, is fine. It saves your times with `set_reading`,
then sets up a scheduled task that runs the `daily_digest` prompt at those times if your app can.

- **Claude Desktop, Code tab:** a local scheduled task runs the digest on this computer. A time
  missed while the app was closed or the computer was asleep runs once when the app next opens.
- **Claude Desktop, Cowork:** a scheduled task from the Schedule card. It reaches the pod only while
  Claude Desktop is open.
- **Claude Code in a terminal:** its schedulers either run in the cloud, where they cannot reach the
  pod, or only while a session is open. When a digest is due, the next session starts with a
  sentence saying so, and `get_status` shows it.
- **Any app:** ask "what's my news?" at any time. A missed digest is due once, not once per missed time.

A scheduled run stops at the first approval prompt it meets, so allow the Mera News tools first: in
Claude Code, choose "Always allow" for them, or add `mcp__plugin_mera-news_mera-news` to
`permissions.allow`; in Claude Desktop, set the Mera News tools to "Allow always" in the connector's
settings.

## The Mera News website

The plugin also runs a website on this computer with your news, top stories and your profile. Ask
your assistant to open Mera News: it gives you a link that works once, for 10 minutes, in one browser
tab. Your assistant also offers the link when it shows you news. To turn the website off, untick
"Also run the Mera News website on this computer" in the plugin's or extension's settings and restart
the app.

**What runs:** one process per app session: the pod, its MCP server and the website, on `127.0.0.1` only. Your
profile and picks are in `~/.mera-news-pod`. If a pod already runs for that folder, the plugin
connects to it instead of starting another.

Source-available under the PolyForm Shield License 1.0.0, see `LICENSE` at the repo root. The
`server/` files are built by `packages/bundle`; do not edit them by hand.
