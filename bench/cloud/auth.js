function createTenantAuth({ services = JSON.parse(process.env.VCAP_SERVICES || "{}"), subdomain, tenantID, providerUrl, allowPublicProvider = false,
  now = Date.now, fetchImpl = fetch, onRenewal = () => {}, timeoutMs = 15000 }) {
  const candidates = Object.values(services).flat().filter(binding => binding.label === "xsuaa" || binding.credentials?.xsappname);
  if (candidates.length !== 1) throw new Error("One XSUAA client-secret binding required");
  const credentials = candidates[0].credentials;
  if (!credentials?.clientid || !credentials.clientsecret || !credentials.xsappname) throw new Error("XSUAA client-secret credentials required");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain || "") || !tenantID) throw new Error("Subscriber subdomain and expected tenant ID required");
  const bindingURL = new URL(credentials.url);
  const domain = credentials.uaadomain || bindingURL.hostname.split(".").slice(1).join(".");
  if (bindingURL.protocol !== "https:" || !domain || !bindingURL.hostname.endsWith("." + domain) || !/^[a-z0-9.-]+$/i.test(domain)) throw new Error("Trusted XSUAA HTTPS domain required");
  const issuer = "https://" + subdomain + "." + domain;
  const endpoint = issuer + "/oauth/token";
  const provider = new URL(providerUrl);
  const internal = provider.hostname.endsWith('.apps.internal') && ['http:', 'https:'].includes(provider.protocol);
  const publicCF = allowPublicProvider && provider.protocol === 'https:' && /\.cfapps\.[a-z0-9.-]+$/i.test(provider.hostname);
  if ((!internal && !publicCF) || provider.username || provider.password || provider.search || provider.hash || provider.pathname !== "/")
    throw new Error("Controlled provider root URL required");
  const required = ["BenchmarkRunner", "BenchmarkRecorder", "BenchmarkAdministrator"].map(scope => credentials.xsappname + "." + scope);
  let cached, expiresAt = 0, pending;
  const marginMs = 30000;
  async function renew(windowMs, signal) {
    const startedAt = now();
    let response;
    try { response = await fetchImpl(endpoint, { method: "POST", redirect: "error",
      headers: { authorization: "Basic " + Buffer.from(credentials.clientid + ":" + credentials.clientsecret).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch { throw new Error("Tenant OAuth transport failed"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("Tenant OAuth request failed with HTTP " + response.status); }
    let data, claims;
    try { data = await response.json(); const pieces = data.access_token.split("."); if (pieces.length !== 3 || !pieces[2]) throw new Error(); claims = JSON.parse(Buffer.from(pieces[1], "base64url")); }
    catch { throw new Error("Tenant OAuth response is invalid"); }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const scopes = Array.isArray(claims.scope) ? claims.scope : [];
    const expiry = Number(claims.exp) * 1000;
    if (data.token_type?.toLowerCase() !== "bearer" || claims.iss !== endpoint || claims.zid !== tenantID || !audience.includes(credentials.xsappname) ||
      !required.every(scope => scopes.includes(scope)) || !Number.isFinite(expiry) || expiry <= now() + windowMs + marginMs || (claims.nbf && Number(claims.nbf) * 1000 > now()))
      throw new Error("Tenant OAuth claims or expiry do not satisfy the campaign");
    cached = Object.freeze({ authorization: "Bearer " + data.access_token }); expiresAt = expiry;
    onRenewal({ startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now()).toISOString(), expiresAt: new Date(expiry).toISOString(), tenant: tenantID });
    return cached;
  }
  return {
    async ensureWindow(windowMs, { force = false, signal } = {}) {
      if (!Number.isFinite(windowMs) || windowMs < 0) throw new Error("Bounded OAuth window required");
      signal?.throwIfAborted();
      if (!force && cached && expiresAt > now() + windowMs + marginMs) return cached;
      if (!pending) pending = renew(windowMs, signal).finally(() => { pending = null; });
      const headers = await pending;
      if (expiresAt <= now() + windowMs + marginMs) throw new Error("Tenant OAuth expiry does not cover this window");
      return headers;
    },
    get headers() { if (!cached) throw new Error("Tenant OAuth cache is empty"); return cached; },
    get expiresAt() { return expiresAt; },
    assertProvider(url) { if (new URL(url).origin !== provider.origin) throw new Error("Refusing token forwarding outside the controlled provider"); return true; },
  };
}
module.exports = { createTenantAuth };
