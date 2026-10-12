# Guía Marvel: fidelidad al cómic, necesidad para la trama y orden de visionado

Página estática con 116 películas y series de Marvel comparadas con los arcos de cómic que adaptan.

## Qué incluye

- **Fidelidad al cómic** (estimación propia, 0-100) y **veredicto** de calidad: imprescindible, recomendable, opcional o saltable.
- **Necesidad para la trama**: clave, contexto útil, prescindible o independiente, con el motivo en cada ficha.
- **Imprescindibles para *Vengadores: Doomsday*** en dos niveles, con cuenta atrás al estreno (18 de diciembre de 2026).
- **Progreso personal**: marcar obras vistas y recomendación de la siguiente, por ruta narrativa del UCM o en modo Doomsday.
- **Rutas de visionado**: UCM, Netflix, X-Men de Fox, Spider-Man y mapa del multiverso.
- **Enlaces por obra**: JustWatch según el país elegido (13 disponibles), IMDb, Letterboxd y Marvel Database (Fandom) con el arco de cómic concreto.
- Búsqueda, filtros y ordenación; diseño adaptado a móvil y modo oscuro.

## Estructura

```
public/index.html           # la página entera: HTML, CSS, JS y datos en un solo archivo
public/_headers             # cabeceras de Cloudflare Pages (caché y seguridad)
functions/api/[[path]].js   # API de cuentas y progreso (Pages Functions)
migrations/0001_init.sql    # esquema de la base de datos D1
wrangler.toml               # configuración del proyecto y binding de D1 (DB)
```

No hay build ni dependencias de producción. Para probarla en local con la API y una base de datos de prueba:

```bash
npx wrangler d1 execute marvel-guia --local --file migrations/0001_init.sql
npx wrangler pages dev
```

## Despliegue en Cloudflare Pages

1. En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elegir este repositorio y la rama `main`.
3. Dejar vacío **Build command**. El directorio de salida (`public`) y el binding de la base de datos los toma de `wrangler.toml`.
4. Guardar y desplegar. Cada `git push` a `main` republica el sitio y la API.

`wrangler.toml` es la fuente de verdad de la configuración: los bindings no se editan desde el panel.

## Cuentas y datos del usuario

- **Sin cuenta**, lo marcado se guarda solo en el navegador (`localStorage`).
- **Con cuenta** (usuario y contraseña), lo marcado y el país se guardan en D1 y se recuperan en cualquier dispositivo. Al iniciar sesión, lo marcado sin cuenta en ese navegador se suma a la cuenta. Al volver a la pestaña se traen los cambios hechos en otro dispositivo.
- Al cerrar sesión se borra lo marcado de ese navegador, para que no lo vea quien use el equipo después.
- Cada usuario solo puede leer y escribir su propio progreso.

Seguridad:

- Contraseñas con PBKDF2-SHA256 (100 000 iteraciones) y sal aleatoria; nunca se guardan en claro.
- Sesiones con token aleatorio de 256 bits, enviado como `Authorization: Bearer`; en la base de datos solo se guarda su SHA-256. Caducan a los 180 días.
- Bloqueo de 15 minutos tras 8 intentos fallidos por usuario o 30 por IP.
- La API solo acepta cuerpos JSON, lo que impide que un formulario de otra web haga peticiones en nombre del usuario.
- El usuario puede borrar su cuenta y todos sus datos desde la propia página.
- No hay recuperación de contraseña: no se pide correo electrónico.

API: `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`, `GET|PUT /api/progress`, `DELETE /api/account`.

## Aviso

Guía personal, sin afiliación con Marvel ni Disney. Los porcentajes de fidelidad son valoraciones subjetivas y están abiertos a discusión. La disponibilidad en plataformas la aporta JustWatch, que es quien mantiene los catálogos por país.
