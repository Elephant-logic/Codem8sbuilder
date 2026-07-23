import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 10000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDirectory = path.join(__dirname, "public");
const indexPath = path.join(publicDirectory, "index.html");
const storageRoot = process.env.STORAGE_PATH || "/tmp/codem8s-data";
const assetDirectory = path.join(storageRoot, "assets");

await fs.mkdir(assetDirectory, { recursive: true });
app.use(express.json({ limit: "50mb" }));

const hostedBootstrap = String.raw`<script id="codem8s-hosted-runtime">
(function(){
  'use strict';
  var nativeFetch = window.fetch.bind(window);
  window.__CODEM8S_SERVER_OPENAI__ = true;

  window.fetch = function(input, init){
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/^https:\/\/api\.openai\.com\/v1\//i.test(url)) {
        var target = '/api/openai' + url.replace(/^https:\/\/api\.openai\.com/i, '');
        var options = Object.assign({}, init || {});
        var headers = new Headers(options.headers || (input && input.headers) || {});
        headers.delete('authorization');
        headers.delete('Authorization');
        options.headers = headers;
        return nativeFetch(target, options);
      }
    } catch(e) {}
    return nativeFetch(input, init);
  };

  function byId(id){ return document.getElementById(id); }
  function show(message, bad){
    try {
      var node = byId('status');
      if(node){ node.textContent = message; node.className = 'status ' + (bad ? 'err' : 'ok'); }
    } catch(e) {}
  }

  function applyServerMarker(){
    try {
      var keyInput = byId('apiKey');
      if(keyInput){
        keyInput.value = 'server-managed';
        keyInput.setAttribute('data-server-managed', 'true');
        keyInput.setAttribute('autocomplete', 'off');
      }
      if(typeof secrets !== 'undefined' && Array.isArray(secrets)){
        var existing = secrets.find(function(s){ return String(s && s.name || '').toUpperCase() === 'OPENAI_API_KEY'; });
        if(existing) existing.value = 'server-managed';
        else secrets.push({ name:'OPENAI_API_KEY', value:'server-managed', secret:true, source:'render-server' });
      }
    } catch(e) {}
  }

  async function dispatch(event){
    if(event && event.preventDefault) event.preventDefault();
    applyServerMarker();
    try {
      if(typeof askOpenAI !== 'function') throw new Error('Codem8s build engine is not ready. Reload once and try again.');
      return await askOpenAI('build');
    } catch(error) {
      var message = (error && error.message) || String(error || 'Build failed');
      show(message, true);
      console.error('Hosted build failed:', error);
      return false;
    }
  }

  function bind(){
    applyServerMarker();
    var button = byId('build');
    if(!button) return false;
    button.onclick = dispatch;
    button.setAttribute('data-wired', 'build');
    button.setAttribute('data-action', 'build');
    return true;
  }

  window.codem8sHostedBuildDispatch = dispatch;
  applyServerMarker();
  document.addEventListener('DOMContentLoaded', function(){
    bind();
    var attempts = 0;
    var timer = setInterval(function(){
      bind();
      if(++attempts >= 400) clearInterval(timer);
    }, 50);
    nativeFetch('/api/health', { cache:'no-store' }).then(function(r){ return r.json(); }).then(function(info){
      window.__CODEM8S_SERVER_OPENAI__ = !!info.openaiConfigured;
      if(!info.openaiConfigured) show('Render is running, but OPENAI_API_KEY is not configured on this service.', true);
    }).catch(function(){});
  }, true);
})();
</script>`;

async function renderIndex(response) {
  try {
    const source = await fs.readFile(indexPath, "utf8");
    const clean = source.replace(/<script id="codem8s-hosted-runtime">[\s\S]*?<\/script>/i, "");
    const html = clean.replace(/<head([^>]*)>/i, `<head$1>${hostedBootstrap}`);
    response.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    response.set("Pragma", "no-cache");
    response.set("Expires", "0");
    response.type("html").send(html);
  } catch (error) {
    console.error("Unable to load public/index.html:", error);
    response.status(500).type("text").send("Codem8s index file is missing.");
  }
}

