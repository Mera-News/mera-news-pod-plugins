# Mera News for AI apps

News picked for what you follow, from thousands of publishers in many languages. What you follow
stays on your computer, in a Mera News Pod that this plugin starts while your AI app is open and
stops when it closes, unless you [keep it running](#keep-mera-news-running-macos).

First choose where the news comes from:

- **From Mera News** (`api.mera.news`), the quickest: ask for a key with the form at
  https://mera.news/en/api-key (it arrives by email and is a test key: 2,000 requests a day, for your own use), install the plugin and paste the key into "News key".
  Never paste the key into a chat.
- **From your own news server:** set up the
  [data server](https://github.com/Mera-News/mera-news-data-server/blob/main/docs/self-host.md), then
  install the plugin and put the server's address in "News server address", and its key in "News
  key" if you set one. No key from Mera Labs.

Both end in the same place: the Mera News website and the tools in your AI app.

The Claude Desktop extension runs on macOS and brings its own Node.js; the other apps need Node.js 22.13 or newer. Picks made while
you are away need an AI service, added on the website's You page (see
[your AI service](#your-ai-service)); without one, your assistant picks for you when you ask.

| App | Status | Install | Settings |
|---|---|---|---|
| Claude Desktop | Tested (Chat tab) | Download `mera-news.mcpb` from the [latest release](https://github.com/Mera-News/mera-news-pod-plugins/releases/latest) and open it. Claude Desktop shows an install dialog. | the settings below |
| Claude Code | Tested | `/plugin marketplace add Mera-News/mera-news-pod-plugins`, then `/plugin install mera-news@mera-news` | the settings below |
| ChatGPT | Not supported | | |
| Grok Build | Built, not tested by Mera Labs | `grok plugin install mera-news` once listed, or add this repo as a marketplace | `secrets.json` |
| Codex | Built, not tested by Mera Labs | add this repo as a marketplace (`.agents/plugins/marketplace.json`) | `secrets.json` |
| OpenClaw | Built, not tested by Mera Labs | install the Claude plugin from this repo's marketplace | `secrets.json` |

The Claude Desktop install dialog, and Claude Code when it installs the plugin, ask for three settings:

- **News key** (optional): for Mera News, a key from the form at https://mera.news/en/api-key. For your own news server, the key
  you set on it (`MERA_NEWS_API_KEY`), or nothing if it needs none, as the one-computer setup does.
  A server setup in open mode, with no key, refuses search, so give it a key for the pod.
- **News server address** (optional): empty uses Mera News. An address, such as
  `http://127.0.0.1:3002`, uses a news server you run. A later change applies the next time the app
  starts.
- **Also run the Mera News website on this computer**: on by default.

ChatGPT connects only to a public HTTPS server that signs in with OAuth. Your pod runs on your
computer and takes a token, so there is no easy way to connect it today.

Grok Build, Codex and OpenClaw follow their published formats, but Mera Labs has not tested them.
Open an issue with what you find. Any other MCP client can connect through the stdio bridge or over
Streamable HTTP with the token: see [`packages/mcp`](../../packages/mcp).

**Where the settings go outside Claude:** the key in `~/.mera-news-pod/secrets.json`, as
`{ "dataApiKey": "<your key>" }`, then run `chmod 600 ~/.mera-news-pod/secrets.json`; the pod refuses the file otherwise.
Your own news server's address goes in `~/.mera-news-pod/pod.json` as `dataServer.url`, which the
plugin writes on its first run.

## Your profile and your news

The first time, your assistant offers to set up your news profile: where you live, then your work,
then the news you care about, one question at a time. You can skip any of them, and it reads each
fact back and asks before saving it. The website has no box for adding a fact: tell your assistant.
A chat with Mera inside the website is coming. You review the topics for each fact on the website's
You page. Mera Labs keeps no copy of your profile. It stays on this
computer, and your assistant sees what you tell it. If you add an AI service, that service sees
your facts too.

Without an AI service in the pod, your assistant writes the news topics for each fact and picks the
stories itself from `news_for_profile`: it reads every page, then saves a verdict on each story with
`rate_stories`, picked with one sentence on why it matters to you, or left out with a short reason.
Its picks reach your notifications and the website like the pod's own. No AI key is needed.

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

The website is where you see your news; the MCP tools only carry data to your assistant. The plugin
runs it on this computer. Ask your assistant to "open Mera News": it gives you a link that works
once, for 10 minutes, in one browser tab. Your assistant also offers the link when it shows you news.
Open tabs stay signed in when Mera News restarts; Sign out on You signs them all out. To turn the
website off, untick "Also run the Mera News website on this computer" in the plugin's or extension's
settings and restart the app.

- **Feed:** one lane for each fact. Each lane loads and scrolls on its own, with the stories picked
  and the ones left out, each with its reason and level, and the numbers at the top.
- **World:** top stories for each country, each story with the reports from every publisher.
- **Following:** the stories you follow and their timelines.
- **You:** your facts and their topics, your digest times, your AI service, Mera News on this
  computer, Appearance (light, dark or system), Keep running, Your phone and Sign out.

Click a headline to open it with the story's other reports and a Follow this story button. "Read
on" with the publisher's name takes you to the publisher's site: Mera News shows the headline and a link, never a summary. Every headline shows in
English, marked as translated, with the original under it.

**On your phone:** the same website opens on your phone through Tailscale (`tailscale serve`) or
another HTTPS tunnel. Pair the phone with the QR code on You > Your phone.

### Your AI service

An AI service is optional. Without one, your assistant writes the topics and picks the stories
through the tools. To let Mera News pick on its own, open You > AI service: pick a provider, paste
its key (kept on this computer), choose a chat model (for chat, your profile and topics) and a
relevance model (which stories are for you; a smaller, faster model works well), and choose whether
to write a reason for each story. Each model comes from the provider's own list or by name. Save
tests both models first and applies them at once, with no restart. Picking a provider fills in
suggested models.

**What runs:** one process per app session: the pod, its MCP server and the website, on `127.0.0.1` only. Your
profile and picks are in `~/.mera-news-pod`. If a pod already runs for that folder, the plugin
connects to it instead of starting another.

## Keep Mera News running (macOS)

Mera News stops when you quit your AI app. To keep it reading the news and answering your phone
after that, open the website and turn on You > Keep Mera News running. It needs Node.js
22.13 or newer on your Mac; if there is none, the page says so and shows how to install it, and
Mera News installs nothing itself.

It adds a login item, `~/Library/LaunchAgents/news.mera.pod.plist`, that runs this plugin's
`server/server.cjs serve` on the same `~/.mera-news-pod` folder, with its log in
`~/.mera-news-pod/logs/pod.log`. Your news key is saved in `~/.mera-news-pod/secrets.json` if it is
not there yet, because Claude is not there to hand it over. If you later paste a new key in the
plugin's settings and the news server refuses the saved one, the new key replaces it the next time
your AI app starts. When you next open Claude, the plugin
connects to that pod instead of starting its own. Turning the setting off removes the login item and
stops that pod. The Mac must be awake for Mera News to run. Updates still arrive through your AI
app's extension install for now. Details:
[keep it running](https://github.com/Mera-News/mera-news-pod/blob/main/docs/self-hosting.md#from-the-mera-news-plugin-on-macos).

Source-available under the PolyForm Shield License 1.0.0, see `LICENSE` at the repo root. The
`server/` files are built by `packages/bundle`; do not edit them by hand.
