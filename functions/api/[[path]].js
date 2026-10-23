// API de cuentas y progreso para la guía Marvel (Cloudflare Pages Functions + D1).
//
//   POST   /api/google     {credential}               -> {token, email, name}
//   POST   /api/logout                                -> {ok}
//   GET    /api/me                                    -> {email, name}
//   GET    /api/progress                              -> {watched, country, updated_at}
//   PUT    /api/progress   {watched, country}         -> {ok, updated_at}
//   GET    /api/comics                                -> {read, updated_at}
//   PUT    /api/comics     {read}                     -> {ok, updated_at}
//   GET    /api/rutas/<ruta>                          -> {read, updated_at}   (ruta: dc)
//   PUT    /api/rutas/<ruta>  {read}                  -> {ok, updated_at}
//   DELETE /api/account                               -> {ok}
//
// Inicio de sesión con Google: la página obtiene un ID token (JWT firmado por Google)
// y la API lo verifica con las claves públicas de Google (RS256), comprobando emisor,
// audiencia (nuestro Client ID), caducidad y que el correo esté verificado.
// No se guarda ninguna contraseña. La sesión propia es un token opaco aleatorio;
// en la base de datos solo se guarda su SHA-256.

const SESSION_DAYS = 180;
const MAX_WATCHED = 500;
const MAX_KEY_LEN = 120;
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const DEFAULT_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLOCK_SKEW_S = 120;
const ROUTES = new Set(["dc"]);

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
const err = (status, code, message) => json({ error: code, message }, status);

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "===".slice((s.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

// --- verificación del ID token de Google ------------------------------------------
let jwksCache = { url: null, keys: null, until: 0 };
async function googleKeys(url, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && jwksCache.url === url && jwksCache.keys && now < jwksCache.until) return jwksCache.keys;
  const res = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error("jwks_unavailable");
  const body = await res.json();
  const m = (res.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  jwksCache = { url, keys: body.keys || [], until: now + Math.min(Number(m ? m[1] : 3600), 86400) * 1000 };
  return jwksCache.keys;
}

async function verifyGoogleIdToken(idToken, clientId, jwksUrl) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
  const payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("bad_alg");

  let jwk = (await googleKeys(jwksUrl, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(jwksUrl, true)).find((k) => k.kid === header.kid); // rotación de claves
  if (!jwk) throw new Error("unknown_kid");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    enc.encode(parts[0] + "." + parts[1])
  );
  if (!ok) throw new Error("bad_signature");

  const nowS = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("bad_issuer");
  if (payload.aud !== clientId) throw new Error("bad_audience");
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) throw new Error("expired");
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_S > nowS) throw new Error("not_yet_valid");
  if (!payload.sub || !payload.email) throw new Error("missing_claims");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("email_not_verified");
  return payload;
}

// --- sesiones -------------------------------------------------------------------
async function createSession(db, userId, now) {
  const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_DAYS * 86400e3)
    .run();
  return token;
}
async function currentUser(request, db, now) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, s.expires_at, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .bind(await sha256Hex(m[1]))
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
const cleanCountry = (c) => (typeof c === "string" && /^[a-z]{2}$/.test(c) ? c : null);

