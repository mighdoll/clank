import { Command, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { defaultOverlayDir, setConfigPath } from "./Config.ts";
import { addCommand } from "./commands/Add.ts";
import { checkCommand } from "./commands/Check.ts";
import { commitCommand } from "./commands/Commit.ts";
import { filesCommand } from "./commands/Files.ts";
import { initCommand } from "./commands/Init.ts";
import { linkCommand } from "./commands/Link.ts";
import { moveCommand } from "./commands/Move.ts";
import { rmCommand } from "./commands/Rm.ts";
import { unlinkCommand } from "./commands/Unlink.ts";
import { vscodeCommand } from "./commands/VsCode.ts";

const defaultOverlayMsg = `(default: ~/${defaultOverlayDir})`;

const structureHelp = `
Clank Overlay Directory Structure
═════════════════════════════════

~/clankover/
├── global/                      # Shared across all projects
│   ├── clank/                   # Global files (--global)
│   │   └── style.md
│   ├── claude/                  # Claude Code specific
│   │   ├── commands/            # -> .claude/commands/
│   │   └── agents/              # -> .claude/agents/
│   └── init/                    # Templates for new worktrees
│       └── notes.md
└── targets/
    └── <project>/               # Per-project files
        ├── agents.md            # Agent instructions (-> CLAUDE.md, etc.)
        ├── clank/               # Project files (--project)
        │   └── overview.md
        ├── claude/              # Claude Code specific
        │   ├── settings.json    # -> .claude/settings.json
        │   ├── commands/        # -> .claude/commands/
        │   └── agents/          # -> .claude/agents/
        ├── <subdir>/clank/      # Subdirectory files (monorepo support)
        │   └── notes.md         # -> <subdir>/clank/notes.md
        └── worktrees/
            └── <branch>/        # Worktree files (--worktree)
                └── clank/
                    └── notes.md

Mapping Rules
─────────────
  Overlay Path                           Target Path
  ────────────                           ───────────
  global/clank/<file>                 -> clank/<file>
  global/claude/commands/<file>       -> .claude/commands/<file>
  targets/<proj>/clank/<file>         -> clank/<file>
  targets/<proj>/claude/commands/     -> .claude/commands/
  targets/<proj>/agents.md            -> CLAUDE.md, AGENTS.md, GEMINI.md
  targets/<proj>/<sub>/clank/<file>   -> <sub>/clank/<file>
  targets/<proj>/worktrees/<br>/clank -> clank/

Scopes
──────
  --global    Shared across all projects
  --project   Shared across all branches (default)
  --worktree  This branch only
`.trim();
export function createCLI(): Command {
  const program = new Command();

  program
    .name("clank")
    .description("Keep your AI files in an overlay repository")
    .version(pkg.version)
    .option("-c, --config <path>", `Path to config file ${defaultOverlayMsg}`)
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.optsWithGlobals();
      if (opts.config) setConfigPath(opts.config);
    });

  registerCommands(program);
  return program;
}

export async function runCLI(): Promise<void> {
  const program = createCLI();
  await program.parseAsync(process.argv);
}

function registerCommands(program: Command): void {
  registerCoreCommands(program);
  registerHelpCommands(program);
}

function registerCoreCommands(program: Command): void {
  registerOverlayCommands(program);
  registerUtilityCommands(program);
}

function registerHelpCommands(program: Command): void {
  const help = program
    .command("help")
    .description("Show help information")
    .argument("[command]", "Command to show help for")
    .action((commandName?: string) => {
      if (!commandName) return program.help();
      const subcommand = program.commands.find((c) => c.name() === commandName);
      if (subcommand) return subcommand.help();
      console.error(`Unknown command: ${commandName}`);
      process.exit(1);
    });
  help
    .command("structure")
    .description("Show overlay directory structure")
    .action(() => console.log(structureHelp));
}

