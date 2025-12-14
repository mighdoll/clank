import { exec as execCallback, execFile } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execCallback);
export const execFileAsync = promisify(execFile);
