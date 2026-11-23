# mera-news-pod-sync

**Pairing the Mera News app with a pod is not available yet.** This package holds the pod's side of it.

A plugin for mera-news-pod that a paired phone talks to. It serves the pod's tables, runs the app's
changes, and passes model and news requests through, all behind a device token.

The plugin speaks plain HTTP. Put a tunnel or a reverse proxy in front of it for HTTPS, and set
`publicHost` to the name the app reaches the pod at.

Settings in the plugin's section of `pod.json`: `host` (default `127.0.0.1`), `port` (default 8788),
`publicHost` and `podName`.

## One phone per pod

A pod is for one person and pairs with one phone. A paired phone sees the whole profile, the chats sent
through the pod and the reading, so a second pairing is refused while a phone is paired (`already_paired`).
An assistant connected through the `mcp` plugin is not a paired phone and works alongside it.

## Pairing

Run `mera-news-pod-sync pair --base https://<publicHost>` on the pod's machine. It prints a code and a
link for the app. The code has 10 characters, works once and lasts 10 minutes. After 10 wrong codes in
total, or 5 tries in a minute, pairing is refused until a new code is printed.

While a phone is paired, `pair` prints no code. `mera-news-pod-sync devices` shows the paired phone and
`devices --revoke <id>` removes it; then `pair` works again.

Pairing erases the phone's own data, and the phone then shows only what the pod holds. A phone never
sends its profile to the pod.

## Notifications on the phone

**Notifications on the phone are not available yet.**

When `notify.meraNewsApp` is on in `pod.json`, the plugin shows new top stories on the paired phone through Mera's sign-in service. See [notifications on the phone](https://github.com/Mera-News/mera-news-pod/blob/main/docs/sync.md#notifications-on-the-phone) in the pod's docs for what Mera, Expo and Apple or Google receive.

- The phone hands over its pass with `POST /push-pass` `{ "capability", "expiresAt" }`, and `{}` takes it back. The pass is kept in `push-pass.json`, readable only by you, and goes only to the origin in `pod.json`, over https. Revoking the phone deletes it, and so does starting the pod with the notifier off.
- For a new `emergency` or `high` story, the plugin posts `{ "capability", "title", "pickId" }` to `/api/pod/notify` on that origin. `title` is the cleaned headline, at most 200 characters, and `pickId` is the story's id, which the app opens. A headline with a web address in it is skipped.
- At most one notification every 15 minutes; an emergency story goes at once. Each story is sent once, with at most one retry: `notified.json` remembers the last 100 for 7 days, so a restart does not send one again.
- A 401 or 410 deletes the pass, and the app hands over a new one the next time it syncs. A 429 with a short wait, a 5xx or no answer is tried once more; a longer 429 keeps the plugin quiet until it ends.
- `GET /status` shows `appNotifications` (`off`, `needs_pass` or `on`) and `relayOrigin`.

A lost phone keeps getting notifications until you revoke it with `mera-news-pod-sync devices --revoke <id>`, which also deletes its pass.

## Settings the phone changes

The language (which is also the language the pod writes reasons in), Skip notes, the 24-hour filter,
the Explore choices and the topics you rejected are the pod's settings; the phone changes them through
the pod. The feed's card state stays on the phone.

The app's own backups are off while paired. Back up the pod's home folder yourself, with the pod stopped.
