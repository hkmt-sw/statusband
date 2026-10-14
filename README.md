# statusband

A Claude Code mod: a colorful status sidebar beside the transcript, or a compact view under the prompt.

Shows working/idle, model, effort, repo, context, 5h and weekly limits with projected use at reset (`📈 ~20% by reset`, green under 90%, amber to 110%, red above) and run-out forecast, last turn, session and daily cost, burn rate.

Agents: a separate **Agents** tab lists this session's subagents, running ones first, each with its context and output tokens, steps and time; finished ones keep their tokens (the last 20 are kept). When rows run short, rows fold so the finished ones stay in sight. The status pane keeps a one-line count of running agents. Closing the tab by hand keeps it closed until the next `/statusband`.

Scripts: Claude is asked (a system prompt section) to hand you scripts as files in `.scripts/` of the working directory instead of pasting them. Each script belongs to the session that wrote it: the sidebar has a separate **Scripts** tab listing this session's newest five with **▶ run** (puts `! bash <path>` in the prompt box, Enter runs it, the output lands in the transcript) and **⧉ copy** (the file's exact text on the clipboard, no indentation). Under the prompt you get the newest one from this session; `/statusband run [name]` and `/statusband copy [name]` work everywhere. Other sessions' scripts show only as a count with **🧹 clean**, which deletes them (`/statusband clean` does the same) but spares any changed in the last 15 minutes, in case a session beside this one is using it; at session start, other sessions' scripts older than a week are deleted. Only files Claude wrote with a file tool count as a session's: anything else in the folder is treated as yours and never deleted. `run` and `copy` still find an older session's script by its name. Closing the Scripts tab by hand keeps it closed until the next `/statusband`. The folder ignores itself in git (`.scripts/.gitignore` holds `*`), unless it already held files of your own.

Where it shows: a sidebar docked beside the transcript in a fullscreen terminal (`/tui fullscreen`) and in the Desktop app; a compact multi-line view under the prompt in the classic renderer, or whenever the sidebar isn't on screen. `/statusband close` hides the sidebar, `/statusband` opens it again. Opened by itself the sidebar needs a 144-column terminal (110 once you've opened it by hand).

```bash
claude plugin test .   # engine-backed tests: the trees validate on terminal and desktop
```

Layout ideas were inspired by [claude-flightdeck](https://github.com/scasella/claude-flightdeck) (MIT); no code was copied.

No network calls: data comes from the mods API, local `git`, and the plugin's own `$.store`.

## What it touches

- **System prompt:** adds one short section asking Claude to hand you scripts as files in `.scripts/` (see Scripts above). Nothing else in the prompt changes.
- **`.scripts/` in the working directory:** writes `.scripts/.gitignore` (`*`) when the folder holds only Claude's scripts; deletes other sessions' scripts as described above. Files Claude did not write there, and a `.scripts` that is a symbolic link, are left alone.
- **Processes:** runs `git status` and `git rev-parse` in the working directory every 15 seconds, with `core.fsmonitor` off so a repository's config cannot run a command through it. **▶ run** only fills the prompt box: nothing runs until you press Enter.
- **Files elsewhere:** `/statusband-debug` writes `statusband-debug.json` to your temp folder (`$TMPDIR`).
- **Stored data** (the plugin's `$.store`): daily cost totals for 35 days, recent limit samples, and which session wrote which script. No prompts, code or credentials.

## Requirements

Claude Code with the mods API (tested on 2.1.299). The sidebar needs the fullscreen terminal (`/tui fullscreen`) or the Desktop app; elsewhere you get the compact view.

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

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin marketplace add hkmt-sw/statusband
claude plugin install statusband@statusband
```

## License

MIT, see [LICENSE](LICENSE).
