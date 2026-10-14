# statusband

A Claude Code mod: a colorful status sidebar beside the transcript, or a compact view under the prompt.

Shows working/idle, model, effort, agents with tokens, repo, context, 5h and weekly limits with pace and run-out forecast, last turn, session and daily cost, burn rate.

Scripts: Claude is asked (a system prompt section) to hand you scripts as files in `.scripts/` of the working directory instead of pasting them. Each script belongs to the session that wrote it: the sidebar has a separate **Scripts** tab listing this session's newest five with **▶ run** (puts `! bash <path>` in the prompt box, Enter runs it, the output lands in the transcript) and **⧉ copy** (the file's exact text on the clipboard, no indentation). Under the prompt you get the newest one from this session; `/statusband run [name]` and `/statusband copy [name]` work everywhere. Other sessions' scripts show only as a count with **🧹 clean**, which deletes them (`/statusband clean` does the same) but spares any changed in the last 15 minutes, in case a session beside this one is using it; at session start, other sessions' scripts older than a week are deleted. `run` and `copy` still find an older session's script by its name. Closing the Scripts tab by hand keeps it closed until the next `/statusband`. The folder ignores itself in git (`.scripts/.gitignore` holds `*`).

Where it shows: a sidebar docked beside the transcript in a fullscreen terminal (`/tui fullscreen`) and in the Desktop app; a compact multi-line view under the prompt in the classic renderer, or whenever the sidebar isn't on screen. `/statusband close` hides the sidebar, `/statusband` opens it again. Opened by itself the sidebar needs a 144-column terminal (110 once you've opened it by hand).

```bash
claude plugin test .   # engine-backed tests: the trees validate on terminal and desktop
```

Layout ideas were inspired by [claude-flightdeck](https://github.com/scasella/claude-flightdeck) (MIT); no code was copied.

No network calls: data comes from the mods API, local `git`, and the plugin's own `$.store`.

## Develop

```bash
claude plugin validate .
claude --plugin-dir .      # hot-reloads on save
```

In a session, `/statusband-debug` prints the raw data the mod reads.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install statusband --marketplace hkmt-sw/statusband
```

Answer `y` to add the marketplace, then pick a scope. The repository is private: you need read access on GitHub and `gh` or git signed in on your machine.

From a shell:

```bash
claude plugin marketplace add hkmt-sw/statusband
claude plugin install statusband@statusband
```
