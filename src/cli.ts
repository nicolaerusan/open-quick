#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { DeployFile } from "./types.js";

type Config = { site?: string; host?: string };
const ignored = new Set([".git", "node_modules", ".DS_Store", "openquick.json"]);

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function config(directory: string): Promise<Config> {
  try { return JSON.parse(await readFile(join(directory, "openquick.json"), "utf8")) as Config; }
  catch { return {}; }
}

export async function collectFiles(directory: string): Promise<DeployFile[]> {
  const root = resolve(directory);
  const files: DeployFile[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({
        path: relative(root, absolute).replaceAll("\\", "/"),
        content: (await readFile(absolute)).toString("base64"),
      });
    }
  }
  await visit(root);
  return files;
}

async function init(directory: string): Promise<void> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const defaultSite = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "my-site";
  const configPath = join(root, "openquick.json");
  if (!(await stat(configPath).catch(() => null))) {
    await writeFile(configPath, `${JSON.stringify({ site: defaultSite }, null, 2)}\n`, { flag: "wx" });
  }
  const indexPath = join(root, "index.html");
  if (!(await stat(indexPath).catch(() => null))) {
    await writeFile(indexPath, `<!doctype html><meta name="viewport" content="width=device-width"><title>${defaultSite}</title><style>body{font:24px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#c9ff38}</style><h1>It works. Make it yours.</h1>\n`, { flag: "wx" });
  }
  console.log(`Initialized ${root}`);
}

async function deploy(directory: string, args: string[]): Promise<void> {
  const root = resolve(directory);
  const local = await config(root);
  const site = option(args, "--site") ?? local.site;
  const host = (option(args, "--host") ?? process.env.OPENQUICK_HOST ?? local.host)?.replace(/\/$/, "");
  const token = option(args, "--token") ?? process.env.OPENQUICK_TOKEN;
  if (!site) throw new Error("Choose a site with --site or openquick.json");
  if (!host) throw new Error("Set OPENQUICK_HOST or pass --host");
  if (!token) throw new Error("Set OPENQUICK_TOKEN or pass --token");
  const files = await collectFiles(root);
  const response = await fetch(`${host}/api/v1/sites/${encodeURIComponent(site)}/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ files }),
    redirect: "error",
  });
  const body = await response.json() as { url?: string; error?: string; site?: { releaseId?: string } };
  if (!response.ok) throw new Error(body.error ?? `Deploy failed (${response.status})`);
  console.log(`Deployed ${files.length} file${files.length === 1 ? "" : "s"} to ${body.url}`);
  if (body.site?.releaseId) console.log(`Release ${body.site.releaseId}`);
}

const args = process.argv.slice(2);
const command = args[0];
try {
  if (command === "init") await init(args[1] ?? ".");
  else if (command === "deploy") await deploy(args[1] && !args[1].startsWith("--") ? args[1] : ".", args.slice(1));
  else {
    console.log(`OpenQuick\n\n  openquick init [directory]\n  openquick deploy [directory] --site <slug> [--host <url>]\n\nEnvironment: OPENQUICK_HOST, OPENQUICK_TOKEN`);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "OpenQuick command failed");
  process.exitCode = 1;
}
