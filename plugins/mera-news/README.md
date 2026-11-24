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

**What runs:** one process per app session: the pod and its MCP server, on `127.0.0.1` only. Your
profile and picks are in `~/.mera-news-pod`. If a pod already runs for that folder, the plugin
connects to it instead of starting another.

Source-available under the PolyForm Shield License 1.0.0, see `LICENSE` at the repo root. The
`server/` files are built by `packages/bundle`; do not edit them by hand.
