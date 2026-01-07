# Clank

Store AI agent files and notes in a separate git repository. Git-ignored symlinks make the files visible in your projects.

Common commands:
- **`clank add`** to move files to the overlay.
- **`clank rm`** to remove files from the overlay.
- **`clank link`** to connect overlay files to your project.
- **`clank commit`** to commit changes in the overlay repository.
- **`clank check`** to show overlay status and find misaligned files.
- **`clank files`** to list clank-managed files for piping into tools like `rg`.

## Why a Separate Repository?

Clank stores your AI agent files (CLAUDE.md, commands, notes) in a separate git repository and symlinks them into your project. This separation provides key advantages:

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

```bash
clank init                    # Create overlay repository (~/.clankover)
cd ~/my-project
clank link                    # Connect project to overlay
clank add CLAUDE.md           # Add agent file (creates symlinks)
clank add notes.md --global   # Add global file (shared across projects)
```

Agent files (CLAUDE.md, AGENTS.md, GEMINI.md) stay in place; other files go in `clank/`. You can run `clank add` from any subdirectory.

## Commands

### Scope Options

Several commands (`add`, `rm`, `mv`) accept scope flags to specify where files are stored:

| Flag | Scope | Shared Across |
|------|-------|---------------|
| `--global`, `-g` | Global | All projects |
| `--project`, `-p` | Project (default) | All branches in project |
| `--worktree`, `-w` | Worktree | This branch only |

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

Move a file to the overlay and replace it with a symlink. If the file doesn't exist, an empty file is created. Accepts [scope options](#scope-options).

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

### `clank files [path]`

List clank-managed files in the current repo as paths relative to your current directory (useful for `xargs rg` workflows).

By default, this includes `clank/` files and agent files (`AGENTS.md`, etc.), but excludes dot-prefixed directories like `.claude/` and `.gemini/`. Use `--hidden` to include those.

**Options:**
- `--hidden` - Include files under dot-prefixed directories (`.claude/`, `.gemini/`)
- `--depth <n>` - Max depth under `clank/` directories (e.g. `--depth 1` includes `*/clank/*.md` but excludes `*/clank/*/*.md`)
- `-0, --null` - NUL-separate output paths (recommended when piping to `xargs`)
- `--no-dedupe` - Disable deduplication of agent files and prompts
- `--linked-only` - Only include symlinks into the overlay
- `--unlinked-only` - Only include non-overlay files/symlinks
- `--global|--project|--worktree` - Only include linked files from that scope (implies `--linked-only`)

**Examples:**
```bash
clank files -0 | xargs -0 rg "TODO"
clank files --depth 1
clank files --hidden | rg '^\\.claude/'
clank files .               # Only this directory/subtree (relative to cwd)
```

### `clank rm <files...>` (alias: `remove`)

Remove file(s) from both the overlay repository and the local project symlinks. Accepts [scope options](#scope-options); if omitted, clank detects the scope from the symlink.

**Example:**
```bash
clank rm clank/notes.md            # Remove from whatever scope it belongs to
clank rm style.md --global         # Remove global style guide
```

### `clank mv <files...>` (alias: `move`)

Move file(s) between overlay scopes. Requires one [scope option](#scope-options) to specify the destination.

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

See [Configuration](#configuration) for `vscodeSettings` and `vscodeGitignore` options.

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
  vscodeGitignore: true,
  ignore: [".obsidian", "*.bak"]
};
```

- `agents` - which symlinks to create for agent files like CLAUDE.md; also controls which agent file/prompt path is preferred for `clank files` output when deduping.
- `vscodeSettings` - when to generate `.vscode/settings.json` to show clank files in VS Code
  - `"auto"` (default): only if project already has a `.vscode` directory
  - `"always"`: always generate settings
  - `"never"`: never auto-generate (you can still run `clank vscode` manually)
- `vscodeGitignore` - add `.vscode/settings.json` to `.git/info/exclude` (default: true)
- `ignore` - glob patterns to skip in the overlay (e.g., `[".obsidian", "*.bak", ".DS_Store"]`).

By default, clank creates symlinks for AGENTS.md, CLAUDE.md, and GEMINI.md.
Run `clank unlink` then `clank link` to apply config changes.

## Worktree Templates

Customize `global/init/clank/` in your overlay to create starter notes and planning files for new worktrees. When you run `clank link` in a new worktree, these templates are copied into the worktree's overlay directory.

Available placeholders:

- `{{worktree_message}}` - "This is git worktree {branch} of project {project}."
- `{{project_name}}` - Project name from git
- `{{branch_name}}` - Current branch/worktree name

## Design Principles

1. **Everything is linked, nothing is copied** - Single source of truth in overlay
2. **Git-aware** - Automatic project and worktree detection
3. **Explicit scopes** - Three levels: global, project, worktree
4. **Flat target structure** - All notes show up together in `clank/`

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
