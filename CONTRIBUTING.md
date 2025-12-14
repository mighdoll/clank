# Contributing to Clank

## Development Setup

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests with UI
pnpm test:ui

# Type check
pnpm run typecheck

# Lint
pnpm run lint

# Lint and auto-fix
pnpm run fix

# Run locally
./bin/clank.ts --help

# Install local version globally
pnpm install --global $PWD
```

## Project Structure

```
src/
├── Cli.ts           # Command-line interface setup
├── Config.ts        # Configuration loading (cosmiconfig)
├── Git.ts           # Git context detection (project, worktree, branch)
├── Mapper.ts        # Path mapping between overlay and target
├── Linker.ts        # Overlay file walking utilities
├── FsUtil.ts        # Filesystem utilities (symlinks, directory walking)
├── Templates.ts     # Worktree template initialization
├── Exclude.ts       # Git exclude file management
├── AgentFiles.ts    # Agent file classification and validation
└── commands/
    ├── Init.ts      # clank init
    ├── Link.ts      # clank link
    ├── Add.ts       # clank add
    ├── Unlink.ts    # clank unlink
    ├── Commit.ts    # clank commit
    └── Check.ts     # clank check
```

## Key Concepts

### Scopes

Clank uses three scopes for organizing files:

- **Global** (`--global`): Shared across all projects, stored in `overlay/global/`
- **Project** (`--project`, default): Shared across all branches of a project, stored in `overlay/targets/<project>/`
- **Worktree** (`--worktree`): Specific to a branch/worktree, stored in `overlay/targets/<project>/worktrees/<branch>/`

### Path Mapping

The `Mapper.ts` module handles bidirectional mapping between overlay paths and target paths:

- `overlayToTarget()`: Maps overlay file paths to their symlink location in the target
- `targetToOverlay()`: Maps target paths back to their overlay location (used by `clank add`)

### Agent Files

Agent files (CLAUDE.md, AGENTS.md, GEMINI.md) get special handling:

- Stored as `agents.md` in the overlay
- Multiple symlinks created in project pointing to the same `agents.md` in overlay
- Tracked files in git are skipped (not replaced with symlinks). This lets advanced users track some agent files in the project and others in the overlay.

## Testing

Tests are written with Vitest and located in the `test/` directory.

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test -- --watch

# Run specific test file
pnpm test test/Mapper.test.ts
```

## Requirements

- Node.js >= 22.6.0
- pnpm (see `packageManager` in package.json for exact version)
