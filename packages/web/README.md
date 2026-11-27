# mera-news-pod-web

The Mera News website for your pod: your news, top stories and your profile, in your browser. It is
the only view of your pod outside the app; the MCP plugin only carries data. The pod serves it on
`127.0.0.1` only. A phone reaches it through an HTTPS tunnel (see [on your phone](#on-your-phone)).

It has four tabs:

- Feed: one lane for each of your facts, with everything that matched it in the last 48 hours, what
  was picked and why, and what was left out and why, each with its level. Each lane loads and
  scrolls on its own. A bar on each lane fills as your assistant or the pod judges stories. Stories
  nobody has judged yet are marked "Not judged yet". The numbers at the top add up the lanes. The
  Feed only shows stories: it never changes what your assistant is given next.
- World: top stories for the world or any country, each as a full-coverage story with the reports
  from other publishers, and search.
- Following: the stories you follow and each one's timeline.
- You: your facts and their topics to review, when your assistant shows your digest, your AI
  service, Mera News on this computer, Appearance (light, dark or system), Keep running, Your phone
  and Sign out.

Clicking a headline opens Mera's article detail with the story's other reports and Follow this
story. "Read on" with the publisher's name goes to the publisher's site. Every headline shows in
English with a translated mark and the original under it.

Facts are added by talking to Mera, which asks you to confirm each one. Today that is your assistant;
a chat with Mera inside the website is coming. The website has no box for adding a fact.

## Your AI service

An AI service is optional. Without one, your assistant writes the topics and picks the stories
through the MCP tools. To add one, open You > AI service:

- Pick a provider: Anthropic, OpenAI, OpenRouter, Google Gemini, Mistral, Groq, or Other for any
  service with a chat completions API.
- Paste its key. The key is written to the pod's `secrets.json` on this computer and never shown
  again.
- Choose a chat model (chat, your profile and topics) and a relevance model (which stories are for
  you; a smaller, faster model works well), from the provider's own list or by name.
- Choose whether to write a reason for each story.

Save tests both models first, then applies the service at once, with no restart. Picking a provider fills in
suggested models. For Anthropic,
`claude-sonnet-5-5` for chat and `claude-haiku-5-5` for relevance work well. Only this computer can
change the AI service, never a phone.

## Opening it

The site opens from a link that works once, for 10 minutes, in one browser tab:

- With the Mera News plugin or extension in an AI app, ask your assistant to open Mera News. It
  calls the `open_news_site` tool for the link.
- With a pod you run yourself, run `mera-news-pod-web link --home <your pod folder>`.

A new tab needs a new link. An open tab stays signed in when the pod restarts, until it goes 12 hours
unused. To sign out every tab, use Sign out on the You page, or stop the pod and delete
`sessions.json` from the web plugin's data folder.

## On your phone

The site never listens beyond `127.0.0.1`. To open it on a phone, forward HTTPS for one name to it
with Tailscale (`tailscale serve`, the default) or another HTTPS tunnel, and enter that name on You >
Your phone. Then pair the phone with the QR code shown there. Up to 10 phones can pair. Changing the
name, or turning phone access off, removes every paired phone.

## Keep running (macOS)

You > Keep Mera News running adds a login item, so the pod runs without the AI app. It needs Node.js
22.13 or newer, which Mera News does not install for you. That pod reads its news key from
`secrets.json`: the app's key is saved there when there is none, and replaces a saved key the news
server refuses the next time the app starts. Updates still arrive through the AI app's extension
install for now.

## In pod.json

```json
{ "package": "mera-news-pod-web", "config": { "port": 8790 } }
```

Put it after the `mcp` plugin. `port` defaults to 8790. When the port is taken, the site takes a free
one and writes it to `address.json` in its data folder, where the link command reads it.

## What it allows

- Only requests addressed to `127.0.0.1:<port>` or `localhost:<port>`, and from that origin, or a
  phone's request forwarded over HTTPS for the name set on You > Your phone.
- `GET` and `HEAD` for the pages, `POST` with a JSON body of up to 64 KiB for the API. No other
  method, and no other site can call it.
- The pages run only their own scripts. Publishers' images load over https; nothing else is
  fetched from another host.

The site shows headlines and links to the publishers' sites. Each article belongs to the publisher
that reported it and is protected by copyright: read it on the publisher's own site, and subscribe to
the ones you value.

## Building

`npm run build` compiles the plugin (`src/`) and exports the site (`site/`, a Next.js app) to
`site/out`, which the plugin serves. `notices.json` lists every package whose code reaches the
browser, for the licence notices that ship with the AI app plugin.