// --- rutas ------------------------------------------------------------------------
export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return err(500, "no_db", "La base de datos no está configurada.");

  const path = "/" + (Array.isArray(params.path) ? params.path.join("/") : params.path || "");
  const method = request.method.toUpperCase();
  const now = Date.now();

  // Solo cuerpos JSON en las escrituras (un formulario de otra web no puede enviarlos sin CORS).
  if (method !== "GET" && method !== "HEAD" && !(method === "POST" && path === "/logout") && method !== "DELETE") {
    if (!(request.headers.get("content-type") || "").includes("application/json"))
      return err(415, "bad_type", "Se esperaba JSON.");
  }

  try {
    if (path === "/google" && method === "POST") {
      const clientId = env.GOOGLE_CLIENT_ID;
      if (!clientId) return err(500, "no_client_id", "Falta configurar el inicio de sesión con Google.");
      const body = await readJson(request);
      let claims;
      try {
        claims = await verifyGoogleIdToken(body.credential, clientId, env.GOOGLE_JWKS_URL || DEFAULT_JWKS_URL);
      } catch (e) {
        console.warn("google token rechazado:", e && e.message);
        return err(401, "bad_google_token", "No se ha podido verificar el inicio de sesión con Google. Inténtalo de nuevo.");
      }
      const email = String(claims.email).toLowerCase().slice(0, 254);
      const name = claims.name ? String(claims.name).slice(0, 120) : null;
      let user = await db.prepare("SELECT id FROM users WHERE google_sub = ?").bind(String(claims.sub)).first();
      if (user) {
        await db.prepare("UPDATE users SET email = ?, name = ?, last_login = ? WHERE id = ?").bind(email, name, now, user.id).run();
      } else {
        user = { id: crypto.randomUUID() };
        await db
          .prepare("INSERT INTO users (id, google_sub, email, name, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(user.id, String(claims.sub), email, name, now, now)
          .run();
      }
      await db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(user.id, now).run();
      const token = await createSession(db, user.id, now);
      return json({ token, email, name });
    }

    const user = await currentUser(request, db, now);

    if (path === "/logout" && method === "POST") {
      if (user) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.token_hash).run();
      return json({ ok: true });
    }

    if (!user) return err(401, "unauthorized", "Inicia sesión de nuevo.");

    if (path === "/me" && method === "GET") return json({ email: user.email, name: user.name });

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
      await db
        .prepare(
          `INSERT INTO progress (user_id, watched, country, updated_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(user_id) DO UPDATE SET watched = ?2, country = COALESCE(?3, country), updated_at = ?4`
        )
        .bind(user.id, JSON.stringify(watched), cleanCountry(body.country), now)
        .run();
      return json({ ok: true, updated_at: now });
    }

    if (path === "/comics" && method === "GET") {
      const row = await db.prepare("SELECT read, updated_at FROM comic_progress WHERE user_id = ?").bind(user.id).first();
      return json({ read: row ? JSON.parse(row.read) : [], updated_at: row ? row.updated_at : 0 });
    }

    if (path === "/comics" && method === "PUT") {
      const body = await readJson(request);
      const read = cleanWatched(body.read);
      if (!read) return err(400, "invalid", "Formato de progreso no válido.");
      await db
        .prepare(
          `INSERT INTO comic_progress (user_id, read, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(user_id) DO UPDATE SET read = ?2, updated_at = ?3`
        )
        .bind(user.id, JSON.stringify(read), now)
        .run();
      return json({ ok: true, updated_at: now });
    }

    const rm = path.match(/^\/rutas\/([a-z0-9-]{1,20})$/);
    if (rm) {
      if (!ROUTES.has(rm[1])) return err(404, "not_found", "Ruta no encontrada.");
      if (method === "GET") {
        const row = await db.prepare("SELECT read, updated_at FROM route_progress WHERE user_id = ? AND route = ?").bind(user.id, rm[1]).first();
        return json({ read: row ? JSON.parse(row.read) : [], updated_at: row ? row.updated_at : 0 });
      }
      if (method === "PUT") {
        const body = await readJson(request);
        const read = cleanWatched(body.read);
        if (!read) return err(400, "invalid", "Formato de progreso no válido.");
        await db
          .prepare(
            `INSERT INTO route_progress (user_id, route, read, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, route) DO UPDATE SET read = ?3, updated_at = ?4`
          )
          .bind(user.id, rm[1], JSON.stringify(read), now)
          .run();
        return json({ ok: true, updated_at: now });
      }
    }

    if (path === "/account" && method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM progress WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM comic_progress WHERE user_id = ?").bind(user.id),
        db.prepare("DELETE FROM route_progress WHERE user_id = ?").bind(user.id),
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
