// Serves the viewer with a mocked GitHub-proxy API for local verification.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const viewerDir = fileURLToPath(new URL("../apps/github-app/viewer/", import.meta.url));
const viewer = viewerDir + "index.html";
const example = JSON.parse(readFileSync(fileURLToPath(new URL("../packages/schema/src/example.json", import.meta.url)), "utf8"));

const diff = `diff --git a/internal/auth/cache.go b/internal/auth/cache.go
--- /dev/null
+++ b/internal/auth/cache.go
@@ -0,0 +1,4 @@
+package auth
+
+type SessionCache interface { Get(k string) (bool, bool); Set(k string); Delete(k string) }
+// ... 38 lines total
diff --git a/internal/auth/redis_cache.go b/internal/auth/redis_cache.go
--- /dev/null
+++ b/internal/auth/redis_cache.go
@@ -0,0 +1,3 @@
+package auth
+// Redis-backed cache with 60s TTL, keyed on hash(token)
+func (r *RedisCache) Set(k string) { r.client.Set(ctx, hash(k), "1", 60*time.Second) }
diff --git a/internal/handlers/logout.go b/internal/handlers/logout.go
--- a/internal/handlers/logout.go
+++ b/internal/handlers/logout.go
@@ -21,4 +21,11 @@ func Logout(w http.ResponseWriter, r *http.Request) {
 	token := sessionToken(r)
+	// delete before revalidation so logout is immediate, not TTL-bound
+	cache.Delete(token)
 	authService.Revoke(token)
diff --git a/internal/auth/middleware.go b/internal/auth/middleware.go
--- a/internal/auth/middleware.go
+++ b/internal/auth/middleware.go
@@ -55,9 +55,9 @@ func Middleware(next http.Handler) http.Handler {
-	if err := validateSession(token); err != nil {
+	if err := revalidateSession(token); err != nil {
 		http.Error(w, "unauthorized", 401)
diff --git a/internal/handlers/checkout.go b/internal/handlers/checkout.go
--- a/internal/handlers/checkout.go
+++ b/internal/handlers/checkout.go
@@ -102,2 +102,2 @@ func Checkout() {
-	validateSession(tok)
+	revalidateSession(tok)
`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/me") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ login: "reviewer" }));
  }
  if (url.pathname === "/api/document") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "private, no-store");
    return res.end(JSON.stringify({
      meta: { owner: "acme", repo: "checkout-service", pull: 42, title: "Cache session validation", head_sha: "4b8d0a3" },
      document: example, diff, document_missing: false,
    }));
  }
  // Static assets under the viewer dir (styles.css, fonts/*.woff2).
  const rel = url.pathname.replace(/^\/+/, "");
  if (rel && !rel.includes("..")) {
    const types = { css: "text/css", woff2: "font/woff2", js: "text/javascript", html: "text/html" };
    try {
      const buf = readFileSync(viewerDir + rel);
      res.setHeader("Content-Type", types[rel.split(".").pop()] || "application/octet-stream");
      return res.end(buf);
    } catch { /* fall through to index */ }
  }
  res.setHeader("Content-Type", "text/html");
  res.end(readFileSync(viewer, "utf8"));
});
server.listen(8787, () => console.log("mock viewer on http://localhost:8787"));
