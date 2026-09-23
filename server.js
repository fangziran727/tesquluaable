const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "reservations.json");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const MAX_BODY_BYTES = 32 * 1024;
const SESSION_COOKIE = "sysu_sports_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

const RESERVATION_OPTIONS = {
  "深圳校区游泳池-场地1": ["06:30", "16:30", "19:30"],
  "深圳校区健身房-场地1": ["10:00", "12:30", "14:00", "16:00", "18:00", "20:00"]
};
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

let dataQueue = Promise.resolve();
const sessions = new Map();
const loginFailures = new Map();

function pad(value) {
  return String(value).padStart(2, "0");
}

function getLocalTime() {
  const now = new Date();
  return pad(now.getHours()) + ":" + pad(now.getMinutes());
}

function parseDate(value) {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return value.trim();
}

function validateReservationInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "请求数据必须是 JSON 对象" };
  }

  const venue = typeof payload.venue === "string" ? payload.venue.trim() : "";
  const date = parseDate(payload.date);
  const reservationTime = typeof payload.reservationTime === "string" ? payload.reservationTime.trim() : "";
  const sentAt = payload.sentAt === undefined || payload.sentAt === null || payload.sentAt === ""
    ? getLocalTime()
    : typeof payload.sentAt === "string" ? payload.sentAt.trim() : "";

  if (!Object.prototype.hasOwnProperty.call(RESERVATION_OPTIONS, venue)) {
    return { error: "不支持的场地项目" };
  }
  if (!date) {
    return { error: "日期必须是有效的 YYYY-MM-DD 格式" };
  }
  if (RESERVATION_OPTIONS[venue].indexOf(reservationTime) === -1) {
    return { error: "该场地不支持这个预约时间" };
  }
  if (!TIME_PATTERN.test(sentAt)) {
    return { error: "推送时间必须是 HH:mm 格式" };
  }

  return { value: { venue, date, reservationTime, sentAt } };
}

function reservationKey(reservation) {
  return [reservation.venue, reservation.date, reservation.reservationTime].join("|");
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function setApiHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
}

function parseCookies(header) {
  const cookies = {};
  (header || "").split(";").forEach((part) => {
    const separator = part.indexOf("=");
    if (separator === -1) return;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies[name] = value;
  });
  return cookies;
}

function getSession(request) {
  const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;
  const expiresAt = sessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return sessionId;
}

function hasValidSession(request) {
  return getSession(request) !== null;
}

function isSecureRequest(request) {
  if (request.socket.encrypted || request.headers["x-forwarded-proto"] === "https") return true;
  try {
    return JSON.parse(request.headers["cf-visitor"] || "{}").scheme === "https";
  } catch (error) {
    return false;
  }
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsedOrigin = new URL(origin);
    return (parsedOrigin.protocol === "https:" || parsedOrigin.protocol === "http:") &&
      parsedOrigin.host === request.headers.host &&
      (!isSecureRequest(request) || parsedOrigin.protocol === "https:");
  } catch (error) {
    return false;
  }
}

