#!/usr/bin/env -S node --experimental-strip-types

import { runCLI } from "../src/Cli.ts";

runCLI().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
