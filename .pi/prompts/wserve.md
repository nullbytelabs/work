---
description: Boot the work web console + webhook receiver and report how to reach it
argument-hint: "[--port N]"
---
Boot the long-lived `work` host over `.workflows/` (HTTP API + web console + webhook
receiver + scheduler). Steps:

1. `rm -rf dist` first. Run `./bin/work.mjs serve $@` in the background (it stays
   alive until Ctrl-C).
2. Report the printed `url`, `workspace`, `history` dir, and `auth token` so I can
   open the console. Note that `ci` is `on: webhook`, so this is how the webhook
   trigger is exercised locally.
3. If I want to drive the UI itself (styling/layout/UX of `src/web/client.ts`),
   remind me that's the **impeccable** skill's job, not ad-hoc edits.
4. When I'm done, the server is stopped with Ctrl-C (or by killing the backgrounded
   process); it closes its owned engine on shutdown.
