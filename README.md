# Clank

Universal AI assistant configuration manager with overlay repository support.

Clank manages AI assistant configuration files (CLAUDE.md, GEMINI.md, etc.) and related tooling across multiple projects and git worktrees through a centralized overlay repository with intelligent symlinking.

## Features

- **Centralized Configuration**: Store all AI assistant configs in one overlay repository
- **Git-Aware**: Automatically detects project and worktree/branch names
- **Shared by Default, Isolated When Needed**: Commands shared across worktrees, task notes isolated per-worktree
- **Multi-Variant Support**: Single source file, multiple symlinks (CLAUDE.md → GEMINI.md, copilot-instructions.md)
- **Template System**: Automatically initialize new worktrees with template files

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
# Creates ~/clank-overlay with default structure
# Creates ~/.clank.config.js
```

### 2. Link to Your Project

```bash
cd ~/my-project
clank link
# Auto-detects project name from git
# Creates symlinks from overlay to current directory
```

### 3. Add New Files

```bash
# Add CLAUDE.md to root
clank add CLAUDE.md

# Add architecture docs to shared .clank/
clank add architecture.md

# Add global command
clank add .claude/commands/review.md

# Add project-specific command
clank add .claude/commands/build.md --project
```

## Global Options

### `--config <path>`

Specify a custom config file location (useful for testing without modifying your home directory).

**Example:**
```bash
clank --config /tmp/test-config.js init /tmp/test-overlay
clank --config /tmp/test-config.js link
```

## Commands

### `clank init [overlay-path]`

Initialize a new overlay repository. Creates:
- Directory structure: `clank/{commands,agents,init}/`, `targets/`
- Default template files in `init/`
- Global config at `~/.clank.config.js`

**Example:**
```bash
clank init                      # Default: ~/clank-overlay
clank init ~/my-clank-overlay   # Custom location
```

### `clank link [target]`

Link overlay to target directory (current directory by default).

**What it does:**
- Auto-detects project name from git remote/repository
- Auto-detects branch/worktree name
- Creates overlay structure if missing
- Initializes worktree from templates if first time
- Creates all symlinks
- Merges global + project commands/agents
- Creates variant symlinks (GEMINI.md, copilot-instructions.md)

**Example:**
```bash
clank link              # Link to current directory
clank link ~/my-project # Link to specific directory
```

### `clank add <file> [--project]`

Add a new file to overlay and create symlink.

**Resolution Rules:**
- Known specials (claude.md, gemini.md) → root level
- Paths with `.claude/` → commands/agents
- Plain filenames → `.clank/` (shared docs)
- `--project` flag → project-specific (not global)

**Examples:**
```bash
clank add gemini.md                       # Root-level variant
clank add architecture.md                 # .clank/architecture.md (shared)
clank add clank/notes.md                  # Same as above
clank add .claude/commands/review.md      # Global command
clank add .claude/commands/build.md -p    # Project-specific command
```

### `clank unlink [target]`

Remove all clank symlinks from target directory.

**Example:**
```bash
clank unlink            # Unlink current directory
clank unlink ~/my-project
```

## Overlay Repository Structure

```
~/clank-overlay/
├── clank/
│   ├── commands/              # Global commands (all projects)
│   ├── agents/                # Global agents
│   └── init/                  # Template files for new worktrees
│       ├── plan.md            # Contains {{worktree_message}}
│       └── notes.md
└── targets/
    └── my-project/
        ├── CLAUDE.md          # Root-level AI instructions
        ├── GEMINI.md
        ├── bin/
        │   └── CLAUDE.md      # Directory-specific instructions
        ├── claude/
        │   ├── commands/      # Project-specific commands
        │   ├── agents/
        │   └── settings.json
        ├── clank/             # Shared project documentation
        │   └── overview.md
        └── worktrees/
            ├── main/
            │   └── clank/     # Per-worktree task notes
            │       ├── plan.md
            │       └── notes.md
            └── feature-auth/
                └── clank/
                    ├── plan.md
                    └── notes.md
```

## Target Project Structure (After `clank link`)

```
~/my-project/
├── CLAUDE.md → overlay/targets/my-project/CLAUDE.md
├── GEMINI.md → overlay/targets/my-project/CLAUDE.md (variant)
├── .claude/
│   ├── commands/
│   │   ├── global.md → overlay/clank/commands/global.md
│   │   └── project.md → overlay/targets/my-project/claude/commands/project.md
│   ├── agents/ (merged global + project)
│   └── settings.json → overlay/targets/my-project/claude/settings.json
├── .github/
│   └── copilot-instructions.md → overlay/targets/my-project/CLAUDE.md
└── .clank/
    ├── overview.md → overlay/targets/my-project/clank/overview.md
    └── worktree/
        ├── plan.md → overlay/targets/my-project/worktrees/main/clank/plan.md
        └── notes.md → overlay/targets/my-project/worktrees/main/clank/notes.md
```

## Configuration

Global configuration is stored in `~/.clank.config.js` (or `.json`, `.yaml` via cosmiconfig):

```javascript
export default {
  overlayRepo: "~/clank-overlay",
  defaultVariants: ["claude", "gemini", "copilot"]
};
```

## Template Variables

Files in `overlay/clank/init/` can use placeholders:

- `{{worktree_message}}` - "This is git worktree {branch} of project {project}" or empty
- `{{project_name}}` - Project name from git
- `{{branch_name}}` - Current branch/worktree name

## Design Principles

1. **Everything is linked, nothing is copied** - Single source of truth in overlay
2. **Git-aware** - Automatic project and worktree detection
3. **Shared by default, isolated when needed** - Commands shared, task notes isolated
4. **Mirror structure** - Overlay hierarchy mirrors target hierarchy (minus dot prefixes)
5. **Simple commands** - `link` does the heavy lifting, `add` for incremental growth

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Run locally
./bin/clank.ts --help
```

## Requirements

- Node.js >= 20.0.0
- Git repository (for project/worktree detection)

## License

MIT
