# mera-news-pod-sync

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

## Settings the phone changes

The language (which is also the language the pod writes reasons in), Skip notes, the 24-hour filter,
the Explore choices and the topics you rejected are the pod's settings; the phone changes them through
the pod. The feed's card state stays on the phone.

The app's own backups are off while paired. Back up the pod's home folder yourself, with the pod stopped.
