// Cloudflare Pages Function — runs on every request before the static asset is served.
// Purpose: permanently forward the legacy pages.dev host to the canonical custom domain.
//
// Only the exact production pages.dev hostname is redirected. Preview deploys
// (<hash>.salesforce-intelligence.pages.dev) are left alone so preview testing still works,
// and requests already on sfi.auditforce.cloud pass straight through.
export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.hostname === 'salesforce-intelligence.pages.dev') {
    url.hostname = 'sfi.auditforce.cloud';
    // Path and query string are preserved by the URL object; the browser re-appends any #fragment.
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
}