function serveLoginRedirect(response, pathname) {
  const location = "/login?next=" + encodeURIComponent(pathname === "/admin/" ? "/admin/" : "/");
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function consumeLoginFailure(remoteAddress) {
  const now = Date.now();
  for (const [address, entry] of loginFailures) {
    if (entry.resetAt <= now) loginFailures.delete(address);
  }
  const entry = loginFailures.get(remoteAddress);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(remoteAddress, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { allowed: true, remaining: LOGIN_MAX_FAILURES - 1 };
  }
  entry.count += 1;
  return { allowed: entry.count <= LOGIN_MAX_FAILURES, remaining: LOGIN_MAX_FAILURES - entry.count };
}

function clearLoginFailures(remoteAddress) {
  loginFailures.delete(remoteAddress);
}

function passwordsMatch(candidate) {
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(ACCESS_PASSWORD);
  return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function isSafeReturnPath(value) {
  return value === "/" || value === "/admin/";
}

async function handleLogin(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendError(response, 400, error.message);
    return;
  }

  const remoteAddress = request.socket.remoteAddress || "unknown";
  const currentFailures = loginFailures.get(remoteAddress);
  if (currentFailures && currentFailures.resetAt > Date.now() && currentFailures.count >= LOGIN_MAX_FAILURES) {
    response.setHeader("Retry-After", String(Math.ceil((currentFailures.resetAt - Date.now()) / 1000)));
    sendError(response, 429, "尝试次数过多，请稍后再试");
    return;
  }

  if (!payload || !passwordsMatch(payload.password)) {
    const result = consumeLoginFailure(remoteAddress);
    if (!result.allowed) {
      response.setHeader("Retry-After", String(Math.ceil((loginFailures.get(remoteAddress).resetAt - Date.now()) / 1000)));
      sendError(response, 429, "尝试次数过多，请稍后再试");
      return;
    }
    sendError(response, 401, "访问密码错误");
    return;
  }

  clearLoginFailures(remoteAddress);
  const sessionId = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  for (const [id, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(id);
  }
  sessions.set(sessionId, now + SESSION_TTL_MS);
  const secure = isSecureRequest(request);
  const cookie = SESSION_COOKIE + "=" + sessionId + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000) + (secure ? "; Secure" : "");
  response.setHeader("Set-Cookie", cookie);
  sendJson(response, 200, { next: isSafeReturnPath(payload.next) ? payload.next : "/" });
}

function logout(request, response) {
  const sessionId = getSession(request);
  if (sessionId) sessions.delete(sessionId);
  const secure = isSecureRequest(request);
  response.setHeader("Set-Cookie", SESSION_COOKIE + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" + (secure ? "; Secure" : ""));
  sendJson(response, 200, { ok: true });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let rejected = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error("请求体过大"));
        request.resume();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch (error) {
        reject(new Error("请求体不是有效的 JSON"));
      }
    });
    request.on("error", reject);
  });
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch (error) {
    await fs.writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function readReservations() {
  const content = await fs.readFile(DATA_FILE, "utf8");
  const reservations = JSON.parse(content);
  if (!Array.isArray(reservations)) {
    throw new Error("预约数据文件必须是数组");
  }
  return reservations;
}

async function replaceDataFile(reservations) {
  const temporaryFile = DATA_FILE + "." + process.pid + ".tmp";
  const content = JSON.stringify(reservations, null, 2) + "\n";
  await fs.writeFile(temporaryFile, content, "utf8");
  try {
    await fs.rename(temporaryFile, DATA_FILE);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.rm(DATA_FILE, { force: true });
    await fs.rename(temporaryFile, DATA_FILE);
  }
}

function withDataLock(operation) {
  const result = dataQueue.then(operation, operation);
  dataQueue = result.catch(() => undefined);
  return result;
}

async function handleReservations(request, response, url) {
  if (url.pathname === "/api/reservations" && request.method === "GET") {
    const reservations = await readReservations();
    sendJson(response, 200, reservations);
    return true;
  }

  if (url.pathname === "/api/reservations" && request.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      sendError(response, 400, error.message);
      return true;
    }

    const validation = validateReservationInput(payload);
    if (validation.error) {
      sendError(response, 400, validation.error);
      return true;
    }

    try {
      const reservation = await withDataLock(async () => {
        const reservations = await readReservations();
        if (reservations.some((item) => reservationKey(item) === reservationKey(validation.value))) {
          const error = new Error("该场地在这个日期和时间已经有预约");
          error.statusCode = 409;
          throw error;
        }
        const created = {
          id: crypto.randomUUID(),
          ...validation.value,
          createdAt: new Date().toISOString()
        };
        reservations.push(created);
        await replaceDataFile(reservations);
        return created;
      });
      sendJson(response, 201, reservation);
    } catch (error) {
      sendError(response, error.statusCode || 500, error.statusCode ? error.message : "保存预约失败");
    }
    return true;
  }

  const idMatch = url.pathname.match(/^\/api\/reservations\/([^/]+)$/);
  if (idMatch && request.method === "DELETE") {
    let id;
    try {
      id = decodeURIComponent(idMatch[1]);
    } catch (error) {
      sendError(response, 400, "预约编号无效");
      return true;
    }

    try {
      const removed = await withDataLock(async () => {
        const reservations = await readReservations();
        const index = reservations.findIndex((item) => item.id === id);
        if (index === -1) {
          const error = new Error("预约不存在");
          error.statusCode = 404;
          throw error;
        }
        const deleted = reservations[index];
        reservations.splice(index, 1);
        await replaceDataFile(reservations);
        return deleted;
      });
      sendJson(response, 200, { deleted: removed });
    } catch (error) {
      sendError(response, error.statusCode || 500, error.statusCode ? error.message : "取消预约失败");
    }
    return true;
  }

  return false;
}

