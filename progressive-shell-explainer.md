# Explainer for Progressive Shells and Navigation Upgrades

## Authors & Contributors

- [Noam Rosenthal](https://github.com/noamr)
- [Vladimir Levin](https://github.com/vmpstr)
- [Rob Flack](https://github.com/flackr)
- [Bramus Van Damme](https://github.com/bramus)
- [Barry Pollard](https://github.com/tunetheweb)
- [Nick Coury](https://github.com/nickcoury)
- [Chris Harrelson](https://github.com/chrishtr)

## Participate

- Issue tracker: [WICG/declarative-partial-updates/issues](https://github.com/WICG/declarative-partial-updates/issues)

## Table of Contents

- [Introduction](#introduction)
- [Goals & Non-goals](#goals--non-goals)
- [Proposed Solution](#proposed-solution)
  - [Code samples](#code-samples)
  - [How it works](#how-it-works)
  - [Options for shell cache discovery](#options-for-shell-cache-discovery)
- [Open questions](#open-questions)
- [Considered alternatives](#considered-alternatives)
  - [Two-phase View Transitions (`deferPageSwap`)](#two-phase-view-transitions-deferpageswap)
  - [Full-page Skeletons](#full-page-skeletons)
  - [DOM Preserve / Merge (`preserve`)](#dom-preserve--merge-preserve)
- [Security and Privacy Considerations](#security-and-privacy-considerations)
  - [Self-Review Questionnaire: Security and Privacy](#self-review-questionnaire-security-and-privacy)
- [References](#references)

## Introduction

When a user clicks a link or enters a URL to open a web page, loading the new document is rarely instant. Today, users pay for that network delay in one of two ways:

1. **The "frozen frame" (paint holding/suppression) and state reset of multi-page navigations (MPAs)**:
   When navigating between documents, the browser holds the last painted frame of the old page while waiting for the new page to arrive and render (paint holding/suppression). To the user, the page is stuck in an uncanny valley—visible on screen, but completely unresponsive to clicks, typing, or scrolling. When the new document finally swaps in, the entire page is torn down and recreated: any text the user was typing into a header search box, keyboard focus, sidebar scroll position, or playing media is wiped out.
2. **The heavy startup cost of Single-Page Applications (SPAs) and full-page prerendering**:
   To avoid freezing the UI and losing state between pages, sites often ship large client-side JavaScript routers (SPAs) that keep an application shell alive in memory. However:
   - **Users pay a steep JavaScript tax** on initial load (slower startup and delayed interactivity).
   - **Cold starts are still slow**: When a user opens a link from the address bar (omnibox), a bookmark, a chat app, or another website (cross-origin), no SPA router is running yet—the user still waits for the full network round-trip before seeing anything.
   - **Full-document prerendering is too heavy to cover every link**: Prerendering an entire destination page requires fetching and rendering a full document in a hidden tab, which often cannot share cache across similar URLs (even with `No-Vary-Search`) and uses too much memory and bandwidth to run for every possible destination.

## Goals & Non-goals

**Goals**:
- **Eliminate the navigation freeze for users**: Keep the active page responsive during same-shell navigations and paint cached shells immediately on cold starts.
- **Preserve user state across navigations**: Keep inputs, focus, scroll positions, and persistent UI elements intact when navigating between pages that share a shell.
- **Work without client-side JavaScript**: Provide SPA-grade transitions and app-shell caching natively in HTML, falling back cleanly to normal MPA navigations on older browsers, error responses (`4xx`/`5xx`), or shell version mismatches.
- **Be much lighter than full-page prerendering**: Cache a single small structural shell for an entire route pattern rather than pre-rendering full documents.

**Non-goals**:
- **Replacing web frameworks**: The goal is not to replace frameworks, but to provide declarative browser primitives—for declarative SPAs and instant MPAs—that frameworks and meta-frameworks can leverage to ship less client-side routing/shell code and get instant cold starts out of the box.
- **Cross-origin shells**: Shells only match same-origin URL patterns.
- **General-purpose uninterruptible exit animations**: Holding a navigation arbitrarily long for custom exit animations remains orthogonal.

## Proposed Solution

By placing a single `<meta name="shell">` tag in `<head>` and separating the shared page layout from the page-specific content with a `<?shellboundary>` processing instruction, a site defines a reusable **structural shell** for a URL pattern (such as `/item/:id`). Incoming content after `<?shellboundary>` uses [out-of-order streaming (`<template for>`)](./patching-explainer.md) to slot into placeholders (`<?start>`, `<?marker>`) inside the shell:

- **Instant visual feedback—even on cold starts**: Once a user has visited *any* matching page on the site (or the site pre-warms its shell cache), navigating to `/item/bar456` from the omnibox, a bookmark, or a cross-origin link paints the cached header, navigation bar, and page skeleton **instantly**, while the item's content streams into placeholders (`<template for>`) as bytes arrive from the network.
- **No frozen frame or lost state between pages**: When a user navigates between two pages that share a shell (`upgrade=always`), the browser keeps the current page **live and interactive** while fetching the next URL. Once the incoming `<head>` confirms the shell matches, the browser skips the redundant shell markup up to `<?shellboundary>`, updates the URL in place, and streams the new content directly into the existing page—preserving user input, focus, scroll position, and animations with **zero client-side routing JavaScript**.

### Code samples

#### 1. Initial navigation to `/item/foo123` (Cold Start)

```html
<html>
<head>
  <!-- Cache contract: maps to /item/:id routes.
       upgrade=always enables MPA -> SPA navigation upgrades. -->
  <meta name="shell" content="
    name=app-shell,
    revision=my-shell-v1,
    pattern=/item/:id,
    upgrade=always
  ">
  <?start name="metadata">
  <title>Some item</title>
  <?end>
  <!-- async scripts and resources with fetchpriority < high wait to load
       until the shell is on screen -->
  <script async src="optional.js"></script>
</head>
<body>
  <header>
    <input type="search" placeholder="Search...">
    <nav>...</nav>
  </header>
  <main>
    <?marker name="main">
  </main>

  <!-- Defines the end of the structural shell -->
  <?shellboundary name="app-shell">

  <!-- Page-specific payload starts here -->
  <template for="metadata">
    <title>Item 123foo</title>
  </template>
  <template for="main">
    Item 123foo content
  </template>
</body>
</html>
```

#### 2. Later, navigating to `/item/bar456` (Upgraded Navigation)

```html
<!-- Request header includes: Sec-Active-Shell: name="app-shell"; rev="my-shell-v1" -->
<html>
<head>
  <!-- The server repeats the meta contract. If there's a revision mismatch
       or a non-OK status, the browser aborts the upgrade and does a clean MPA reload. -->
  <meta name="shell" content="
    name=app-shell,
    revision=my-shell-v1,
    pattern=/item/:id,
    upgrade=always">
</head>
<body>
  <!-- The browser pauses the page unload, skips the bytes up to the matching boundary,
       updates the URL/History Entry in place, and splices the remaining stream into the live page. -->
  <?shellboundary name="app-shell">

  <!-- Page-specific styles replace the previous ones -->
  <template for="page-specific-styles">
    <?start name="page-specific-style">
    <link rel="stylesheet" href="/item-details.css">
  </template>
  <template for="metadata">
    <title>Item bar456</title>
  </template>
  <template for="main">
    Item bar456 content
  </template>
</body>
</html>
```

### How it works

- **The `<meta name="shell">` Contract**:
  - `name`: Unique identifier linking the `<meta>` contract to `<?shellboundary name="...">`.
  - `pattern`: Same-origin [URL Pattern](https://urlpattern.spec.whatwg.org/) of routes that share this shell.
  - `revision`: Version key. A mismatch triggers a full cross-document reload.
  - `upgrade` (`once` | `always`): Whether this shell is only used for one-shot cold-start shell-to-content continuation (`once`), or also upgrades navigations between matching pages into same-document updates (`always`).
- **The Parser Cut (`<?shellboundary>`)**: The structural shell starts at the beginning of the document and ends at `<?shellboundary>`.
- **Instant Shell Paints & Continuation**: The browser caches the shell keyed by `pattern`. When any navigation matching `pattern` starts (including cold starts from the omnibox or cross-origin), the cached shell is painted immediately. When the network response arrives and its contract matches, the bytes before `<?shellboundary>` are discarded and the `<template for>` blocks after the boundary stream into the live shell.
- **Request Header Negotiation (`Sec-Active-Shell`)**: When fetching a page while a shell is active, the browser sends `Sec-Active-Shell: name="app-shell"; rev="my-shell-v1"`. Servers that understand this header can omit the redundant shell markup before `<?shellboundary>` to save bandwidth; static servers can simply return the full HTML file.
- **The Staged Commit**: When navigating from a page with `upgrade=always`, the browser holds the navigation commit (keeping the current page interactive) and speculatively parses the incoming `<head>`:
  - **Match**: Discards incoming bytes up to `<?shellboundary>`, updates the URL and history entry in place, and streams the `<template for>` blocks into the existing document.
  - **Mismatch or `4xx`/`5xx`**: Immediately falls back to a clean cross-document MPA reload (preserving form state where possible).
- **Deferred Loading**: Even on a cold cache, `async` scripts and lower-priority resources (`fetchpriority < high`) inside the shell are deferred until after the initial shell frame is painted.

### Options for shell cache discovery

Beyond discovering `<meta name="shell">` when a user visits a page, the shell cache can also be populated via:
1. **`.well-known/shells.json`**: Origin-wide manifest to pre-warm shells across the domain.
2. **`Shell` / `Link` HTTP response header (or Early Hints)**: Allows broader path scoping than an in-document `<meta>` tag (e.g., `/items/foo123` advertising a shell for `/`).
3. **Programmatic APIs**: [Speculation Rules](https://wicg.github.io/nav-speculation/speculation-rules.html) or Service Worker static routing in the initiating document.

## Open questions

- **Syntax & processing model**: Exact grammar for `<meta name="shell">` and parser state handling at `<?shellboundary>`.
- **Lifecycle events**: Integration with Navigation API events (`navigate`, `navigatesuccess`) and document readiness states during cold-start shell continuation.
- **Back/Forward navigation**: How back/forward traversal restores or merges previous partial updates across joint session history states.
- **Contract parameters beyond `revision`**: Changes in `Content-Security-Policy` or other security headers should abort the partial upgrade and fall back to a full navigation.
- **Render-blocking & scripts**: How `blocking="render"` works during an upgraded navigation, and whether parser-blocking scripts should be disallowed.
- **Exit transitions**: How to coordinate outgoing content animations with shell updates.

## Considered alternatives

### Two-phase View Transitions (`deferPageSwap`)

[Two-phase transitions](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md) let the *old* document show an intermediate loading UI before swapping to the new page.
- **Why not**: It puts the burden on the old page (which often doesn't know the destination's layout), cannot work on cold starts or cross-origin navigations (where deferring navigation is unsafe), and still resets all DOM/input/scroll state when the new document finally swaps in.

### Full-page Skeletons

The destination page declares a separate temporary "skeleton" document that gets replaced wholesale when the real document loads.
- **Why not**: Replacing the temporary skeleton document with the real document wipes out any scrolling, focus, or text typed into inputs while the skeleton was visible—forcing skeleton inputs to be inert and creating a brittle "half-measure" UX.

### Relying on HTTP Content Negotiation (Headers) Instead of In-Band `<?shellboundary>`

Instead of embedding `<?shellboundary>` in a single HTML response that works as a full page, a shell, and a continuation, the browser and server could negotiate different representations via HTTP headers—requesting either a full document, a shell-only response, or a continuation-only response.
- **Why not**: Making the feature depend on HTTP content negotiation is fragile in practice. As documented in the WHATWG's [Why not conneg](https://wiki.whatwg.org/wiki/Why_not_conneg), content negotiation has a long history of bugs across servers, proxies, and CDNs (such as missing or misconfigured `Vary` headers causing CDNs or browser caches to serve a partial continuation fragment to a user doing a normal full-page load). By putting `<meta name="shell">` and `<?shellboundary>` in the HTML itself, a static file or CDN-cached full HTML response works out of the box for all three modes (regular load, shell extraction, and continuation). We still send `Sec-Active-Shell` (much like `Sec-Purpose` for prefetching) so dynamic servers can optionally omit redundant shell bytes before `<?shellboundary>`, but the feature does not depend on content negotiation to function.

### DOM Preserve / Merge (`preserve`)

Instead of cutting the stream at `<?shellboundary>`, stream the full new document on top of the existing one and preserve elements marked with `preserve` and a matching `id` (keeping their input, scroll, focus, video, or iframe state and only updating attributes; see [DOM preservation](./preserve-explainer.md)):

```html
<!-- shell.html (with Header: Shell-Match-Pattern: /content/:id?*) -->
<body>
  <header preserve id="header">
    <nav>...</nav>
    <input type="search">
  </header>
  <main preserve id="main">
    <?start name="main-content">Loading...<?end>
  </main>
  <?start name="maybe-footer">
  <footer preserve id="footer">...</footer>
  <?end>
</body>
```

```html
<!-- content.html -->
<head>
  <link rel="shell" href="shell.html">
  <title>Content</title>
</head>
<body>
  <header preserve id="header">
    <nav>...</nav>
    <input type="search">
  </header>
  <main preserve id="main">
    <?start name="main-content">Loading...<?end>
  </main>
  <?start name="maybe-footer">
  <footer preserve id="footer">...</footer>
  <?end>
  <!-- Removes the sometimes-preserved footer and populates main -->
  <template for="maybe-footer"></template>
  <template for="main-content">Main content goes here</template>
</body>
```

- **Why `<?shellboundary>` is preferred for shells**: With `<?shellboundary>`, the browser doesn't need to re-parse and merge the entire shell DOM on every navigation—it simply skips everything before the boundary and applies the `<template for>` patches after it.

## Security and Privacy Considerations

- **Preventing unauthorized same-origin shell poisoning (Service Worker-style path scoping)**:
  Because a cached shell is painted *immediately* when a user navigates to a matching URL—before the destination page's network response arrives—allowing any page on an origin to register a shell for arbitrary routes on that origin would be dangerous on multi-tenant or path-shared origins (e.g., `example.com/~alice` vs. `example.com/login`, or if an attacker finds an HTML injection vulnerability on a single sub-route). An untrusted sub-page could otherwise register a shell for `/login` or `/` and briefly display spoofed UI or run scripts under that URL until the destination response arrives and aborts the shell.
  To prevent this, `<meta name="shell">` follows a scoping model analogous to [Service Worker registration](https://w3c.github.io/ServiceWorker/#path-restriction):
  - **Default path-prefix confinement**: A `<meta name="shell">` element declared in a document at `/catalog/items/foo` can only register URL `pattern`s within its containing directory path (`/catalog/items/...`). Any pattern matching paths outside `/catalog/items/` (or containing `..` path traversal) is rejected by default.
  - **Explicit elevation via HTTP response headers**: Widening a shell's scope beyond the document's path prefix (for example, `/items/foo` registering a shell for `/`) requires server-level privilege—either by declaring the shell in a `Shell` HTTP response header, providing an explicit scope-widening response header (analogous to `Service-Worker-Allowed`), or listing the shell in the origin's root `.well-known/shells.json` manifest.
- **Partitioned cache**: The shell cache is partitioned by the browser's network/storage isolation key, obeys `Cache-Control: no-store`, and is cleared with site data.
- **Security policy enforcement**: If an incoming response in an upgraded navigation changes security headers (`Content-Security-Policy`, `COOP`, `COEP`, `Permissions-Policy`), the browser aborts the in-place upgrade and performs a full cross-document navigation.

### [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   Sends `Sec-Active-Shell: name="..."; rev="..."` to the same origin when navigating with an active/cached shell so the server can optionally omit redundant shell bytes.
2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes—only the origin's own `name` and `revision` for the matched route.
3. **Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?**
   No.
4. **How do the features in your specification deal with sensitive information?**
   Respects HTTP caching rules (`Cache-Control: no-store` prevents caching shells) and clears with browsing data.
5. **Does data exposed by your specification carry related but distinct information that may not be obvious to users?**
   No.
6. **Do the features in your specification introduce state that persists across browsing sessions?**
   Yes, the pattern-to-shell cache persists alongside the HTTP cache, partitioned by network isolation key and cleared when clearing site data/cache.
7. **Do the features in your specification expose information about the underlying platform to origins?**
   No.
8. **Does this specification allow an origin to send data to the underlying platform?**
   No.
9. **Do features in this specification enable access to device sensors?**
   No.
10. **Do features in this specification enable new script execution/loading mechanisms?**
    Post-boundary `<template for>` patches run in the active document's realm under its existing CSP; any CSP change aborts the upgrade.
11. **Do features in this specification allow an origin to access other devices?**
    No.
12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No more than same-origin `history.pushState` / Navigation API `intercept()`, and only after verifying the response from the destination URL.
13. **What temporary identifiers do the features in this specification create or expose to the web?**
    Only the origin-supplied `name` and `revision` in `Sec-Active-Shell` (equivalent to `ETag` / `If-None-Match`).
14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    Shell caches are partitioned by top-level site.
15. **How do the features in this specification work in the context of a browser's Private Browsing or Incognito mode?**
    The shell cache is kept strictly in memory for the incognito profile and discarded when the session closes.
16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes.
17. **Do features in your specification enable origins to downgrade default security protections?**
    No; any security policy mismatch forces a full cross-document reload.
18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Compatible with BFCache; session history restoration for upgraded navigations is discussed in [Open questions](#open-questions).
19. **What happens when a document that uses your feature gets disconnected?**
    In-flight shell continuations or upgrades are aborted.
20. **Does your spec define when and how new kinds of errors should be raised?**
    Contract mismatches or HTTP errors (`4xx`/`5xx`) gracefully fall back to normal cross-document navigation rather than throwing errors.
21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.
22. **What should this questionnaire have asked?**
    *Can an untrusted or compromised sub-path on an origin register a shell for other paths on the same origin?*
    Because a cached shell renders before the destination response arrives, a page at `/users/alice` must not be able to register a `<meta name="shell">` for `/login` or `/settings`. As detailed above, `<meta name="shell">` patterns are confined by default to the declaring document's directory path (just like Service Worker registration scope), and can only match broader same-origin paths when explicitly authorized via an HTTP response header (like `Service-Worker-Allowed` / `Shell`) or `.well-known/shells.json`.

## References

- [Declarative Partial Updates (`WICG/declarative-partial-updates`)](./README.md)
- [Interleaved HTML Streaming / Patching (`<template for>`)](./patching-explainer.md)
- [DOM Preservation (`preserve`)](./preserve-explainer.md)
- [Two-Phase View Transitions (`deferPageSwap`)](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md)
- [URL Pattern Standard](https://urlpattern.spec.whatwg.org/)
