import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://47.99.163.144:${port}`;
const uploadDir = process.env.UPLOAD_DIR ?? join(process.cwd(), "uploads");

const mimeToExt = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

const extToMime = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);

await mkdir(uploadDir, { recursive: true });

createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      send(response, 204, "");
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/uploads/")) {
      await serveUploadedFile(request.url, response);
      return;
    }

    if (request.method !== "POST" || request.url !== "/upload") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const body = await readJson(request);
    const contentType = typeof body.content_type === "string" ? body.content_type : "image/png";
    const rawBase64 = typeof body.base64 === "string" ? body.base64 : "";
    if (!rawBase64) {
      sendJson(response, 400, { error: "Missing base64" });
      return;
    }

    const safeExt = (mimeToExt.get(contentType) ?? extname(String(body.filename ?? ""))) || ".png";
    const filename = `${Date.now()}-${randomUUID()}${safeExt}`;
    const filePath = join(uploadDir, filename);

    await writeFile(filePath, Buffer.from(rawBase64, "base64"));

    sendJson(response, 200, {
      url: `${publicBaseUrl.replace(/\/$/, "")}/uploads/${filename}`
    });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
}).listen(port, host, () => {
  console.log(`Upload API listening on http://${host}:${port}/upload`);
  console.log(`Public base URL: ${publicBaseUrl}`);
  console.log(`Upload dir: ${uploadDir}`);
});

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) {
        request.destroy(new Error("Request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  send(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

async function serveUploadedFile(url, response) {
  const parsedUrl = new URL(url, "http://localhost");
  const filename = basename(decodeURIComponent(parsedUrl.pathname));

  if (!filename || filename === "." || filename === "..") {
    sendJson(response, 400, { error: "Invalid filename" });
    return;
  }

  const ext = extname(filename).toLowerCase();
  const contentType = extToMime.get(ext);
  if (!contentType) {
    sendJson(response, 415, { error: "Unsupported file type" });
    return;
  }

  try {
    const file = await readFile(join(uploadDir, filename));
    send(response, 200, file, contentType);
  } catch (error) {
    sendJson(response, 404, { error: "File not found" });
  }
}

function send(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": contentType
  });
  response.end(body);
}
