# Clank

Store AI agent files and notes in a separate git repository. Git-ignored symlinks make the files visible in your projects.

- **`clank add`** to move files to the overlay.
- **`clank link`** to connect overlay files to your project.
- **`clank unlink`** to disconnect.
- **`clank commit`** to commit changes in the overlay repository.
- **`clank check`** to show overlay status and help realign overlay files when your project restructures.

## Why a Separate Repository?

Clank stores your AI agent files (CLAUDE.md, commands, notes) in a separate git repository 
symlinks them into your project. This separation provides key advantages:

- **Different Review Cadence**: Update agent instructions, commands, and notes without requiring the same review process as production code.
- **Work on Repos You Don't Control**: Add agent context to open source projects or third-party codebases without forking or modifying.
- **Persist Knowledge Across Forks**: Keep your agent context when working across multiple forks of the same project.

## Features

- **Separate Tracking**: Agent files live in their own repository with independent version control.
- **Multi-Agent Support**: Single source file, multiple symlinks (AGENTS.md, CLAUDE.md, GEMINI.md).
- **Worktree-Aware**: Works seamlessly with git worktrees.
- **Git Ignored**: Agent files are ignored in the main repo, tracked in the overlay repo.
- **Three Scopes**: Global (all projects), Project (all branches), Worktree (this branch only).

## Installation

```bash
npm install -g clank
```

Or use directly with npx:

```bash
npx clank init
```

## Quick Start

### 1. Initialize Overlay Repository

```bash
clank init
# Creates ~/clankover with default structure
# Creates ~/.config/clank/config.js
```

### 2. Link to Your Project

```bash
cd ~/my-project
clank link
# Auto-detects project name from git
# Creates symlinks from overlay to current directory
```

### 3. Add Files with `clank add`

The `clank add` command moves files to the overlay and creates symlinks.
Agent files (CLAUDE.md, AGENTS.md) stay in place; other files go in `clank/`.

> You can run `clank add` from any subdirectory. Agent files and `clank/` folders work at any level in your project tree.

```bash
# Add to project scope (default) - shared across all branches
clank add CLAUDE.md

# Add to global scope - shared across all projects
clank add style.md --global

# Add to worktree scope - this branch only
clank add notes.md --worktree

# Add commands
clank add .claude/commands/review.md --global   # All projects
clank add .claude/commands/build.md             # This project

# Add a directory (all files inside)
clank add clank/
```

## Commands

### `clank init [overlay-path]`

Run once to create the overlay repository (default: `~/clankover`) and config file.

```bash
clank init                      # Default: ~/clankover
clank init ~/my-clankover       # Custom location
```

### `clank link [target]`

Create symlinks from the overlay's agent files and notes into your project (current project by default).

```bash
clank link              # Link current project to clank
clank link ~/my-project # Link to specific project
```

### `clank add <file> [options]`

Move a file to the overlay and replace it with a symlink.
If the file doesn't exist, an empty file is created.

**Scope Options:**

| Flag | Scope | Shared Across |
|------|-------|---------------|
| `--global` | Global | All projects |
| `--project` | Project (default) | All branches in project |
| `--worktree` | Worktree | This branch only |

**Examples:**
```bash
clank add style.md                            # Project scope (default)
clank add style.md --global                   # Global scope
clank add notes.md --worktree                 # Worktree scope
clank add .claude/commands/review.md --global # Global command
clank add .claude/commands/build.md           # Project command (default)
clank add CLAUDE.md                           # Creates agents.md + agent symlinks
```

### `clank unlink [target]`

Remove all clank symlinks from target directory.

**Example:**
```bash
clank unlink            # Unlink current directory
clank unlink ~/my-project
```

### `clank commit [-m message]`

Commit all changes in the overlay repository.

**Options:**
- `-m, --message <message>` - Commit message (default: "update")

All commits are prefixed with `[clank]` and include a summary of changed files.

**Example:**
```bash
clank commit                        # Commits with "[clank] update"
clank commit -m "add style guide"   # Commits with "[clank] add style guide"
```

### `clank check` (alias: `status`)

Check for orphaned overlay paths that don't match the target project structure.
Useful when a target project has renamed directories and the overlay needs updating.

Outputs an agent-friendly prompt to help fix mismatches.

**Example:**
```bash
clank check
# Found 2 orphaned overlay path(s):
#   notes.md (my-project)
#     Expected dir: packages/old-name
# ...
# To fix with an agent, copy this prompt:
# ──────────────────────────────────────────────────
# The following overlay files no longer match...
```

### `clank rm <files...>` (alias: `remove`)

Remove file(s) from both the overlay repository and the local project symlinks.

**Options:**
- `-g, --global` - Remove from global scope
- `-p, --project` - Remove from project scope
- `-w, --worktree` - Remove from worktree scope

If no scope is specified, clank attempts to detect it from the symlink or searches all scopes (erroring if ambiguous).

**Example:**
```bash
clank rm clank/notes.md            # Remove from whatever scope it belongs to
clank rm style.md --global         # Remove global style guide
```

### `clank mv <files...>` (alias: `move`)

Move file(s) between overlay scopes (e.g., promote a worktree file to project scope).

**Options:**
- `-g, --global` - Move to global scope
- `-p, --project` - Move to project scope
- `-w, --worktree` - Move to worktree scope

