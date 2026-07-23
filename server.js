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

app.use(express.json({ limit: "30mb" }));

const hostedBootstrap = String.raw`<script id="codem8s-hosted-bootstrap">
(function(){
  'use strict';
  var nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    var url=typeof input==='string'?input:(input&&input.url)||'';
    if(/^https:\/\/api\.openai\.com\/v1\//i.test(url)){
      var apiPath=url.replace(/^https:\/\/api\.openai\.com/i,'');
      var headers={};
      try{
        var source=new Headers((init&&init.headers)||(input&&input.headers)||{});
        source.forEach(function(value,key){if(key.toLowerCase()!=='authorization')headers[key]=value});
      }catch(e){}
      var proxyResponse=await nativeFetch('/api/openai-proxy',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          path:apiPath,
          method:(init&&init.method)||'POST',
          headers:headers,
          body:(init&&init.body)||null
        })
      });
      var payload=await proxyResponse.text();
      return new Response(payload,{status:proxyResponse.status,headers:{'Content-Type':proxyResponse.headers.get('content-type')||'application/json'}});
    }
    return nativeFetch(input,init);
  };

  function byId(id){return document.getElementById(id)}
  function show(message,bad){try{var node=byId('status');if(node){node.textContent=message;node.className='status '+(bad?'err':'ok')}}catch(e){}}
  async function dispatch(event){
    if(event&&event.preventDefault)event.preventDefault();
    try{
      if(typeof askOpenAI!=='function')throw new Error('Codem8s build engine is not ready. Reload once and try again.');
      return await askOpenAI('build');
    }catch(error){
      var message=(error&&error.message)||String(error||'Build failed');
      show(message,true);console.error('Hosted build failed:',error);return false;
    }
  }
  window.codem8sHostedBuildDispatch=dispatch;
  function bind(){
    var button=byId('build');if(!button)return false;
    button.onclick=dispatch;button.setAttribute('data-wired','build');button.setAttribute('data-action','build');return true;
  }
  async function enableServerKey(){
    try{
      var response=await nativeFetch('/api/capabilities',{cache:'no-store'});
      var caps=await response.json();
      if(!caps.openAIAvailable)return;
      var key=byId('apiKey');
      if(key&&!String(key.value||'').trim()){
        key.value='server-managed';
        key.setAttribute('data-server-managed','true');
        key.title='OpenAI key is securely configured on the Render server.';
      }
      window.__codem8sServerOpenAI=true;
    }catch(e){console.warn('Could not check hosted OpenAI capability',e)}
  }
  document.addEventListener('DOMContentLoaded',function(){
    enableServerKey();bind();var attempts=0;
    var timer=setInterval(function(){bind();enableServerKey();if(++attempts>=80)clearInterval(timer)},100);
  },true);
})();
</script>`;

async function renderIndex(response) {
  try {
    const source = await fs.readFile(indexPath, "utf8");
    const html = source.includes("codem8s-hosted-bootstrap")
      ? source
      : source.replace(/<head([^>]*)>/i, `<head$1>${hostedBootstrap}`);
    response.type("html").send(html);
  } catch (error) {
    console.error("Unable to load public/index.html:", error);
    response.status(500).type("text").send("Codem8s index file is missing.");
  }
}

app.get("/", async (_request, response) => {
  await renderIndex(response);
});

app.use(express.static(publicDirectory, { index: false }));

app.get("/api/capabilities", (_request, response) => {
  response.json({
    ok: true,
    openAIAvailable: Boolean(process.env.OPENAI_API_KEY),
    storagePath: storageRoot
  });
});

const allowedOpenAIPaths = new Set([
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/images/generations"
]);

app.post("/api/openai-proxy", async (request, response) => {
  try {
    const key = String(process.env.OPENAI_API_KEY || "").trim();
    if (!key) return response.status(503).json({ error: { message: "OPENAI_API_KEY is not configured on Render." } });

    const requestedPath = String(request.body?.path || "");
    if (!allowedOpenAIPaths.has(requestedPath)) {
      return response.status(403).json({ error: { message: "That OpenAI endpoint is not allowed by this Codem8s server." } });
    }

    const upstreamHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    };

    const upstream = await fetch(`https://api.openai.com${requestedPath}`, {
      method: "POST",
      headers: upstreamHeaders,
      body: typeof request.body?.body === "string"
        ? request.body.body
        : JSON.stringify(request.body?.body || {})
    });

    const text = await upstream.text();
    response.status(upstream.status);
    response.set("Content-Type", upstream.headers.get("content-type") || "application/json");
    response.send(text);
  } catch (error) {
    console.error("OpenAI proxy failed:", error);
    response.status(500).json({ error: { message: "The hosted OpenAI request failed." } });
  }
});

function safeName(value) {
  return (
    String(value || "asset")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset"
  );
}

function extensionFor(mimeType) {
  const types = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/svg+xml": ".svg"
  };
  return types[mimeType] || ".bin";
}

app.post("/api/assets", async (request, response) => {
  try {
    const { name, mimeType, dataUrl } = request.body || {};
    if (typeof dataUrl !== "string") return response.status(400).json({ error: "Missing image data." });

    const mime = String(mimeType || "application/octet-stream");
    const encoded = dataUrl.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length) return response.status(400).json({ error: "The image is empty." });
    if (buffer.length > 20 * 1024 * 1024) return response.status(413).json({ error: "Image exceeds the 20 MB limit." });

    const baseName = safeName(name);
    const extension = path.extname(baseName) ? "" : extensionFor(mime);
    const filename = `${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
    await fs.writeFile(path.join(assetDirectory, filename), buffer);

    response.json({ ok: true, filename, url: `/stored-assets/${filename}`, size: buffer.length, mimeType: mime });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: "The server could not save the asset." });
  }
});

app.get("/api/assets", async (_request, response) => {
  try {
    const filenames = await fs.readdir(assetDirectory);
    response.json({ assets: filenames.map((filename) => ({ filename, url: `/stored-assets/${filename}` })) });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: "The server could not list assets." });
  }
});

app.delete("/api/assets/:filename", async (request, response) => {
  try {
    const filename = path.basename(request.params.filename);
    await fs.unlink(path.join(assetDirectory, filename));
    response.json({ ok: true });
  } catch (error) {
    response.status(404).json({ error: "Asset not found." });
  }
});

app.get("/api/health", async (_request, response) => {
  try {
    const probe = path.join(storageRoot, `.health-${Date.now()}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    response.json({ ok: true, storagePath: storageRoot, storageWritable: true, openAIAvailable: Boolean(process.env.OPENAI_API_KEY) });
  } catch (error) {
    response.status(500).json({ ok: false, storagePath: storageRoot, storageWritable: false, openAIAvailable: Boolean(process.env.OPENAI_API_KEY) });
  }
});

app.use("/stored-assets", express.static(assetDirectory));

app.get("/{*path}", async (_request, response) => {
  await renderIndex(response);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Codem8s running on port ${port}`);
  console.log(`Asset storage: ${assetDirectory}`);
  console.log(`Hosted OpenAI: ${process.env.OPENAI_API_KEY ? "configured" : "missing"}`);
});