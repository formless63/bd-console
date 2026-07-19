# Upgrading bd-console

This covers two different things: keeping `bd-console` itself up to date
going forward, and the one-time migration if you're coming from the old
single-repo-server era (before the Global Hub architecture).

## Upgrading the code

Going forward, this is the whole procedure:

```bash
bd-console update
```

It detects how you installed `bd-console` and upgrades in place:

- **git-clone install** → `git pull --ff-only` in the clone. If the working
  tree is dirty, `update` refuses to touch it (no stash, no reset) — commit
  or stash your changes yourself, then re-run.
- **npm-global install** → `npm install -g
  git+https://github.com/formless63/bd-console.git`

If `bd-console` was running before the update, it's restarted afterward
through the same superseding `start` path (see below), so the new code goes
live immediately — no separate `bd-console stop && bd-console start` needed.

Use `bd-console update --dry-run` to see the detected install flavor and the
exact command(s) it would run, without running them.

### Manual equivalents

If you're jumping from a pre-hub install where `bd-console update` doesn't
exist yet (or you just want to do it by hand once), the manual steps are the
same commands `update` runs internally:

```bash
# git-clone install
cd ~/code/bd-console
git pull --ff-only
bd-console start          # restart to pick up the new code

# npm-global install
npm install -g git+https://github.com/formless63/bd-console.git
bd-console start
```

Either way, `bd-console start` always supersedes whatever was already
running (see [Supersede on start](#supersede-on-start) below), so it's safe
to just run it again after upgrading rather than manually stopping first.

## Migrating from the single-repo era

Older `bd-console` ran one server per repo, started with `bd-console start
--repo <path>` (or `$BD_CONSOLE_REPO`), with its own per-repo pid file,
log file, and (optionally) its own systemd unit. That mode is **gone**.
`bd-console` now always runs as one Global Hub per machine; individual repos
are *registered* with it instead of each running their own server.

### What replaced `--repo` / `BD_CONSOLE_REPO`

There is no `--repo` flag and no `BD_CONSOLE_REPO` env var on `bd-console`
or `bd-console start` anymore. In their place:

```bash
bd-console start           # start (or restart) the one hub for this machine
bd-console add <path>      # register a repo with the hub
bd-console add .           # register the repo at (or above) the cwd
bd-console list             # see what's registered
bd-console remove <id>      # unregister one
```

The hub keeps its registry at `~/.config/bd-console/registry.json`
(relocate with `BD_CONSOLE_CONFIG_DIR`, same as everything else global).

Note: `bd-console-init --repo <path>` (the guided per-repo setup helper)
**still** takes `--repo` — that flag was never the server flag, it just
tells the init script which repo to set up, and it now also registers that
repo with the hub for you (equivalent to calling `bd-console add <path>`
itself). Don't confuse it with the old `bd-console start --repo` server
flag, which is what's actually gone.

### Old per-repo `bd-console.json`

A per-project `bd-console.json` at a repo's root still works, but its scope
shrank: **only `docRoots` is read from it now.** Any `host`, `port`, or
`token` keys left over in an old per-repo config file are silently ignored
— those settings now live exclusively in the hub's global
`~/.config/bd-console/config.json` (see the main
[README's Configuration section](../README.md#configuration)). You don't
need to edit or strip the old file; the inert keys just do nothing. If you
want to clean it up anyway:

```json
{
  "docRoots": ["docs", ".planning"]
}
```

### Old per-repo pid/log files

The old single-repo server wrote its pid file and log to
`<repo>/.beads/console.pid` and `<repo>/.beads/console.log`. Those are
unused now (the hub's pid/log live under `~/.config/bd-console/` instead)
and are safe to delete from any repo you previously ran `bd-console start
--repo` against:

```bash
rm -f <repo>/.beads/console.pid <repo>/.beads/console.log
```

### Old per-repo systemd units

If you ever ran the old `bd-console-init --repo <path> --install-service`,
it installed a **per-repo** systemd `--user` unit named
`bd-console-<sanitized-repo-name>.service` (e.g.
`bd-console-my-project.service`). The hub now uses exactly one shared unit,
`bd-console.service`, installed automatically by `bd-console start` when
persistence is enabled (see the
[README's Persistence section](../README.md#persistence-systemd)).

Any old per-repo units are now stale duplicates competing for the same
default port. Find and remove them:

```bash
# list anything matching the old per-repo naming pattern
systemctl --user list-units 'bd-console-*.service' --all

# for each stale unit found:
systemctl --user stop bd-console-<name>.service
systemctl --user disable bd-console-<name>.service
rm -f ~/.config/systemd/user/bd-console-<name>.service
systemctl --user daemon-reload
```

Then start the new shared hub, which installs/enables the single
`bd-console.service` unit for you:

```bash
bd-console start
```

### Node 18 → 22

`bd-console` now requires **Node >=22** (the prompt scheduler uses
`node:sqlite`, which landed in Node 22). If you're upgrading a machine still
on Node 18/20, upgrade Node first — `bd-console start` will fail to boot
correctly on an older runtime.

### Supersede on start

Whatever was running before — old single-repo instance, old per-repo
systemd unit holding the port, a stale pid file — the very first
`bd-console start` you run after upgrading tears it down and replaces it:
it stops a pid-file-tracked plain daemon, stops an active systemd unit, and
as a last resort checks whether something is still answering on the
configured port and takes it over if it identifies itself as `bd-console`.
It refuses to kill a process that doesn't look like `bd-console` on that
port. See the [README's `start` semantics](../README.md#start-semantics)
for the full details. In practice this means: after upgrading, just run
`bd-console start` once — you don't need to manually hunt down and stop the
old process yourself.
