const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createTenantAuth } = require("../bench/cloud/auth.js");

const binding = { xsuaa: [{ credentials: { url: "https://provider.authentication.example.com", uaadomain: "authentication.example.com", clientid: "runner", clientsecret: "binding-secret", xsappname: "benchmark" } }] };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = claims => encode({ alg: "RS256" }) + "." + encode(claims) + ".test-signature";
test("tenant OAuth caches headers and renews outside windows without exposing secrets", async t => {
  let requests = 0, now = 1700000000000;
  const events = [];
  const server = http.createServer((req, res) => {
    requests++; assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Basic " + Buffer.from("runner:binding-secret").toString("base64"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: token({ iss: "https://subscriber.authentication.example.com/oauth/token", zid: "tenant-a", aud: ["benchmark"], scope: ["benchmark.BenchmarkRunner", "benchmark.BenchmarkRecorder", "benchmark.BenchmarkAdministrator"], exp: now / 1000 + 3600 }), expires_in: 3600, token_type: "bearer" }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  const auth = createTenantAuth({ services: binding, subdomain: "subscriber", tenantID: "tenant-a", providerUrl: "http://provider.apps.internal:8080", now: () => now, onRenewal: event => events.push(event),
    fetchImpl: (url, options) => { assert.equal(url, "https://subscriber.authentication.example.com/oauth/token"); return fetch("http://127.0.0.1:" + server.address().port, options); } });
  const first = await auth.ensureWindow(10000); assert.match(first.authorization, /^Bearer /);
  assert.strictEqual(await auth.ensureWindow(10000), first); assert.equal(requests, 1);
  await auth.ensureWindow(10000, { force: true }); assert.equal(requests, 2);
  now += 3590 * 1000; await auth.ensureWindow(30000); assert.equal(requests, 3);
  assert.equal(auth.assertProvider("http://provider.apps.internal:8080/benchmark"), true);
  assert.throws(() => auth.assertProvider("https://attacker.example.com"), /provider/);
  assert.equal(JSON.stringify(events).includes("binding-secret"), false);
  assert.equal(JSON.stringify(events).includes("Bearer"), false);
});
test("OAuth refuses wrong tenant, issuer, audience, scopes and insufficient expiry", async () => {
  const valid = { iss: "https://subscriber.authentication.example.com/oauth/token", zid: "tenant-a", aud: ["benchmark"], scope: ["benchmark.BenchmarkRunner", "benchmark.BenchmarkRecorder", "benchmark.BenchmarkAdministrator"], exp: Date.now() / 1000 + 3600 };
  for (const changes of [{ zid: "other" }, { iss: "https://attacker.example.com/oauth/token" }, { aud: ["other"] }, { scope: [] }, { exp: Date.now() / 1000 + 5 }]) {
    const auth = createTenantAuth({ services: binding, subdomain: "subscriber", tenantID: "tenant-a", providerUrl: "http://provider.apps.internal:8080", fetchImpl: async () => new Response(JSON.stringify({ access_token: token({ ...valid, ...changes }), token_type: "bearer" }), { headers: { "content-type": "application/json" } }) });
    await assert.rejects(auth.ensureWindow(30000), /OAuth/);
  }
});
test("OAuth failure output hides server body and credentials and rejects redirects", async () => {
  const auth = createTenantAuth({ services: binding, subdomain: "subscriber", tenantID: "tenant-a", providerUrl: "http://provider.apps.internal:8080", fetchImpl: async (url, options) => { assert.equal(options.redirect, "error"); return new Response("binding-secret", { status: 401 }); } });
  await assert.rejects(auth.ensureWindow(1), error => error.message === "Tenant OAuth request failed with HTTP 401");
  assert.throws(() => createTenantAuth({ services: {}, subdomain: "subscriber", tenantID: "tenant-a", providerUrl: "http://provider.apps.internal:8080" }), /XSUAA/);
});
test('export auth supports the explicit HTTPS CF public provider while runner auth retains internal routing', () => {
  const options = { services: binding, subdomain: 'subscriber', tenantID: 'tenant-a', providerUrl: 'https://provider.cfapps.eu12.hana.ondemand.com' };
  assert.throws(() => createTenantAuth(options), /provider/);
  const exported = createTenantAuth({ ...options, allowPublicProvider: true });
  assert.equal(exported.assertProvider(options.providerUrl + '/benchmark-evidence'), true);
  assert.throws(() => exported.assertProvider('https://other.cfapps.eu12.hana.ondemand.com'), /provider/);
  assert.throws(() => createTenantAuth({ ...options, allowPublicProvider: true, providerUrl: 'http://provider.cfapps.eu12.hana.ondemand.com' }), /provider/);
});
