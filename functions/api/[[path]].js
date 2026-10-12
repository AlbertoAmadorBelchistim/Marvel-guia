// API de cuentas y progreso para la guía Marvel (Cloudflare Pages Functions + D1).
//
//   POST   /api/register   {username, password}        -> {token, username}
//   POST   /api/login      {username, password}        -> {token, username}
//   POST   /api/logout                                 -> {ok}
//   GET    /api/me                                     -> {username}
//   GET    /api/progress                               -> {watched, country, updated_at}
//   PUT    /api/progress   {watched, country}          -> {ok, updated_at}
//   DELETE /api/account    {password}                  -> {ok}
//
// Autenticación: token opaco en la cabecera "Authorization: Bearer <token>".
// En la base de datos solo se guarda el SHA-256 del token, nunca el token.
// Contraseñas: PBKDF2-SHA256, 100 000 iteraciones (máximo de Workers), sal de 16 bytes.

const SESSION_DAYS = 180;
const PBKDF2_ITER = 100000;
const MAX_WATCHED = 500;
const MAX_KEY_LEN = 120;
const FAIL_LIMIT = 8;            // intentos fallidos por usuario…
const IP_FAIL_LIMIT = 30;        // …y por IP (más alto: varias personas comparten conexión)…
const FAIL_WINDOW_MS = 15 * 60e3; // …por ventana de 15 minutos
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
const err = (status, code, message) => json({ error: code, message }, status);

function b64(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}
function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER },
    key,
    256
  );
  return b64(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 64 * 1024) throw Object.assign(new Error("too_large"), { status: 413 });
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("bad_json"), { status: 400 });
  }
}

function validCredentials(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!USERNAME_RE.test(username)) return { error: "El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo." };
  if (password.length < 8 || password.length > 200) return { error: "La contraseña debe tener al menos 8 caracteres." };
  return { username, password };
}

