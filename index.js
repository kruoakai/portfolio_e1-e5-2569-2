const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.ESP32_API_KEY;
const maxBodyBytes = 4096;

if (!apiKey) {
  throw new Error("ESP32_API_KEY must be set before starting the API.");
}

let wifiConfig = null;
let wifiStatus = {
  state: "not_configured",
  message: null,
  updatedAt: null,
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function isAuthorized(request) {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) return false;

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(apiKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
        tooLarge = true;
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function validWifiConfig(body) {
  if (!body || typeof body.ssid !== "string" || typeof body.password !== "string") {
    return false;
  }

  const ssidBytes = Buffer.byteLength(body.ssid, "utf8");
  const passwordBytes = Buffer.byteLength(body.password, "utf8");
  const validPassword =
    body.password.length === 0 ||
    (passwordBytes >= 8 && passwordBytes <= 63) ||
    /^[\da-fA-F]{64}$/.test(body.password);

  return (
    ssidBytes >= 1 &&
    ssidBytes <= 32 &&
    !/[\u0000-\u001f\u007f]/.test(body.ssid) &&
    validPassword
  );
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  try {
    if (request.method === "POST" && url.pathname === "/api/wifi/config") {
      if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
        sendJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }

      const body = await readJson(request);
      if (!validWifiConfig(body)) {
        sendJson(response, 400, {
          error: "Provide an SSID (1-32 UTF-8 bytes) and a valid Wi-Fi password.",
        });
        return;
      }

      wifiConfig = { ssid: body.ssid, password: body.password };
      wifiStatus = { state: "pending", message: null, updatedAt: new Date().toISOString() };
      sendJson(response, 202, { ok: true, state: "pending" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wifi/config") {
      sendJson(response, 200, { config: wifiConfig });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/wifi/status") {
      if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
        sendJson(response, 415, { error: "Content-Type must be application/json." });
        return;
      }

      const body = await readJson(request);
      const allowedStates = ["connecting", "connected", "failed"];
      if (!body || !allowedStates.includes(body.state)) {
        sendJson(response, 400, {
          error: "state must be connecting, connected, or failed.",
        });
        return;
      }

      wifiStatus = {
        state: body.state,
        message: typeof body.message === "string" ? body.message.slice(0, 200) : null,
        updatedAt: new Date().toISOString(),
      };
      sendJson(response, 200, { ok: true, status: wifiStatus });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/wifi/status") {
      sendJson(response, 200, { status: wifiStatus });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : "Internal server error",
    });
  }
});

server.listen(port, () => {
  console.log(`ESP32 Wi-Fi API listening on port ${port}`);
});

server.on("error", (error) => {
  console.error("API server failed to start:", error.message);
  process.exitCode = 1;
});