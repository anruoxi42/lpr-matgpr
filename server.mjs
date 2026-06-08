import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const fdtdJobs = new Map();
let fdtdCapabilitiesCache = null;
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
    if (url.pathname === "/api/fdtd/capabilities") {
      await handleFdtdCapabilities(req, res);
      return;
    }
    if (url.pathname === "/api/fdtd/jobs" || url.pathname.startsWith("/api/fdtd/jobs/")) {
      await handleFdtdJobRequest(req, res, url);
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

async function handleFdtdCapabilities(req, res) {
  if (req.method !== "GET") {
    json(res, 405, { error: "GET required" });
    return;
  }
  if (!fdtdCapabilitiesCache || Date.now() - fdtdCapabilitiesCache.checkedAt > 30_000) {
    fdtdCapabilitiesCache = { ...(await runFdtdCapabilities()), checkedAt: Date.now() };
  }
  json(res, 200, fdtdCapabilitiesCache);
}

async function handleFdtdJobRequest(req, res, url) {
  const match = url.pathname.match(/^\/api\/fdtd\/jobs\/?([^/]*)\/?([^/]*)$/);
  const jobId = match?.[1] || "";
  const action = match?.[2] || "";
  if (url.pathname === "/api/fdtd/jobs" && req.method === "POST") {
    await createFdtdJob(req, res, url);
    return;
  }
  if (!jobId) {
    json(res, 404, { error: "FDTD job not found" });
    return;
  }
  const job = fdtdJobs.get(jobId);
  if (!job) {
    json(res, 404, { error: "FDTD job not found" });
    return;
  }
  if (req.method === "GET" && action === "result") {
    await sendFdtdResult(job, res);
    return;
  }
  if (req.method === "GET" && !action) {
    json(res, 200, publicJob(job));
    return;
  }
  if (req.method === "DELETE" && !action) {
    cancelFdtdJob(job, "Canceled by user.");
    json(res, 200, publicJob(job));
    return;
  }
  json(res, 405, { error: "Unsupported FDTD job request" });
}

async function createFdtdJob(req, res, url) {
  const tmp = await mkdtemp(join(tmpdir(), "lpr-fdtd-"));
  const jobId = randomUUID();
  const inputPath = join(tmp, "input.bin");
  const outputPath = join(tmp, "result.json");
  const job = {
    id: jobId,
    status: "queued",
    progress: 0,
    detail: {},
    error: "",
    tmp,
    inputPath,
    outputPath,
    startedAt: Date.now(),
    child: null
  };
  fdtdJobs.set(jobId, job);
  try {
    const body = await readRequestBody(req, 1024 * 1024 * 1024);
    await writeFile(inputPath, body);
    startFdtdChild(job, url);
    json(res, 202, { jobId, status: job.status });
  } catch (error) {
    job.status = "failed";
    job.error = error.message || String(error);
    scheduleFdtdCleanup(job);
    json(res, 500, publicJob(job));
  }
}

function startFdtdChild(job, url) {
  const helper = join(root, "scripts", "fdtd_engine.py");
  const python = process.env.PYTHON || "python";
  const child = spawn(python, [helper, "--input", job.inputPath, "--output", job.outputPath], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    windowsHide: true
  });
  job.child = child;
  job.status = "running";
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let index;
    while ((index = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (Number.isFinite(Number(event.progress))) job.progress = Math.max(0, Math.min(1, Number(event.progress)));
        job.detail = event;
      } catch {
        job.detail = { message: line };
      }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", error => {
    job.status = "failed";
    job.error = error.message || String(error);
    scheduleFdtdCleanup(job);
  });
  child.on("close", code => {
    job.child = null;
    if (job.status === "canceled") {
      scheduleFdtdCleanup(job);
      return;
    }
    if (code === 0) {
      job.status = "done";
      job.progress = 1;
      job.finishedAt = Date.now();
      scheduleFdtdCleanup(job, 10 * 60_000);
    } else {
      job.status = "failed";
      job.error = (stderr || stdout || `Python FDTD exited with code ${code}`).trim();
      scheduleFdtdCleanup(job);
    }
  });
}

async function sendFdtdResult(job, res) {
  if (job.status !== "done") {
    json(res, 409, publicJob(job));
    return;
  }
  try {
    const body = await readFile(job.outputPath, "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  } catch (error) {
    json(res, 500, { error: error.message || String(error) });
  }
}

function cancelFdtdJob(job, reason) {
  job.status = "canceled";
  job.error = reason;
  try { job.child?.kill("SIGTERM"); } catch {}
  scheduleFdtdCleanup(job);
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    detail: job.detail,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

function scheduleFdtdCleanup(job, delayMs = 30_000) {
  if (job.cleanupTimer) return;
  job.cleanupTimer = setTimeout(async () => {
    fdtdJobs.delete(job.id);
    await rm(job.tmp, { recursive: true, force: true });
  }, delayMs);
}

function runFdtdCapabilities() {
  const helper = join(root, "scripts", "fdtd_engine.py");
  const python = process.env.PYTHON || "python";
  return new Promise(resolve => {
    const child = spawn(python, [helper, "--capabilities"], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      resolve({ available: false, error: "Python FDTD capability check timed out." });
    }, 8000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ available: false, error: error.message || String(error) });
    });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ available: false, error: (stderr || stdout || `Python exited with code ${code}`).trim() });
      }
    });
  });
}

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

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function safeFileName(name) {
  const cleaned = String(name || "input.mat").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return cleaned || "input.mat";
}
