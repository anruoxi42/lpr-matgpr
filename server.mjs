import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm"
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    if (url.pathname === "/api/mat-hdf5") {
      await handleHdf5MatRequest(req, res, url);
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(root, path.replace(/^\/+/, "")));
    if (!file.startsWith(normalize(root))) throw new Error("Bad path");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`LPR matGPR app running at http://127.0.0.1:${port}`);
});

async function handleHdf5MatRequest(req, res, url) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "POST required" }));
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), "lpr-mat-hdf5-"));
  const fileName = safeFileName(url.searchParams.get("name") || "input.mat");
  const filePath = join(tmp, fileName);
  try {
    const body = await readRequestBody(req, 256 * 1024 * 1024);
    await writeFile(filePath, body);
    const parsed = await runHdf5Reader(filePath);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(parsed);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Uploaded MAT/HDF5 file is too large for the local parser."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runHdf5Reader(filePath) {
  const helper = join(root, "scripts", "read-hdf5-mat.py");
  const python = process.env.PYTHON || "python";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [helper, filePath], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `Python h5py reader exited with code ${code}`).trim()));
    });
  });
}

function safeFileName(name) {
  const cleaned = String(name || "input.mat").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return cleaned || "input.mat";
}
