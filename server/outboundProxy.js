// Route Node's fetch() through an HTTP proxy when http_proxy/https_proxy is set.
// Node's built-in fetch ignores those variables (curl and ffmpeg honor them on their own),
// so without this the manifest, Xtream API, M3U and EPG requests would go out direct.
// OIDC login uses Node's https module rather than fetch(), so it is not proxied.
if (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY) {
    const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');
    const dispatcher = new EnvHttpProxyAgent();
    // Use the undici package's own fetch together with its own dispatcher. Node's built-in fetch bundles a
    // different undici major depending on the Node release, and a dispatcher from a mismatched major makes
    // requests hang, so setGlobalDispatcher() alone only works while the two versions happen to line up.
    globalThis.fetch = (input, init) => undiciFetch(input, { dispatcher, ...init });
    console.log('[Proxy] Outbound fetch() routed through', process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY);
}