function registerOverlayCommands(program: Command): void {
  program
    .command("init")
    .description(
      `Initialize a new clank overlay repository ${defaultOverlayMsg}`,
    )
    .argument(
      "[overlay-path]",
      `Path to overlay repository ${defaultOverlayMsg}`,
    )
    .action(withErrorHandling(initCommand));

  program
    .command("link")
    .description("Link overlay repository to target directory")
    .argument("[target]", "Target directory (default: current directory)")
    .action(withErrorHandling(linkCommand));

  program
    .command("add")
    .description("Add file(s) to overlay and create symlinks")
    .argument(
      "[files...]",
      "File path(s) (e.g., style.md, .claude/commands/review.md)",
    )
    .option("-i, --interactive", "Interactively add all unadded files")
    .option("-g, --global", "Add to global location (all projects)")
    .option("-p, --project", "Add to project location (default)")
    .option("-w, --worktree", "Add to worktree location (this branch only)")
    .action(withErrorHandling(addCommand));

  program
    .command("unlink")
    .description("Remove all clank symlinks from target directory")
    .argument("[target]", "Target directory (default: current directory)")
    .action(withErrorHandling(unlinkCommand));

  registerRmCommand(program);
  registerMvCommand(program);

  program
    .command("commit")
    .description("Commit all changes in the overlay repository")
    .option("-m, --message <message>", "Commit message")
    .action(withErrorHandling(commitCommand));
}

function registerUtilityCommands(program: Command): void {
  program
    .command("check")
    .alias("status")
    .description("Show overlay status and check for issues")
    .action(withErrorHandling(checkCommand));

  registerFilesCommand(program);

  program
    .command("vscode")
    .description("Generate VS Code settings to show clank files")
    .option("--remove", "Remove clank-generated VS Code settings")
    .option("--force", "Generate even if settings.json is tracked by git")
    .action(withErrorHandling(vscodeCommand));
}

function withErrorHandling<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  };
}

function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .alias("remove")
    .description("Remove file(s) from overlay and target")
    .argument("<files...>", "File(s) to remove")
    .option("-g, --global", "Remove from global scope")
    .option("-p, --project", "Remove from project scope")
    .option("-w, --worktree", "Remove from worktree scope")
    .action(withErrorHandling(rmCommand));
}

function registerMvCommand(program: Command): void {
  const cmd = program
    .command("mv")
    .alias("move")
    .description("Move or rename file(s) in overlay")
    .argument("<files...>", "File(s) to move");

  cmd.addOption(
    new Option("-g, --global", "Move to global scope").conflicts([
      "project",
      "worktree",
    ]),
  );
  cmd.addOption(
    new Option("-p, --project", "Move to project scope").conflicts([
      "global",
      "worktree",
    ]),
  );
  cmd.addOption(
    new Option("-w, --worktree", "Move to worktree scope").conflicts([
      "global",
      "project",
    ]),
  );
  cmd.action(withErrorHandling(moveCommand));
}

function registerFilesCommand(program: Command): void {
  const files = program
    .command("files")
    .alias("list")
    .description("List clank-managed files (paths relative to cwd)")
    .argument(
      "[path]",
      "Limit to this directory/subtree (relative to cwd; default: repo root)",
    )
    .option("--hidden", "Include files under dot-prefixed directories")
    .option("--depth <n>", "Max depth under clank/ directories")
    .option("-0, --null", "NUL-separate output paths")
    .option("--no-dedupe", "Disable deduplication");

  files.addOption(
    new Option(
      "-g, --global",
      "Only include linked files from global scope",
    ).conflicts(["project", "worktree"]),
  );
  files.addOption(
    new Option(
      "-p, --project",
      "Only include linked files from project scope",
    ).conflicts(["global", "worktree"]),
  );
  files.addOption(
    new Option(
      "-w, --worktree",
      "Only include linked files from worktree scope",
    ).conflicts(["global", "project"]),
  );
  files.addOption(
    new Option(
      "--linked-only",
      "Only include symlinks into the overlay",
    ).conflicts(["unlinkedOnly"]),
  );
  files.addOption(
    new Option(
      "--unlinked-only",
      "Only include non-overlay files/symlinks",
    ).conflicts(["linkedOnly"]),
  );

  files.action(withErrorHandling(filesCommand));
}
