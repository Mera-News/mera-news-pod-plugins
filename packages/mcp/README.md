# mera-news-pod-mcp

A plugin for mera-news-pod that serves an MCP server, so an AI app can set up your news profile and ask your pod for new picks.

## Tools

- `get_profile`: the saved facts and the topics made from them, a page at a time.
- `add_facts`: saves facts about your life. A pod with an AI service makes topics from them; without one, your assistant writes the topics and passes them with each fact.
- `remove_facts`: removes saved facts and their topics.
- `edit_topics`: removes a topic, or shows more or less of it.
- `get_suggestions`: the new picks, each a headline with its link and a one-line reason. Each pick is handed out once.
- `search_news`: searches the stored news by words and returns each match's headline, link, publisher, date and language, best first.
- `latest_news`: the newest stored news, for one country (its three-letter code, such as `GBR`) or all, a page at a time.
- `news_for_profile`: every story from the last 48 hours that matches the topics of your facts, a page at a time, with reports of one event merged. Each page has the numbers (articles read, publishers, languages, matches per topic, duplicates merged, picked and left out), the stories nobody has judged yet by fact, and the ones judged before with their reasons. A story it returns unjudged waits 72 hours before it is returned again. Only the topics go to the news server, never your facts.
- `rate_stories`: your assistant's verdict on stories from `news_for_profile`: picked, with a level and one sentence on why it matters to you, or left out, with a short reason. A story keeps its first verdict, so it is never judged twice. A pick becomes one of the pod's own picks, so `get_suggestions`, your notifications and the website show it.
- `top_stories`: the most reported stories for the world or a country, each with every publisher's link.
- `open_news_site`: a link that opens the Mera News website on this computer, once and for 10 minutes.
- `get_status`: what the pod is doing, when it reads next, when your digest is due, and any problem with its fix.
- `set_reading`: pauses or resumes reading, changes how often the pod reads, or sets when you want your digest: times of day, every so many minutes, or both.
- `digest_done`: marks a digest as shown, so the next one is due at your next chosen time.

It also offers two prompts: `set_up_profile` and `daily_digest`.

`search_news`, `latest_news`, `top_stories`, `news_for_profile` and `rate_stories` need no AI service: a pod with no `ai` in its `pod.json` serves them and the profile tools, and makes no picks of its own. Your assistant picks instead, when you ask or when your digest runs.

The digest schedule is in `digest.json` in the plugin's data folder. The verdicts, and the stories already shown, are kept by the pod in `verdicts.json` in its data folder.

## Publishers' content

Each pick links to an article on its publisher's site. The server tells the AI app that uses it to give you the headline and the link and send you to the publisher to read it, never to fetch, copy or summarise the article itself, since that may breach the publisher's copyright, and to suggest subscribing to publishers you value.

## Connect an MCP client

Build the package (`npm install`, then `npm run build`, at the root of mera-news-pod-plugins), then name it in the pod's `pod.json` and restart the pod:

```json
"plugins": [
  { "package": "/home/you/mera-news-pod-plugins/packages/mcp", "config": {} }
]
```

It listens on `http://127.0.0.1:8787/mcp`. Settings in its `config`: `port` (default 8787), `host` (default `127.0.0.1`), `publicHost` for a name reached through a tunnel or reverse proxy, and `capabilityUrl` (off by default).

A client that speaks MCP over HTTP connects to that address with the header `Authorization: Bearer <token>`. A client that only starts local servers uses the stdio bridge: `node build/bin/cli.js bridge --url http://127.0.0.1:8787/mcp`, with `--home <pod home>` when the pod does not use the default home. Setups for Claude Code, Claude Desktop and claude.ai are in the pod's [connecting a client](https://github.com/Mera-News/mera-news-pod/blob/main/docs/clients.md). The easiest way into Claude Desktop and Claude Code is the Mera News plugin in [`plugins/mera-news`](../../plugins/mera-news). ChatGPT is not supported: it needs a public HTTPS connector that signs in with OAuth, and this server takes a bearer token.

## The token

Every request needs the token in `<pod home>/data/plugins/mcp/token` (`~/.mera-news-pod/data/plugins/mcp/token` by default). It is made on first start and readable by you only. The pod never prints it. Make a new one with `node build/bin/cli.js token --rotate` (add `--home <pod home>` for another home), which prints it once.