function isPrivateStaticPath(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  const normalizedPath = segments.join(path.sep).toLowerCase();
  return segments.some((segment) => segment.startsWith(".")) ||
    normalizedPath === "server.js" ||
    normalizedPath === "data" ||
    normalizedPath.startsWith("data" + path.sep);
}

function isPublicLoginAsset(relativePath) {
  return ["login.html", "login.css", "login.js"].includes(relativePath);
}

function appendVary(response, value) {
  const current = response.getHeader("Vary");
  response.setHeader("Vary", current ? current + ", " + value : value);
}

async function serveStatic(request, response, urlPath, search) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch (error) {
    sendError(response, 400, "路径无效");
    return;
  }

  if (decodedPath === "/admin") {
    response.statusCode = 308;
    response.setHeader("Location", "/admin/" + search);
    response.end();
    return;
  }

  const isLoginRoute = decodedPath === "/login" || decodedPath === "/login/" || decodedPath === "/login.html";
  const relativePath = isLoginRoute ? "login.html" : decodedPath.replace(/^\/+/, "");
  if (isPrivateStaticPath(relativePath)) {
    sendError(response, 404, "资源不存在");
    return;
  }

  const relativeFile = relativePath
    ? relativePath.endsWith("/") ? path.join(relativePath, "index.html") : relativePath
    : "index.html";
  const filePath = path.resolve(ROOT_DIR, relativeFile);
  const relativeToRoot = path.relative(ROOT_DIR, filePath);
  if (relativeToRoot.startsWith(".." + path.sep) || path.isAbsolute(relativeToRoot) || isPrivateStaticPath(relativeToRoot)) {
    sendError(response, 404, "资源不存在");
    return;
  }

  if (!isPublicLoginAsset(relativeToRoot) && !hasValidSession(request)) {
    if (relativeToRoot === "index.html" || relativeToRoot === path.join("admin", "index.html")) {
      serveLoginRedirect(response, relativeToRoot === "index.html" ? "/" : "/admin/");
    } else {
      sendError(response, 401, "请先登录");
    }
    return;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      sendError(response, 404, "资源不存在");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    appendVary(response, "Cookie");
    response.end(await fs.readFile(filePath));
  } catch (error) {
    sendError(response, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "资源不存在" : "读取资源失败");
  }
}

async function requestHandler(request, response) {
  let url;
  try {
    url = new URL(request.url, "http://localhost");
  } catch (error) {
    sendError(response, 400, "请求路径无效");
    return;
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    setApiHeaders(response);
    if (!isSameOrigin(request)) {
      sendError(response, 403, "请求来源无效");
      return;
    }
    await handleLogin(request, response);
    return;
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    setApiHeaders(response);
    if (!isSameOrigin(request) || !hasValidSession(request)) {
      sendError(response, 401, "请先登录");
      return;
    }
    logout(request, response);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    setApiHeaders(response);
    if (!hasValidSession(request)) {
      sendError(response, 401, "请先登录");
      return;
    }
    if (!isSameOrigin(request) && request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      sendError(response, 403, "请求来源无效");
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    try {
      if (url.pathname === "/api/options" && request.method === "GET") {
        sendJson(response, 200, { venues: RESERVATION_OPTIONS });
        return;
      }
      if (await handleReservations(request, response, url)) return;
      sendError(response, 404, "接口不存在");
    } catch (error) {
      sendError(response, 500, "读取预约数据失败");
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendError(response, 405, "该资源只支持 GET");
    return;
  }

  const isLoginRoute = ["/login", "/login/", "/login.html"].includes(url.pathname);
  if (isLoginRoute && hasValidSession(request)) {
    const requestedNext = url.searchParams.get("next");
    response.statusCode = 303;
    response.setHeader("Location", isSafeReturnPath(requestedNext) ? requestedNext : "/");
    response.setHeader("Cache-Control", "no-store");
    response.end();
    return;
  }
  await serveStatic(request, response, url.pathname, url.search);
}

const server = http.createServer((request, response) => {
  requestHandler(request, response).catch(() => {
    if (!response.headersSent) sendError(response, 500, "服务器内部错误");
    else response.destroy();
  });
});

if (!ACCESS_PASSWORD) {
  console.error("ACCESS_PASSWORD 未设置，服务拒绝启动。");
  process.exitCode = 1;
} else {
  ensureDataFile().then(() => {
    server.listen(PORT, HOST, () => {
      console.log("体育馆预约服务已启动: http://" + HOST + ":" + PORT);
    });
  }).catch((error) => {
    console.error("无法初始化预约数据文件", error);
    process.exitCode = 1;
  });
}
