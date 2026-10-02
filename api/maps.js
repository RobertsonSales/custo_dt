/**
 * Proxy seguro para a API oficial do Google Maps (Vercel Serverless Function).
 *
 * A chave NUNCA vai para o navegador: ela é lida de process.env.GOOGLE_MAPS_API_KEY
 * (Vercel → Project → Settings → Environment Variables).
 *
 * APIs do Google usadas (habilitar no Google Cloud):
 *   - Routes API      (computeRoutes)  → km e tempo de deslocamento por estrada
 *   - Geocoding API                    → endereço → coordenadas (e o inverso)
 *
 * Ações aceitas (POST, JSON):
 *   { action:"route",   origin:{lat,lon}, destination:{lat,lon} } → { km, sec }
 *   { action:"geocode", address }                                 → { lat, lon, city, uf, locationType, partial }
 *   { action:"reverse", lat, lon }                                → { rua, numero, bairro, city, uf }
 *
 * Variável opcional ALLOWED_ORIGINS (hosts separados por vírgula, ex.:
 * "meuapp.vercel.app,custos.labmedic.com.br") para recusar chamadas de outros sites.
 */
const KEY = process.env.GOOGLE_MAPS_API_KEY;
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
// Caixa aproximada do Brasil — barra coordenadas absurdas antes de gastar cota.
const inBrazil = (p) => p && isNum(p.lat) && isNum(p.lon) && p.lat >= -34 && p.lat <= 6 && p.lon >= -74 && p.lon <= -34;

function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store").json(body);
}

function comp(components, type, short) {
  const c = (components || []).find((x) => (x.types || []).includes(type));
  return c ? (short ? c.short_name : c.long_name) : null;
}

async function googleJson(url, init) {
  const r = await fetch(url, init);
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { httpOk: r.ok, httpStatus: r.status, data };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });

  if (!KEY) {
    return send(res, 500, { code: "CONFIG", error: "GOOGLE_MAPS_API_KEY não configurada no servidor." });
  }

  // (opcional) restringe aos hosts autorizados
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length) {
    let host = "";
    try { host = new URL(req.headers.origin || req.headers.referer || "").host; } catch (_) {}
    if (!allowed.includes(host)) return send(res, 403, { code: "ORIGIN", error: "Origem não autorizada." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};

  try {
    /* ---------- ROTA: distância e tempo por estrada ---------- */
    if (body.action === "route") {
      const { origin, destination } = body;
      if (!inBrazil(origin) || !inBrazil(destination)) return send(res, 400, { error: "Coordenadas inválidas." });

      const { httpOk, httpStatus, data } = await googleJson(ROUTES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": KEY,
          // só distância e duração → SKU mais barato (Compute Routes Essentials)
          "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
          destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          units: "METRIC",
          languageCode: "pt-BR",
        }),
      });
      if (!httpOk) return googleFailure(res, httpStatus, data);
      const route = data && data.routes && data.routes[0];
      if (!route || !isNum(route.distanceMeters)) return send(res, 404, { code: "NO_ROUTE", error: "Sem rota entre os pontos." });
      const sec = parseFloat(String(route.duration || "").replace("s", ""));
      if (!isNum(sec)) return send(res, 502, { error: "Resposta sem duração." });
      return send(res, 200, { km: route.distanceMeters / 1000, sec });
    }

    /* ---------- GEOCODING: endereço → coordenadas ---------- */
    if (body.action === "geocode") {
      const address = String(body.address || "").trim().slice(0, 300);
      if (!address) return send(res, 400, { error: "Endereço vazio." });
      const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&components=country:BR&region=br&language=pt-BR&key=${KEY}`;
      const { httpOk, httpStatus, data } = await googleJson(url);
      if (!httpOk) return googleFailure(res, httpStatus, data);
      if (data.status === "ZERO_RESULTS") return send(res, 404, { code: "NOT_FOUND", error: "Endereço não encontrado." });
      if (data.status !== "OK") return googleStatus(res, data);
      const hit = data.results[0];
      const ac = hit.address_components;
      return send(res, 200, {
        lat: hit.geometry.location.lat,
        lon: hit.geometry.location.lng,
        city: comp(ac, "locality") || comp(ac, "administrative_area_level_2") || comp(ac, "sublocality"),
        uf: comp(ac, "administrative_area_level_1", true),
        locationType: hit.geometry.location_type, // ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
        partial: !!hit.partial_match,
      });
    }

    /* ---------- GEOCODING reverso: coordenadas → endereço ---------- */
    if (body.action === "reverse") {
      if (!inBrazil({ lat: body.lat, lon: body.lon })) return send(res, 400, { error: "Coordenadas inválidas." });
      const url = `${GEOCODE_URL}?latlng=${body.lat},${body.lon}&language=pt-BR&result_type=street_address|route|premise&key=${KEY}`;
      const { httpOk, httpStatus, data } = await googleJson(url);
      if (!httpOk) return googleFailure(res, httpStatus, data);
      if (data.status === "ZERO_RESULTS") return send(res, 404, { code: "NOT_FOUND", error: "Sem endereço." });
      if (data.status !== "OK") return googleStatus(res, data);
      const ac = data.results[0].address_components;
      return send(res, 200, {
        rua: comp(ac, "route"),
        numero: comp(ac, "street_number"),
        bairro: comp(ac, "sublocality_level_1") || comp(ac, "sublocality") || comp(ac, "neighborhood"),
        city: comp(ac, "locality") || comp(ac, "administrative_area_level_2"),
        uf: comp(ac, "administrative_area_level_1", true),
      });
    }

    return send(res, 400, { error: "Ação desconhecida." });
  } catch (e) {
    return send(res, 502, { error: "Falha ao consultar o Google Maps." });
  }
};

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

// Erros que valem para o lote inteiro (chave inválida, API não habilitada, cota) → "fatal" no cliente
function googleFailure(res, httpStatus, data) {
  const status = data && data.error && data.error.status;
  const fatal = [400, 401, 403, 429].includes(httpStatus) && status !== "INVALID_ARGUMENT";
  return send(res, fatal ? 503 : 502, {
    code: fatal ? "GOOGLE_DENIED" : "GOOGLE_ERROR",
    error: `Google Maps recusou a consulta (${status || httpStatus}). Confira chave, APIs habilitadas e cota.`,
  });
}
function googleStatus(res, data) {
  const denied = ["REQUEST_DENIED", "OVER_DAILY_LIMIT", "OVER_QUERY_LIMIT"].includes(data.status);
  return send(res, denied ? 503 : 502, {
    code: denied ? "GOOGLE_DENIED" : "GOOGLE_ERROR",
    error: `Google Maps recusou a consulta (${data.status}). Confira chave, APIs habilitadas e cota.`,
  });
}

