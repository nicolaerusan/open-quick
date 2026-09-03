import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles, CliError } from "../src/cli.js";

test("collectFiles refuses listed secret-shaped files and allows explicit opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "openquick-cli-"));
  try {
    await writeFile(join(root, "index.html"), "ok");
    await writeFile(join(root, ".env"), "SECRET");
    await writeFile(join(root, "server.pem"), "KEY");
    await assert.rejects(() => collectFiles(root), (error: unknown) => {
      assert.equal((error as CliError).code, "secret_files");
      assert.match((error as Error).message, /\.env/);
      assert.match((error as Error).message, /server\.pem/);
      return true;
    });
    const files = await collectFiles(root, { allowSecrets: true });
    assert.equal(files.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collectFiles honors gitignore by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "openquick-cli-ignore-"));
  try {
    await mkdir(join(root, "build"));
    await writeFile(join(root, "index.html"), "ok");
    await writeFile(join(root, "build", "out.js"), "ignored");
    await writeFile(join(root, ".gitignore"), "build/\n");
    const files = await collectFiles(root);
    assert.deepEqual(files.map((file) => file.path), ["index.html"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
