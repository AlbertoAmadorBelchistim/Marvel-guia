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
index.html   # la página entera: HTML, CSS, JS y datos en un solo archivo
_headers     # cabeceras de Cloudflare Pages (caché y seguridad)
```

No hay dependencias, ni build, ni framework. Para probarla en local basta con abrir `index.html` en el navegador, o servirla:

```bash
python3 -m http.server 8000
```

## Despliegue en Cloudflare Pages

1. En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elegir este repositorio y la rama `main`.
3. Dejar vacíos **Build command** y **Build output directory** (o poner `/` como directorio de salida): es un sitio estático sin compilación.
4. Guardar y desplegar. Cada `git push` a `main` republica el sitio.

## Datos del usuario

El progreso de cada visitante se guarda en `localStorage`, en su propio navegador. No hay cuentas, ni registro, ni servidor: la página no envía datos a ninguna parte. Para sincronizar entre dispositivos haría falta añadir un Worker con D1 o KV.

## Aviso

Guía personal, sin afiliación con Marvel ni Disney. Los porcentajes de fidelidad son valoraciones subjetivas y están abiertos a discusión. La disponibilidad en plataformas la aporta JustWatch, que es quien mantiene los catálogos por país.
