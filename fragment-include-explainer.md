# Fragment Include

## Overview

One of the longest-standing requests on the web platform is a native, declarative client-side HTML include mechanism (see [WHATWG HTML Issue #2791](https://github.com/whatwg/html/issues/2791)). Historically, developers have had to choose between server-only composition (SSI, ESI, server templates) and JavaScript `fetch()`-and-inject libraries.

### Benefits

While server-side composition remains ideal when a single origin can assemble the full response, client-side includes unlock four main benefits:

1. **Buildless DRY HTML:** Reuse shared partials (headers, footers, navigation, icons) on static hosts or local setups without a server runtime, build step, or JavaScript framework.
2. **Split Caching:** Cache shared chrome across navigations while fetching only page-specific content—or serve a CDN-cached static shell that pulls in dynamic, personalized fragments (auth status, cart, regional pricing).
3. **Async Subsections:** Load slower or secondary sections (comments, feeds, recommendations) independently without delaying the main document response.
4. **Composition:** Combine HTML fragments across separate services or backends directly into the document's layout and styling tree, using native browser sanitization (`sanitizer`) instead of heavyweight `<iframe>` isolation.

### Why Client-Side Includes Stalled

Previous attempts at declarative client-side includes stalled on three fundamental problems:

1. **Parser-Blocking Waterfalls:** Synchronous includes halt the HTML parser while waiting on the network, serializing fetches and delaying the rest of the document.
2. **FOUC & Layout Shifts:** Making includes asynchronous avoids blocking the parser, but fragments either paint before their subresource stylesheets finish loading (Flash of Unstyled Content) or arrive after subsequent content has already rendered, pushing elements down and causing layout shifts.
3. **Cross-Site Scripting (XSS):** Without a built-in browser sanitizer, inserting externally fetched markup directly into the document meant trusting the remote payload not to inject scripts or inline event handlers.

### What Changed

We now have the platform building blocks to address all three problems directly in HTML:

1. **Out-of-Order Streaming ([`<template for>`](./patching-explainer.md)):** Decouples where a fragment fetch is initiated from where its markup is inserted, allowing fragments to be fetched early in parallel while the main document continues parsing and rendering placeholders (`<?start name="...">Loading...<?end>`).
2. **Render-Blocking (`rel="expect"`) & Partial Render Blocking ([`hidden="while-loading"`](./partial-render-blocking-explainer.md)):** Authors can manage layout shifts and FOUC per region—holding initial page render until a critical `<template id="..." for="...">` include is applied via `<link rel="expect" href="#..." blocking="render">` in `<head>`, reserving layout space with placeholders, or hiding a target container while its markup and subresources load via `hidden="while-loading"`.
3. **Built-in Sanitization (`sanitizer`) & CSP (`fragment-src`):** External `<template for="..." src="...">` includes are sanitized by default via the browser's native Sanitizer API. Inheriting an unsanitized parser context requires an explicit `sanitizer="unsafe"` opt-in (which can never relax an existing sanitizer context) and remains governed by Content Security Policy (`fragment-src`, falling back to `script-src`).


## Proposed Solution

Building on [declarative patching (`<template for="target-name">`)](./patching-explainer.md), this proposal adds `src` and `sanitizer` to `<template>`:

- **`src`** (along with standard resource-fetching attributes: `crossorigin`, `referrerpolicy`, `integrity`, `fetchpriority`, and global `nonce`): asynchronously fetches an HTML fragment (using CORS by default, like `<script type="module">`) and streams it into the target range (`<?start name="...">...<?end>`) or marker (`<?marker name="...">`) named by `for`. Even when `sanitizer` is omitted, fetching via `src` sanitizes the fragment with the behavior of **existing sanitizer + [`removeUnsafe()`](https://wicg.github.io/sanitizer-api/#dom-sanitizer-removeunsafe)** (using the default `Sanitizer` configuration if no existing sanitizer is active).
- **`sanitizer`** (applicable **only** with `src`): controls sanitization of the fetched fragment. Specifying `sanitizer="unsafe"` undoes that automatic `removeUnsafe()` step and uses the enclosing parser's existing sanitizer context as-is (so `sanitizer` can only *restrict* an existing sanitizer configuration, never relax it).

### At a Glance

```html
<header><?marker name="header"></header>

<main>
  <section><?start name="feed"><p>Loading feed...</p><?end></section>
  <section><?start name="chart"><p>Loading chart...</p><?end></section>
</main>

<!-- Sanitized by default -->
<template for="header" src="/partials/header.html"></template>
<template for="feed" src="/partials/feed.html"></template>

<!-- Inherits ambient parser context (allows scripts and nested <template for>, subject to CSP) -->
<template for="chart" src="/widgets/chart.html" sanitizer="unsafe"></template>
```

### Activation and Targeting

`<template src="...">` reuses the exact targeting model of [inline `<template for="...">`](./patching-explainer.md):

- **Omitted `for`:** Ordinary inert `<template>` (does not fetch `src` or insert into the DOM).
- **Targeted Include (`for="target-name"`):** Fetches `src` and streams the parsed content into the targeted range (`<?start name="target-name">...<?end>`) or insertion point (`<?marker name="target-name">`). Any placeholder content between `<?start>` and `<?end>` is cleared when the response stream begins applying, incoming chunks are inserted progressively **before** `<?end>` or `<?marker>`, and the marker(s) are removed on EOF—leaving **zero `<template>` footprint** in the DOM.
- `for`/`src` and `shadowrootmode` are mutually exclusive on the same `<template>` element, and compose via nesting (`<template shadowrootmode="open"><?marker name="widget"><template for="widget" src="widget.html"></template></template>`).

### Resource Fetching and Lifecycle

When both `for` and `src` are present on `<template>`, the browser asynchronously fetches the HTML payload over the network:

- **Always `text/fragment`:** Included responses must be served with the `text/fragment` MIME type (strict MIME checking with no sniffing; `text/html` and other media types are rejected and abort the include). Requiring `text/fragment` rather than `text/html` ensures endpoints explicitly opt in to serving includable fragments—preventing accidental inclusion of full HTML pages (such as fallback routes or error pages) and preventing fragment endpoints from rendering as standalone documents on direct top-level navigation. Once verified as `text/fragment`, the payload is parsed using the HTML fragment parsing algorithm in the context of the target parent element, natively supporting HTML, `<svg>`, and `<math>` markup without requiring XML media types (`image/svg+xml` or `application/mathml+xml`) or strict XML well-formedness.
- **CORS by default (`crossorigin`, matching `<script type="module">`):** Fetches always use Fetch mode `"cors"` (an opaque `no-cors` response can never be parsed into the host DOM). Just like `<script type="module">`, `crossorigin` controls credentials mode: omitting `crossorigin` (or setting `crossorigin="anonymous"`) uses `"same-origin"` credentials (sending cookies on same-origin requests and omitting them cross-origin), while `crossorigin="use-credentials"` uses `"include"`.
- **Subresource Integrity (`integrity`):** Verifies the cryptographic digest of the fetched payload via standard Fetch SRI. Because Fetch must verify the full body before releasing bytes to the consumer, specifying `integrity` buffers the network response prior to parsing rather than streaming chunk-by-chunk (making it well-suited for static, immutable partials and CDN assets). If integrity verification fails, no nodes are inserted and the template aborts (`templateStatus: "abort"`).
- **Priority, referrer, and CSP (`fetchpriority`, `referrerpolicy`, `nonce`):** `fetchpriority` (`"high"`, `"low"`, `"auto"`) and `referrerpolicy` map directly to the underlying Fetch request, and the global `nonce` attribute is passed on the request for CSP `fragment-src` / `script-src` matching.
- **Non-parser-blocking:** Delays `DOMContentLoaded` until pending `<template for="..." src="...">` includes complete (similar to `<script defer>`), without blocking the HTML parser. Unlike `<script>`, `<template>` does not support `async`, `defer`, or `blocking`—synchronous parser-blocking fetches are intentionally omitted.
- **Inline content with `src` (ignored):** When `src` is present, any inline child content inside `<template>` is ignored. Loading placeholders and fallbacks belong inside `<?start name="...">Loading...<?end>` in the target container, avoiding parser/network race conditions.
- **Disconnection / abort:** If the target document or container is disconnected while `src` retrieval is in progress, the network fetch is aborted immediately; any DOM nodes already streamed remain, and streaming halts (surfacing `templateStatus: "abort"` to [parser-aware `MutationObserver`s](./parser-mutation-records-explainer.md)).

### Avoiding Layout Shifts and FOUC

Because `<template for="..." src="...">` is non-parser-blocking, the main document parser continues past an include and renders subsequent content (`<main>`, `<footer>`). If an asynchronous fragment inserts content into an already-painted region without space reservation—or streams in its own `<link rel="stylesheet">` and images—it can push rendered elements down (Cumulative Layout Shift) or flash unstyled/half-parsed markup (FOUC).

Authors have three complementary tools to prevent layout shifts and FOUC:

#### 1. Document-level render blocking for critical includes (`<link rel="expect">`)

HTML's `<link rel="expect" href="#id" blocking="render">` in `<head>` holds initial page rendering until the targeted element is connected and parsed. When `rel="expect"` targets the `id` of a `<template for="...">` element (inline or with `src`), **it blocks initial rendering until that `<template for>`'s content is fetched, parsed, and applied to the DOM**, while the HTML parser continues parsing the rest of the document and discovering subresources in parallel:

```html
<!doctype html>
<html>
  <head>
    <link rel="expect" href="#header-content" blocking="render">
  </head>
  <body>
    <header><?start name="header"><?end></header>
    <main>Content</main>
    <footer><?start name="footer"><?end></footer>

    <template id="header-content" for="header" src="header.html"></template>
    <template for="footer" src="footer.html"></template>
  </body>
</html>
```

Here, initial rendering waits for `header.html` to apply, while `<main>` and `footer.html` parse and fetch concurrently (and `footer.html` does not block first paint).

#### 2. Element-level partial render blocking (`hidden="while-loading"`)

Once first paint has occurred—or for non-critical sections that should not hold back the entire page—authors can hide an individual container while its markup is still streaming in and/or its subresources (`<link rel="stylesheet">`, `<img>`, `<video>`, `<iframe>`) are still loading using **[Partial Render Blocking (`hidden="while-loading"`)](./partial-render-blocking-explainer.md)**:

```html
<section class="comments" hidden="while-loading">
  <?marker name="comments">
</section>
<template for="comments" src="/partials/comments.html"></template>
```

While `/partials/comments.html` streams into `<section>` and any stylesheets or images inside it load, `<section>` matches `:loading` (with UA default `visibility: hidden` and `opacity: 0` / `@starting-style`, plus implicit `aria-busy="true"`), keeping real layout boxes without painting incomplete or unstyled content, and revealing cleanly (with an optional CSS fade-in) once ready. See [partial-render-blocking-explainer.md](./partial-render-blocking-explainer.md) for full details.

#### 3. Placeholders and CSS space reservation

For asynchronous sections that should show immediate feedback while fetching, authors should place placeholder or skeleton markup inside `<?start name="...">...<?end>` and reserve layout dimensions on the container (`min-height`, `aspect-ratio`, or `contain-intrinsic-size`) so surrounding layout remains stable when the fragment arrives.

### Security & Sanitization (`sanitizer`)

The `sanitizer` attribute applies **exclusively when `src` is present** (`<template for="..." src="...">`). Inline `<template for="...">` elements without `src` are already part of their enclosing HTML stream and use that stream's parser context directly; `sanitizer` has no effect without `src`.

#### Default Safety (`removeUnsafe`) & Ambient Context Inheritance (`sanitizer="unsafe"`)

- **Fetching sanitizes by default (existing sanitizer + `removeUnsafe()`):** Even when `sanitizer` is omitted (or set to `""` / `"default"`), fetching via `src` always sanitizes the response by applying [`Sanitizer.prototype.removeUnsafe()`](https://wicg.github.io/sanitizer-api/#dom-sanitizer-removeunsafe):
  - If the enclosing parser already has an active sanitizer configuration (for example, `element.streamHTMLUnsafe({ sanitizer: customConfig })`, `element.streamHTML(...)`, or an outer `<template for="..." src="...">`), `<template src>` takes a copy of that existing configuration and applies `removeUnsafe()` to it—preserving all existing allowlist/blocklist restrictions while stripping unsafe constructs (`<script>`, inline event handlers, and nested `<template for>` elements).
  - If the enclosing parser has no sanitizer configuration (for example, the main document parser or an unsanitized `element.streamHTMLUnsafe()` call), it applies `removeUnsafe()` on the default `Sanitizer` configuration (`new Sanitizer()`).
- **`sanitizer="unsafe"` undoes the added `removeUnsafe()` step:** Specifying `sanitizer="unsafe"` opts out of that automatic `removeUnsafe()` call and **uses the enclosing parser's existing sanitizer context as-is**:
  - In the top-level document parser—or inside an unsanitized `element.streamHTMLUnsafe()` / `element.setHTMLUnsafe()` call with no sanitizer—there is no ambient sanitizer, so `sanitizer="unsafe"` allows scripts and nested `<template for>` elements to run.
  - Inside a context with an active sanitizer—such as `element.streamHTML()`, `element.streamHTMLUnsafe({ sanitizer: customConfig })`, or an outer sanitized `<template for="..." src="...">`—`sanitizer="unsafe"` inherits that existing sanitizer configuration unchanged rather than bypassing it.
- **Monotonic restriction only:** Because default sanitization applies `removeUnsafe()` onto any ambient config (rather than replacing a stricter custom config with a broader default) and `sanitizer="unsafe"` merely preserves the ambient config, the `sanitizer` attribute can **only restrict** an existing sanitizer configuration, **never relax or widen it**.

```html
<!-- Sanitized by default (scripts and nested <template for> stripped) -->
<div id="profile"><?start name="profile">Loading...<?end></div>
<template for="profile" src="user-profile.html"></template>

<!-- External SVG served as text/fragment: inserted as a sanitized inline <svg>
     (stylable with CSS currentColor) without bloating the main stream -->
<button class="icon-btn">
  <?start name="star-icon"><?end>
  Star
</button>
<template for="star-icon" src="https://icons.example/star.html"></template>

<!-- Inherits ambient parser context (unsanitized in main document; subject to CSP) -->
<div id="widget"><?start name="widget">Loading...<?end></div>
<template for="widget" src="trusted-widget.html" sanitizer="unsafe"></template>
```

#### Content Security Policy (CSP) Integration

1. **`fragment-src` Directive (New, falls back to `script-src`):**
   Governs which origins are allowed to serve HTML fragments fetched via `<template for="..." src="url">`. If `fragment-src` is not specified in the policy, it falls back to `script-src` (and then `default-src`).
   Because external `<template for="..." src="...">` includes are sanitized by default (scripts stripped), pages can configure a broader `fragment-src` policy (e.g., allowing third-party CDNs or CMS domains) while keeping a strict `script-src`.
2. **`script-src` Enforcement for `sanitizer="unsafe"`:**
   When `sanitizer="unsafe"` is used in an unsanitized parser context, any `<script>` tags inside the fetched fragment must still pass standard `script-src` policies (e.g., matching a nonce or hash) in order to execute.

### Try it out

An experimental prototype has been implemented in Chrome behind `chrome://flags/#enable-experimental-web-platform-features`. It is subject to change as we iterate on the design, so we recommend testing in Chrome Canary where possible. Feedback can be raised as issues on this repo.

## Performance

Overuse of client-side includes can become a network waterfall anti-pattern compared to multiplexing on the server. However, the right tradeoff is context-dependent: loading secondary or personalized markup asynchronously—rather than delaying the main server response or routing HTML through client-side JS bundles—can be a net performance win. Much like ES modules, authors and build tools can choose whether to inline/stream fragments from the server or fetch them client-side via `src` per route and cache boundary.

## Relative Paths in Templates

Relative URLs inside an included fragment are **document-relative** (resolved against the host document's `document.baseURI`). This matches standard HTML fragment parsing (`innerHTML`, `setHTML`, `<template for>`) and avoids discrepancies between speculative preload URLs and DOM element URLs.

## Observing Template Lifecycles and Attribution

See [parser-mutation-records-explainer.md](./parser-mutation-records-explainer.md) for the full Web IDL, coalescing rules, and walkthroughs.

## Potential Future Enhancements

### In-place includes via empty `for` (`<template for src="...">`)

A natural extension to consider in the future is allowing an empty `for` attribute (`<template for src="/partials/header.html"></template>` or `for=""`) to insert the fetched fragment **in place** at the `<template>` element's own position in the DOM (temporarily attaching the `<template>` as a positional insertion anchor while streaming, then removing it on EOF).

We have intentionally left empty `for` out of the base proposal for two reasons:
1. **Placeholders are usually a best practice:** Because `<template src>` fetches asynchronously over the network, relying on a bare in-place include leaves nothing rendered at that spot until the fetch resolves. In practice, it is almost always better UX and layout hygiene to declare an explicit target range with placeholder content (`<?start name="feed">Loading…<?end>`)—or a sized container with [`hidden="while-loading"`](./partial-render-blocking-explainer.md)—while also allowing the `<template for="feed" src="...">` fetch to be initiated earlier or later in the stream independently of DOM order.
2. **Simpler base model:** Requiring a named target keeps `<template for="..." src="...">` strictly identical in targeting semantics to inline `<template for="...">`, without needing a temporary live-DOM `<template>` anchor mode in v1.

If developer feedback shows strong demand for markerless in-place includes (for instance, in buildless static sites or inline icon includes where no loading placeholder is needed), empty `for` can be introduced later as a backwards-compatible enhancement.

## Prior Art & Considerations Not Tackled

### 1. Server-Side and Edge Includes

- **SSI (Server-Side Includes):** E.g. `<!--#include virtual="/header.html" -->`. Standard synchronous markup inclusion compiled server-side.
- **ESI (Edge-Side Includes):** E.g. `<esi:include src="http://example.com/header.html" />`. CDN-level edge assembly.
  - *Considerations Not Tackled:* ESI features complex caching parameters (`max-age`), conditional routing via `<esi:choose>`, and edge-side variable interpolation. Our proposal delegates caching entirely to HTTP caching headers, and does not provide template conditional syntax.

### 2. Client-Side Userland Libraries

- **`h-include` (Gustaf Nilsson Kotte):** A popular custom element `<h-include src="...">` fetching external HTML and injecting it.
  - *Considerations Not Tackled:* `h-include` supports extracting a specific DOM subtree from the response using a CSS selector (e.g. `src="page.html" select="#main-content"`). While powerful, this requires parsing the entire document and discarding most of it. Our proposal targets pure raw fragments to optimize network payload and parsing overhead.
- **HTMX (`hx-get="..." hx-trigger="load"`):** Extends standard elements with declarative AJAX.
  - *Considerations Not Tackled:* HTMX supports rich event-driven execution triggers (hover, click, scroll, form updates) and dynamic HTTP response header processing. Our proposal focuses solely on loading subresources as part of standard HTML parser initialization/layout updates.
- **Turbo Frames (`<turbo-frame src="...">`):** Part of Hotwire, isolates page sub-regions for partial navigation.
  - *Considerations Not Tackled:* Turbo Frames intercept form submissions and link clicks inside the frame to hijack browser navigation. Our proposal is a layout and include primitive, not a navigation routing engine.

## Explored Alternatives

### 1. Off-screen buffering on `<template>` (`<template buffer>`)

An earlier revision of this proposal included a boolean `buffer` attribute on `<template>` (`<template for="promo" src="promo.html" buffer>` as well as inline `<template for="comments" buffer>`). In `buffer` mode, the parser accumulated incoming markup off-screen inside `template.content` (`DocumentFragment`), speculatively preloaded subresources, waited for `<link rel="stylesheet">`, `<link rel="preload">`, and nested `<template for src>` includes to finish, and swapped the `DocumentFragment` into the target atomically on EOF.

**Why we moved away from it:**

1. **Conflated DOM insertion with visual hiding:** Because inert `DocumentFragment`s do not normally fetch subresources or participate in rendering, `<template buffer>` required bespoke speculative-preloading and "buffer activation gating" rules in the HTML parser that duplicated what elements in the live DOM already do.
2. **Only worked on `<template>`:** Avoiding FOUC and half-parsed rendering is equally needed for ordinary server-streamed elements (`<article>...</article>`) and script-streamed containers (`element.streamHTML()`). Tying buffering to `<template>` forced authors to wrap ordinary main-document markup inside `<template for="..." buffer>` just to hold rendering.
3. **No layout geometry, `aria-busy`, or CSS transition hooks:** Because buffered content did not exist in the live DOM until swap time, it could not participate in layout, reflect loading state to assistive technologies, or animate entry via CSS (`@starting-style` / `:loading`). Moving render suppression to **[Partial Render Blocking (`hidden="while-loading"`)](./partial-render-blocking-explainer.md)** solves all of these uniformly in the live DOM while keeping `<template for src>` terse and single-purpose.

### 2. Extending the `<script>` element (`type="html"`)

An alternative approach is extending `<script>` (e.g., `<script type="html" for="..." src="...">`), either as a standalone element or nested inside `<template for>`.

**Why it wasn't chosen:**

1. **Inline HTML cannot live in `<script>`:** Declarative out-of-order streaming (`<template for="...">`) requires `<template>` because `<script>` tokenizes its contents as raw text (breaking on unescaped `</script>` tags and skipping HTML parsing).
2. **Splitting inline and external patches across two elements:** Using `<template for>` for inline patches and `<script type="html" for src>` for external includes duplicates targeting (`for`) and lifecycle observation (`MutationRecord.templateAttributes` / `templateStatus`) across two unrelated elements, or requires `<script>` inside an otherwise-inert `<template>` to trigger fetches. Putting `src` and `sanitizer` directly on `<template>` keeps inline and external partial updates unified.
3. **Parser-Blocking Footgun:** `<script>` is parser-blocking by default unless `async` or `defer` is specified, whereas HTML fragment includes should always be non-parser-blocking.

### 3. Introducing a bespoke `<fragment>` element

An alternative is introducing a new bespoke element specifically for external or targeted updates, e.g. `<fragment for="..." src="fragment.html">`.

**Why it wasn't chosen:**

`<template>` already acts as a "self-destructing parser directive" for Declarative Shadow DOM (`<template shadowrootmode>`) and declarative partial updates (`<template for>`), where the parser consumes the `<template>` and routes its contents without leaving the `<template>` element in the DOM (and is already valid anywhere in the HTML grammar, such as inside `<table>` or `<select>`, without foster-parenting). Extending `<template>` is a natural continuation of this existing mechanism rather than introducing a second parser-consumed element.

### 4. Global `fragment` attribute composed with `<script>` and `<template>`

Another alternative is introducing a global attribute (e.g. `fragment="..."`) on the destination DOM container to configure sanitization, composed with `<script type="fragment" src="...">` for fetching and `<template for>` for out-of-order routing:
- **In-place Include:** `<div fragment><script type="fragment" src="fragment.html"></script></div>`
- **Targeted Include:** `<tbody><?marker name="rows"></tbody>` paired with `<template for="rows"><script type="fragment" src="rows.html"></script></template>`

**Why it wasn't chosen:**

1. **Verbosity & Dead Nodes:** Fetching requires writing both a container/template and a nested `<script type="fragment">` loader node that either lingers in the DOM or must self-destruct.
2. **Action at a Distance for Safety Configuration:** Configuring `unsafe` on the *target container* (e.g., `<div fragment="unsafe">`) rather than on the `<template src>` stream means that if a container receives patches from multiple independent templates, enabling `unsafe` for one trusted patch opens the container to script execution from untrusted streams.

### 5. Deconstructed Primitives (Global `sanitize` attribute + `<script>` loader + `:buffer` `display: none`)

Another alternative is decomposing includes into a global `sanitize` attribute on containers (stripping scripts from descendants *only during parsing*), `<script type="html" src="...">` for fetching, and a `display: none` container pseudo-class while loading.

**Why it wasn't chosen:**

1. **False Security Contracts:** A permanent `sanitize` attribute on a `<div>` in the DOM looks like a live runtime security guarantee. Developers could easily assume it sanitizes subsequent JavaScript insertions (`div.innerHTML = ...`), whereas it only operated during parser tree construction.
2. **`display: none` Layout Failures:** Hiding a loading container with `display: none` causes inline scripts (in `unsafe` mode) that measure layout (`offsetWidth`, `getBoundingClientRect()`) during parsing to read `0`, breaking layout-dependent widgets. (By contrast, [Partial Render Blocking](./partial-render-blocking-explainer.md) uses `visibility: hidden` so layout geometry remains valid while hidden.)


## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   It does not expose new user information. It provides a declarative mechanism to fetch `text/fragment` responses and insert HTML fragments into the DOM. Resource timing follows standard CORS / `Timing-Allow-Origin` subresource rules (see [Resource Fetching and Lifecycle](#resource-fetching-and-lifecycle)).

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes.

3. **Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?**
   No.

4. **How do the features in your specification deal with sensitive information?**
   N/A.

5. **Does data exposed by your specification carry related but distinct information that may not be obvious to users?**
   No.

6. **Do the features in your specification introduce state that persists across browsing sessions?**
   No.

7. **Do the features in your specification expose information about the underlying platform to origins?**
   No.

8. **Does this specification allow an origin to send data to the underlying platform?**
   No.

9. **Do features in this specification enable access to device sensors?**
   No.

10. **Do features in this specification enable new script execution/loading mechanisms?**
    Yes, when `sanitizer="unsafe"` is used in an unsanitized parser context. This is mitigated across multiple layers:
    * **Sanitized by default (`existing sanitizer + removeUnsafe()`):** Even when `sanitizer` is omitted, fetching via `src` strips `<script>`, inline event handlers, and nested `<template for>`; `sanitizer="unsafe"` only preserves (never relaxes) the enclosing sanitizer context. See [Default Safety (`removeUnsafe`) & Ambient Context Inheritance](#default-safety-removeunsafe--ambient-context-inheritance-sanitizerunsafe).
    * **Strict `text/fragment` MIME check:** Responses must use `Content-Type: text/fragment` (no sniffing; `text/html` is rejected), preventing accidental full-page inclusion and direct-navigation XSS. See [Resource Fetching and Lifecycle](#resource-fetching-and-lifecycle).
    * **CSP (`fragment-src` / `script-src`) & `nonce`:** Fragment URLs are governed by `fragment-src` (falling back to `script-src`, then `default-src`), and any scripts inside `sanitizer="unsafe"` fragments must satisfy `script-src`. See [Content Security Policy (CSP) Integration](#content-security-policy-csp-integration).
    * **Subresource Integrity (`integrity`):** Verifies the full response digest prior to parsing when specified. See [Resource Fetching and Lifecycle](#resource-fetching-and-lifecycle).

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    * **CORS by default (`crossorigin`):** Always uses Fetch mode `"cors"` with `"same-origin"` credentials by default (matching `<script type="module">`), requiring CORS headers cross-origin and `crossorigin="use-credentials"` to send cross-origin credentials. See [Resource Fetching and Lifecycle](#resource-fetching-and-lifecycle).
    * **Referrer & partitioning:** Respects `referrerpolicy` and standard third-party cache/storage partitioning.

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Standard subresource caching and partitioning rules apply.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes, these will be integrated into the HTML Standard.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No:
    * `sanitizer="unsafe"` only skips the added `removeUnsafe()` step and preserves the enclosing parser's sanitizer configuration—it can never relax an existing sanitizer, bypass CSP, or disable CORS / `text/fragment` MIME enforcement. See [Security & Sanitization (`sanitizer`)](#security--sanitization-sanitizer).

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    No specific impact; standard BFCache handling for in-flight subresource fetches applies.

19. **What happens when a document that uses your feature gets disconnected?**
    In-flight `src` fetches abort immediately if the target document or container is disconnected. See [Resource Fetching and Lifecycle](#resource-fetching-and-lifecycle).

20. **Does your spec define when and how new kinds of errors should be raised?**
    Network failures, `text/fragment` MIME mismatches, CORS/CSP blocks, `integrity` failures, and disconnection aborts halt the include and surface via `templateStatus: "abort"`. See [Resource Fetching and Lifecycle](#resource-fetching-and-lifecycle) and [Observing Template Lifecycles and Attribution](#observing-template-lifecycles-and-attribution).

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.