// --- límite de intentos fallidos ---------------------------------------------
async function isLocked(db, key, now, limit = FAIL_LIMIT) {
  const row = await db.prepare("SELECT fails, window_start FROM login_attempts WHERE key = ?").bind(key).first();
  return !!row && now - row.window_start < FAIL_WINDOW_MS && row.fails >= limit;
}
async function registerFail(db, key, now) {
  await db
    .prepare(
      `INSERT INTO login_attempts (key, fails, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         fails = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE fails + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`
    )
    .bind(key, now, FAIL_WINDOW_MS)
    .run();
}
async function clearFails(db, key) {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

// --- sesiones -------------------------------------------------------------------
async function createSession(db, userId, now) {
  const token = b64(randomBytes(32)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
  const tokenHash = await sha256Hex(token);
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, userId, now, now + SESSION_DAYS * 86400e3)
    .run();
  return token;
}
async function currentUser(request, db, now) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const tokenHash = await sha256Hex(m[1]);
  const row = await db
    .prepare(
      `SELECT u.id, u.username, s.expires_at, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first();
  if (!row || row.expires_at < now) return null;
  return row;
}

// --- validación del progreso ------------------------------------------------------
function cleanWatched(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const k of list) {
    if (typeof k !== "string" || !k || k.length > MAX_KEY_LEN || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_WATCHED) break;
  }
  return out;
}
function cleanCountry(c) {
  return typeof c === "string" && /^[a-z]{2}$/.test(c) ? c : null;
}

// --- rutas ------------------------------------------------------------------------
export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return err(500, "no_db", "La base de datos no está configurada.");

  const path = "/" + (Array.isArray(params.path) ? params.path.join("/") : params.path || "");
  const method = request.method.toUpperCase();
  const now = Date.now();

  // Solo peticiones del propio sitio con cuerpo JSON (evita CSRF por formularios ajenos).
  if (method !== "GET" && method !== "HEAD") {
    const ct = request.headers.get("content-type") || "";
    if (method !== "POST" || path !== "/logout") {
      if (!ct.includes("application/json")) return err(415, "bad_type", "Se esperaba JSON.");
    }
  }

  try {
    if (path === "/register" && method === "POST") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const ipKey = "reg:" + ip;
      if (await isLocked(db, ipKey, now, 10)) return err(429, "locked", "Demasiados registros desde esta conexión. Prueba en unos minutos.");
      const creds = validCredentials(await readJson(request));
      if (creds.error) return err(400, "invalid", creds.error);
      const exists = await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(creds.username).first();
      if (exists) return err(409, "taken", "Ese nombre de usuario ya existe.");
      const salt = randomBytes(16);
      const id = crypto.randomUUID();
      await db
        .prepare("INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, creds.username, await hashPassword(creds.password, salt), b64(salt), now)
        .run();
      await registerFail(db, ipKey, now); // cuenta registros por IP con el mismo contador
      const token = await createSession(db, id, now);
      return json({ token, username: creds.username }, 201);
    }

    if (path === "/login" && method === "POST") {
      const body = await readJson(request);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const userKey = "user:" + username.toLowerCase();
      const ipKey = "ip:" + ip;
      if ((await isLocked(db, userKey, now)) || (await isLocked(db, ipKey, now, IP_FAIL_LIMIT)))
        return err(429, "locked", "Demasiados intentos fallidos. Espera 15 minutos.");
      const user = USERNAME_RE.test(username)
        ? await db.prepare("SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?").bind(username).first()
        : null;
      // Se calcula el hash aunque el usuario no exista, para no revelar qué usuarios existen por el tiempo de respuesta.
      const salt = user ? unb64(user.pass_salt) : randomBytes(16);
      const hash = await hashPassword(password.slice(0, 200), salt);
      if (!user || !safeEqual(hash, user.pass_hash)) {
        await registerFail(db, userKey, now);
        await registerFail(db, ipKey, now);
        return err(401, "bad_credentials", "Usuario o contraseña incorrectos.");
      }
      await clearFails(db, userKey);
      await db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(user.id, now).run();
      const token = await createSession(db, user.id, now);
      return json({ token, username: user.username });
    }

    // A partir de aquí, todo requiere sesión.
    const user = await currentUser(request, db, now);

    if (path === "/logout" && method === "POST") {
      if (user) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.token_hash).run();
      return json({ ok: true });
    }

    if (!user) return err(401, "unauthorized", "Inicia sesión de nuevo.");

    if (path === "/me" && method === "GET") {
      return json({ username: user.username });
    }

    if (path === "/progress" && method === "GET") {
      const row = await db.prepare("SELECT watched, country, updated_at FROM progress WHERE user_id = ?").bind(user.id).first();
      return json({
        watched: row ? JSON.parse(row.watched) : [],
        country: row ? row.country : null,
        updated_at: row ? row.updated_at : 0,
      });
    }

    if (path === "/progress" && method === "PUT") {
      const body = await readJson(request);
      const watched = cleanWatched(body.watched);
      if (!watched) return err(400, "invalid", "Formato de progreso no válido.");
      const country = cleanCountry(body.country);
      await db
        .prepare(
          `INSERT INTO progress (user_id, watched, country, updated_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(user_id) DO UPDATE SET watched = ?2, country = COALESCE(?3, country), updated_at = ?4`
        )
        .bind(user.id, JSON.stringify(watched), country, now)
        .run();
      return json({ ok: true, updated_at: now });
    }

    if (path === "/account" && method === "DELETE") {
      const body = await readJson(request);
      const full = await db.prepare("SELECT pass_hash, pass_salt FROM users WHERE id = ?").bind(user.id).first();
      const hash = await hashPassword(String(body.password || "").slice(0, 200), unb64(full.pass_salt));
      if (!safeEqual(hash, full.pass_hash)) return err(401, "bad_credentials", "Contraseña incorrecta.");
      await db.batch([
        db.prepare("DELETE FROM progress WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
      ]);
      return json({ ok: true });
    }

    return err(404, "not_found", "Ruta no encontrada.");
  } catch (e) {
    if (e && e.status) return err(e.status, e.message, "Petición no válida.");
    console.error(e);
    return err(500, "server_error", "Error interno. Inténtalo de nuevo.");
  }
}
