# mera-news-pod-mcp

A plugin for mera-news-pod that serves an MCP server, so an AI app can set up your news profile and ask your pod for new picks.

## Tools

- `get_profile`: the saved facts and the topics made from them, a page at a time.
- `add_facts`: saves facts about your life; the pod makes topics from them.
- `remove_facts`: removes saved facts and their topics.
- `edit_topics`: removes a topic, or shows more or less of it.
- `get_suggestions`: the new picks, each a headline with its link and a one-line reason. Each pick is handed out once.
- `get_status`: what the pod is doing, when it reads next, and any problem with its fix.
- `set_reading`: pauses or resumes reading, or changes how often the pod reads.

It also offers two prompts: `set_up_profile` and `daily_digest`.

## Publishers' content

Each pick links to an article on its publisher's site. The server tells the AI app that uses it to give you the headline and the link and send you to the publisher to read it, never to fetch, copy or summarise the article itself, since that may breach the publisher's copyright, and to suggest subscribing to publishers you value.

## Connect an MCP client

Build the package (`npm install` at the root of mera-news-pod-plugins), then name it in the pod's `pod.json` and restart the pod:

```json
"plugins": [
  { "package": "/home/you/mera-news-pod-plugins/packages/mcp", "config": {} }
]
```

It listens on `http://127.0.0.1:8787/mcp`. Settings in its `config`: `port` (default 8787), `host` (default `127.0.0.1`), `publicHost` for a name reached through a tunnel or reverse proxy, and `capabilityUrl` (off by default).

A client that speaks MCP over HTTP connects to that address with the header `Authorization: Bearer <token>`. A client that only starts local servers uses the stdio bridge: `node build/bin/cli.js bridge --url http://127.0.0.1:8787/mcp`, with `--home <pod home>` when the pod does not use the default home. Setups for Claude Code, Claude Desktop and claude.ai are in the pod's [connecting a client](https://github.com/Mera-News/mera-news-pod/blob/dev/docs/clients.md).

## The token

Every request needs the token in `<pod home>/data/plugins/mcp/token` (`~/.mera-news-pod/data/plugins/mcp/token` by default). It is made on first start and readable by you only. The pod never prints it. Make a new one with `node build/bin/cli.js token --rotate` (add `--home <pod home>` for another home), which prints it once.
