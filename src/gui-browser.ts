#!/usr/bin/env node
// gui-browser.ts — dev fallback: run the GUI server and open it in the
// system browser (a chromeless window is not guaranteed, but this needs no
// Rust/WebKitGTK toolchain). `npm run gui` (Tauri) is the primary path.

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dir = dirname(fileURLToPath(import.meta.url));
const port = process.env.GUI_PORT || "45871";

const child = spawn(
  process.execPath,
  ["--import", "tsx", join(dir, "gui-server.ts")],
  { stdio: "inherit", env: { ...process.env, GUI_PORT: port } },
);

const url = `http://127.0.0.1:${port}`;
setTimeout(() => {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(opener, args, { stdio: "ignore", detached: true }).unref();
  } catch {}
}, 1500);

function shutdown() {
  try {
    child.kill("SIGINT");
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