**Example:**
```bash
# Promote a worktree note to project scope
clank mv clank/notes.md --project

# Share a local command globally
clank mv .claude/commands/test.md --global
```

### `clank vscode`

Generate `.vscode/settings.json` to make clank files visible in VS Code's explorer and search, while still respecting your `.gitignore` rules.

Since clank relies on symlinked files that are git-ignored, VS Code often hides them by default. This command explicitly excludes your gitignored files in `settings.json` while un-hiding the clank folders.

**Options:**
- `--remove` - Remove the clank-generated settings

**Configuration:**
You can control this behavior via `~/.config/clank/config.js`:
```javascript
export default {
  // ...
  vscodeSettings: "auto", // "auto" (default) | "always" | "never"
  vscodeGitignore: true   // Add .vscode/settings.json to .git/info/exclude
};
```

### `clank help structure`

Show the overlay directory structure and mapping rules.

```bash
clank help structure
```

### `--config <path>` (global option)

Specify a custom config file location (default `~/.config/clank/config.js`).

```bash
clank --config /tmp/test-config.js init /tmp/test-overlay
clank --config /tmp/test-config.js link
```

## Project Symlinks

Clank places symlinks in your project referencing the relevant files in the overlay repository.

```
~/my-project/
├── CLAUDE.md                        # Agent file (→ overlay)
├── GEMINI.md                        # Same content, different name
├── .claude/commands/                # Claude commands (→ overlay)
├── clank/notes.md                   # Notes and other files (→ overlay)
└── packages/core/
    ├── CLAUDE.md                    # Package-level agent file
    ├── GEMINI.md
    └── clank/architecture.md        # Package-level notes
```

`clank link` configures git to ignore the symlinks.

### Scope Suffixes

If you add a file with the same name at different scopes (e.g., `notes.md` with both `--global` and `--worktree`), Clank distinguishes them with suffixes:

```
clank/
├── notes.md           # Global (no suffix)
├── notes-project.md   # Project
└── notes-worktree.md  # Worktree
```

## Configuration

Global configuration is stored by default in `~/.config/clank/config.js`:

```javascript
export default {
  overlayRepo: "~/clankover",
  agents: ["agents", "claude", "gemini"],
  vscodeSettings: "auto",  // "auto" | "always" | "never"
  vscodeGitignore: true
};
```

- `agents` - which symlinks to create for agent files like CLAUDE.md
- `vscodeSettings` - when to generate `.vscode/settings.json` to show clank files in VS Code
  - `"auto"` (default): only if project already has a `.vscode` directory
  - `"always"`: always generate settings
  - `"never"`: never auto-generate (you can still run `clank vscode` manually)
- `vscodeGitignore` - add `.vscode/settings.json` to `.git/info/exclude` (default: true)

By default, clank creates symlinks for AGENTS.md, CLAUDE.md, and GEMINI.md.
Run `clank unlink` then `clank link` to apply config changes.

## Worktree Templates

Customize `overlay/global/init/` to create starter notes and planning files 
for worktrees. 
When you run `clank link` in a new worktree, 
these templates are copied into your overlay.

Available placeholders:

- `{{worktree_message}}` - "This is git worktree {branch} of project {project}."
- `{{project_name}}` - Project name from git
- `{{branch_name}}` - Current branch/worktree name

## Design Principles

1. **Everything is linked, nothing is copied** - Single source of truth in overlay
2. **Git-aware** - Automatic project and worktree detection
3. **Explicit scopes** - Three clear levels: global, project, worktree
4. **Flat target structure** - All clank notes show up together in `clank/`
5. **Simple commands** - mostly `clank add` and `clank link`

## Reference

### Overlay Repository Structure

```
~/clankover/
├── global/
│   ├── clank/                # Global files (--global)
│   │   └── style.md
│   ├── prompts/              # -> .claude/prompts/, .gemini/prompts/
│   │   └── review.md
│   ├── claude/               # Claude Code specific
│   │   ├── commands/         # -> .claude/commands/
│   │   └── agents/           # -> .claude/agents/
│   ├── gemini/               # Gemini specific
│   │   └── commands/         # -> .gemini/commands/
│   └── init/                 # Templates for new worktrees
│       └── clank/
│           └── notes.md
└── targets/
    └── my-project/
        ├── agents.md         # Agent instructions (source of truth)
        ├── clank/            # Project files (--project)
        │   └── overview.md
        ├── prompts/          # -> .claude/prompts/, .gemini/prompts/
        │   └── manifest.md
        ├── claude/           # Claude Code specific
        │   ├── settings.json # -> .claude/settings.json
        │   ├── commands/     # -> .claude/commands/
        │   └── agents/       # -> .claude/agents/
        ├── gemini/           # Gemini specific
        │   └── commands/     # -> .gemini/commands/
        └── worktrees/
            ├── main/
            │   ├── clank/    # Worktree files (--worktree)
            │   │   └── notes.md
            │   ├── prompts/  # Worktree-specific prompts
            │   └── agents.md # Worktree agents file (optional)
            └── feature-auth/
                └── clank/
                    └── notes.md
```

## Requirements

- Node.js >= 22.6.0
- Git repository (for project/worktree detection)
- macOS, Linux, or [WSL](https://learn.microsoft.com/en-us/windows/wsl/install)

## License

MIT
