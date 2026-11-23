/**
 * `parawatch run watch`: a command as a declared run. The run starts before the command, its
 * output counts as beats (so a command that goes quiet past the heartbeat shows as stalled), and
 * it ends with the command, failed when the command fails. One call instead of start, a wait and
 * an end the agent has to remember.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { beatRun, endRun } from "./ops.js";

/** Runs `command`, keeping run `id` in step with it; resolves to the command's exit code. */
export function watchCommand(id: string, command: string[], heartbeat?: number): Promise<number> {
  const [file, ...args] = command;
  if (!file) {
    endRun(id, "failed", "no command was given");
    return Promise.resolve(2);
  }
  // beats are throttled: often enough for the heartbeat, rarely enough to keep the log small
  const every = heartbeat ? Math.max(5, heartbeat / 3) * 1000 : 0;
  let last = Date.now();
  const beat = () => {
    if (!every || Date.now() - last < every) return;
    last = Date.now();
    try {
      beatRun(id);
    } catch {
      // a beat that fails is not a reason to stop the command
    }
  };

  const start = (shell: boolean): ChildProcess =>
    spawn(file, args, { stdio: ["inherit", every ? "pipe" : "inherit", every ? "pipe" : "inherit"], shell, windowsHide: true });

  return new Promise((resolve) => {
    let child = start(false);
    let retried = false;
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const attach = (c: ChildProcess) => {
      c.stdout?.on("data", (d: Buffer) => {
        process.stdout.write(d);
        beat();
      });
      c.stderr?.on("data", (d: Buffer) => {
        process.stderr.write(d);
        beat();
      });
      c.on("error", (err: NodeJS.ErrnoException) => {
        // on Windows a .cmd (npm, npx) only starts through the shell
        if (err.code === "ENOENT" && process.platform === "win32" && !retried) {
          retried = true;
          child = start(true);
          attach(child);
          return;
        }
        finish(127, `could not start ${file}: ${err.message}`);
      });
      c.on("exit", (code, signal) => {
        if (code === 0) finish(0);
        else finish(code ?? 1, signal ? `stopped by ${signal}` : `exit code ${code}`);
      });
    };
    let done = false;
    const finish = (code: number, why?: string) => {
      if (done) return;
      done = true;
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      endRun(id, code === 0 ? "done" : "failed", why);
      resolve(code);
    };
    attach(child);
  });
}
