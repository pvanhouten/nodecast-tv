// Route Node's fetch() through an HTTP proxy when http_proxy/https_proxy is set.
// Node 20's fetch ignores those variables (curl and ffmpeg honor them on their own),
// so without this the manifest, Xtream API, M3U and EPG requests would go out direct.
// OIDC login uses Node's https module rather than fetch(), so it is not proxied.
if (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY) {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[Proxy] Outbound fetch() routed through', process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY);
}