app.get("/", async (_request, response) => renderIndex(response));
app.use(express.static(publicDirectory, { index: false, etag: false, maxAge: 0 }));

const allowedOpenAiPaths = new Set([
  "/v1/images/generations",
  "/v1/responses",
  "/v1/chat/completions"
]);

app.post("/api/openai/{*openaiPath}", async (request, response) => {
  try {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return response.status(503).json({ error: { message: "OPENAI_API_KEY is not configured on this Render service." } });
    const upstreamPath = "/" + String(request.params.openaiPath || "").replace(/^\/+/, "");
    if (!allowedOpenAiPaths.has(upstreamPath)) return response.status(404).json({ error: { message: "Unsupported OpenAI endpoint." } });
    const upstream = await fetch(`https://api.openai.com${upstreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(request.body || {})
    });
    const body = await upstream.text();
    response.status(upstream.status).type(upstream.headers.get("content-type") || "application/json").send(body);
  } catch (error) {
    console.error("OpenAI proxy failed:", error);
    response.status(500).json({ error: { message: "The server could not contact OpenAI." } });
  }
});

function safeName(value) {
  return String(value || "asset").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}
function extensionFor(mimeType) {
  return ({ "image/png":".png", "image/jpeg":".jpg", "image/webp":".webp", "image/svg+xml":".svg" })[mimeType] || ".bin";
}

app.post("/api/assets", async (request, response) => {
  try {
    const { name, mimeType, dataUrl } = request.body || {};
    if (typeof dataUrl !== "string") return response.status(400).json({ error: "Missing image data." });
    const mime = String(mimeType || "application/octet-stream");
    const buffer = Buffer.from(dataUrl.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!buffer.length) return response.status(400).json({ error: "The image is empty." });
    if (buffer.length > 20 * 1024 * 1024) return response.status(413).json({ error: "Image exceeds the 20 MB limit." });
    const baseName = safeName(name);
    const filename = `${crypto.randomUUID().slice(0, 8)}-${baseName}${path.extname(baseName) ? "" : extensionFor(mime)}`;
    await fs.writeFile(path.join(assetDirectory, filename), buffer);
    response.json({ ok:true, filename, url:`/stored-assets/${filename}`, size:buffer.length, mimeType:mime });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: "The server could not save the asset." });
  }
});

app.get("/api/assets", async (_request, response) => {
  try {
    const filenames = await fs.readdir(assetDirectory);
    response.json({ assets: filenames.map(filename => ({ filename, url:`/stored-assets/${filename}` })) });
  } catch (error) {
    response.status(500).json({ error: "The server could not list assets." });
  }
});

app.delete("/api/assets/:filename", async (request, response) => {
  try {
    await fs.unlink(path.join(assetDirectory, path.basename(request.params.filename)));
    response.json({ ok:true });
  } catch (error) {
    response.status(404).json({ error:"Asset not found." });
  }
});

app.get("/api/health", async (_request, response) => {
  const openaiConfigured = Boolean(String(process.env.OPENAI_API_KEY || "").trim());
  try {
    const probe = path.join(storageRoot, `.health-${Date.now()}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    response.set("Cache-Control", "no-store").json({ ok:true, storagePath:storageRoot, storageWritable:true, openaiConfigured });
  } catch (error) {
    response.status(500).set("Cache-Control", "no-store").json({ ok:false, storagePath:storageRoot, storageWritable:false, openaiConfigured });
  }
});

app.use("/stored-assets", express.static(assetDirectory));
app.get("/{*path}", async (_request, response) => renderIndex(response));

app.listen(port, "0.0.0.0", () => {
  console.log(`Codem8s running on port ${port}`);
  console.log(`Asset storage: ${assetDirectory}`);
  console.log(`OpenAI server key configured: ${Boolean(String(process.env.OPENAI_API_KEY || "").trim())}`);
});