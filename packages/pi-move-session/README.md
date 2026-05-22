# Move Session for Pi (`pi-move-session`)

Losslessly move a live Pi session to a different working directory and jump into the new session. Useful when you need a session to move to a different working directory after it's already built up valuable context.

## Install

From npm:

```bash
pi install npm:pi-move-session
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/move-session.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

```
/move-session <targetCwd>
/move-session-auto on|off|status
```

Supports `~` expansion (e.g. `/move-session ~/code/my-project`).

Use `/move-session $main-worktree` from a Git linked worktree to move the session back to the repository's main worktree.

Automatic cwd detection is opt-in. Enable it for the current Pi process with `/move-session-auto on`, or at startup with:

```bash
PI_MOVE_SESSION_AUTO_CWD=1 pi
```

When enabled, the extension probes `bash` tool calls, strips the probe marker from the result, and moves the session after the current agent turn if the command's final `$PWD` differs from Pi's cwd. It also intercepts user `!cd <path>` commands and moves the session directly instead of running a no-op child-shell `cd`.

If your current `/tree` selection is not the session file's default branch tip, the extension warns before proceeding because that selection is not preserved yet.

## How it works

1. Forks the current session JSONL into the target cwd's session bucket via `SessionManager.forkFrom()`
2. Clears the fork header's `parentSession` pointer
3. Tears down the parent's terminal state (Kitty keyboard protocol, bracketed paste, cursor visibility)
4. Spawns a new `pi --session <fork>` process in the target directory with inherited stdio
5. Trashes the old session file (via `trash` if available; never permanently deletes)
6. Destroys the parent's stdin so it can't steal keypresses from the child

The parent process stays alive as an inert wrapper that forwards the child's exit code.

Automatic mode adds a per-tool-call cwd probe to `bash` commands and delays the move until `agent_end`, so the current tool result is recorded before relaunch.
