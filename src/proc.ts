/** Process spawning with friendly errors (used by ffmpeg wrappers). */
import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnFile(cmd: string, args: string[], timeoutMs = 120_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new Error(`failed to launch "${cmd}": ${(err as Error).message}`));
      return;
    }
    let stdout = "", stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { child.kill("SIGKILL"); }
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(`"${cmd}" not found or failed to start (${err.message}). ` +
        `Is it installed and on PATH?`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0 || code === null) resolve({ code: code ?? 0, stdout, stderr });
      else reject(new Error(`"${cmd}" exited with code ${code}. stderr tail: ${stderr.slice(-400)}`));
    });
  });
}
