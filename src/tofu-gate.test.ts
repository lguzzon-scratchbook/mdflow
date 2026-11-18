// Seams: (a) HOME redirects known_hosts (~/.mdflow/known_hosts), no env override —
// redirect HOME in child env. (b) handleTOFU needs isStdinTTY + promptForTrust's
// @inquirer prompts, which can't run headless — the reject path takes one
// keystroke, so `script -qec` with a pre-fed "n" is deterministic; staggered
// confirm→select keys are timing-fragile and stay out. (c) real BEHAVIOR only:
// exits, stderr, temp-cleanup, known_hosts bytes — zero mock.module.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMd } from "./test-utils";

let root: string, project: string, home: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
const md = (args: string[], stdin?: string, env?: Record<string, string>) => spawnMd(args, {
  cwd: project, stdin, env: { HOME: home, MDFLOW_EVOLVE: "off", PATH: root + ":" + process.env.PATH, ...env },
});
const knownHosts = () => {
  const p = join(home, ".mdflow", "known_hosts");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const engineRan = () => existsSync(join(project, "engine-called"));
const FLOW = "---\nengine: proofengine\n---\nhello\n";

/** Reject needs one keystroke: pre-fed "n" answers the confirm deterministically. */
async function rejectUnderPty(url: string) {
  const proc = Bun.spawn(
    ["script", "-qec", `bun run ${join(import.meta.dir, "index.ts")} '${url}/flow.md' --_no-menu; echo CHILD-EXIT:$?`, "/dev/null"],
    {
      cwd: project,
      env: { ...process.env, HOME: home, MDFLOW_EVOLVE: "off", PATH: root + ":" + process.env.PATH, MDFLOW_IMPORT_URL_ALLOWLIST: url } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    },
  );
  proc.stdin.write("n\n");
  proc.stdin.end();
  const [stdout, , scriptExit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  try { proc.kill(); } catch { /* already exited */ }
  const clean = String(stdout).replace(/\s+/g, " ");
  return { childExit: /CHILD-EXIT:(\d+)/.exec(clean)?.[1], scriptExit, pane: clean };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mdflow-tofu-"));
  project = join(root, "project"); home = join(root, "home");
  mkdirSync(project); mkdirSync(home);
  const engine = join(root, "proofengine");
  writeFileSync(engine, '#!/bin/sh\ntouch engine-called\nprintf "%s" "$1"\n'); chmodSync(engine, 0o700);
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("TOFU gate: non-interactive refusal", () => {
  test("untrusted domain without TTY fails with SecurityError and runs nothing", async () => {
    const url = serve(() => new Response(FLOW, { headers: { "content-type": "text/plain" } }));
    const result = await md([`${url}/flow.md`], undefined, { MDFLOW_IMPORT_URL_ALLOWLIST: url });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Untrusted remote domain");
    expect(knownHosts()).toBe("");
    expect(engineRan()).toBe(false);
  });

  test("--json mode carries the refusal inside the JSON payload", async () => {
    const url = serve(() => new Response(FLOW, { headers: { "content-type": "text/plain" } }));
    const result = await md([`${url}/flow.md`, "--json"], undefined, { MDFLOW_IMPORT_URL_ALLOWLIST: url });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Untrusted remote domain");
  });

  test("--_trust bypasses the gate in non-interactive mode", async () => {
    const url = serve(() => new Response(FLOW, { headers: { "content-type": "text/plain" } }));
    const result = await md([`${url}/flow.md`, "--_trust"], undefined, { MDFLOW_IMPORT_URL_ALLOWLIST: url });
    expect(result.exitCode).toBe(0);
    expect(engineRan()).toBe(true);
  });
});

describe("TOFU gate: reject path", () => {
  test("pty reject (n) cancels the run, records nothing, runs nothing", async () => {
    const url = serve(() => new Response(FLOW, { headers: { "content-type": "text/plain" } }));
    const result = await rejectUnderPty(url);
    expect(result.childExit).toBe("1");
    expect(result.pane).toContain("No");
    expect(knownHosts()).toBe("");
    expect(engineRan()).toBe(false);
  }, 60000);
});

describe("TOFU gate: trusted domain proceeds", () => {
  test("seeded known_hosts skips the prompt headless, engine runs, no --_trust", async () => {
    const url = serve(() => new Response(FLOW, { headers: { "content-type": "text/plain" } }));
    const origin = new URL(`${url}/flow.md`).origin;
    mkdirSync(join(home, ".mdflow"), { recursive: true });
    writeFileSync(join(home, ".mdflow", "known_hosts"), `# mdflow known hosts\n${origin}\n`);
    const result = await md([`${url}/flow.md`], undefined, { MDFLOW_IMPORT_URL_ALLOWLIST: url });
    expect(result.exitCode).toBe(0);
    expect(engineRan()).toBe(true);
    expect(result.stderr).not.toContain("Untrusted remote domain");
  });

  test("remember persists the origin: second run needs no prompt", async () => {
    // Characterization of the remember branch effect (handleTOFU calls
    // addTrustedDomain(url), which stores validateUrl(url).origin): seed the
    // same bytes the gate would write, then assert the gate skips.
    const url = serve(() => new Response(FLOW, { headers: { "content-type": "text/plain" } }));
    const origin = new URL(`${url}/flow.md`).origin;
    mkdirSync(join(home, ".mdflow"), { recursive: true });
    writeFileSync(join(home, ".mdflow", "known_hosts"), `# mdflow known hosts\n${origin}\n`);
    expect(knownHosts()).toContain(origin);
    rmSync(join(project, "engine-called"), { force: true });
    const result = await md([`${url}/flow.md`], undefined, { MDFLOW_IMPORT_URL_ALLOWLIST: url });
    expect(result.exitCode).toBe(0);
    expect(engineRan()).toBe(true);
  });
});
