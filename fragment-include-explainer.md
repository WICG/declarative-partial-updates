# Fragment Include

## Overview

Browsers are tuned for **top-down** HTML delivery, whereas modern web applications are often structured around **shell-to-content** delivery: an outer application shell renders immediately while independent regions—shared chrome, personalized state, or slower data-backed sections—populate asynchronously. Without a native declarative client-side include mechanism (see [WHATWG HTML Issue #2791](https://github.com/whatwg/html/issues/2791)), sites either suffer a suboptimal loading experience (blocking initial delivery on the slowest backend, or flashing blank regions and layout shifts) or ship costly JavaScript libraries just to `fetch()` and inject HTML.

### Benefits

While server-side composition remains ideal when a single origin can assemble the full response up front, declarative client-side includes unlock four main benefits:

1. **Buildless DRY HTML:** Reuse shared partials (headers, footers, navigation, icons) on static hosts or local setups without a server-side template runtime, build step, or JavaScript framework (requiring only a static `.fragment` → `text/fragment` MIME mapping).
2. **Split Caching:** Cache shared chrome across navigations while fetching only page-specific content—or serve a CDN-cached static shell that pulls in dynamic, personalized fragments such as auth status, cart, or regional pricing (using `crossorigin="use-credentials"` with `Access-Control-Allow-Credentials: true` when personalized endpoints are cross-origin).
3. **Async Subsections:** Load slower or secondary sections (comments, feeds, recommendations) independently without delaying the main document response.
4. **Composition:** Combine HTML fragments across separate services or backends directly into the document's layout and styling tree, using native browser sanitization (`sanitizer`) and scoped context boundaries instead of heavyweight `<iframe>` isolation.

## Proposed Solution

Building on [declarative patching (`<template for="target-name">`)](./patching-explainer.md), this proposal adds `src` and `sanitizer` to `<template>`:

- **`src`** (along with standard resource-fetching attributes: `crossorigin`, `referrerpolicy`, `integrity`, `fetchpriority`, and global `nonce`): asynchronously fetches a `text/fragment` HTML payload (using CORS by default, like `<script type="module">`) and streams it into the target range (`<?start name="...">...<?end>`) or marker (`<?marker name="...">`) named by `for`. When `sanitizer` is omitted, `<template for="..." src="...">` creates a new `Sanitizer` configuration based on the enclosing parser context and calls [`removeUnsafe()`](https://wicg.github.io/sanitizer-api/#dom-sanitizer-removeunsafe) on it.
- **`sanitizer`** (applicable **only** with `src`): controls whether that `removeUnsafe()` step is applied. Specifying `sanitizer="unsafe"` does nothing to the ambient sanitizer state—inheriting the enclosing parser context as-is (so it is unsanitized when embedded in an unsafe context like the main document parser, and can never relax an already-sanitized context).

### At a Glance

```html
<header><?marker name="header"></header>

<main>
  <section><?start name="feed"><p>Loading feed...</p><?end></section>
  <section><?start name="chart"><p>Loading chart...</p><?end></section>
</main>

<!-- Sanitized by default (creates context-derived Sanitizer + removeUnsafe()) -->
<template for="header" src="/partials/header.fragment"></template>
<template for="feed" src="/partials/feed.fragment"></template>

<!-- Inherits ambient parser context as-is (allows scripts in main document, subject to CSP) -->
<template for="chart" src="/widgets/chart.fragment" sanitizer="unsafe"></template>
```

### Why Client-Side Includes Stalled — and What Changed

Previous attempts at declarative client-side includes stalled on three fundamental problems that modern HTML primitives now address together:

1. **Parser-Blocking Waterfalls → Out-of-Order Streaming ([`<template for>`](./patching-explainer.md)):** Synchronous includes halted the HTML parser while waiting on the network. `<template for="..." src="...">` decouples where a fetch is initiated from where its markup is inserted, fetching fragments asynchronously in parallel while the main document continues parsing and rendering placeholders (`<?start name="...">Loading...<?end>`).
2. **FOUC & Layout Shifts → Render Blocking (`rel="expect"`) & Hide While Loading ([`hidden="while-loading"`](./partial-render-blocking-explainer.md)):** Asynchronous fragments previously risked painting before their stylesheets loaded or pushing down already-rendered content. Authors can now hold initial page render for critical includes via `<link rel="expect" href="#..." blocking="render">`, hide an individual container until its markup and subresources settle via `hidden="while-loading"`, or reserve space around placeholders.
3. **Cross-Site Scripting (XSS) → Built-in Sanitization (`sanitizer`) & CSP (`fragment-src`):** Fetched fragments are sanitized with `removeUnsafe()` by default, stay bounded within their own target context, and are governed by Content Security Policy (`fragment-src`, falling back to `script-src`).

### Why Build This Into the Platform?

A basic include is a few lines of userland JavaScript (`fetch()` followed by `innerHTML` or `setHTML()`), or a custom element such as `h-include`. A native include is still worth having, because a userland version can't do the following:

1. **Sanitized by default, including nested includes:** The obvious userland version (`el.innerHTML = await res.text()`) runs no sanitizer, and switching to `setHTML()` only covers the outer fragment. If a fetched fragment contains its own includes, the library has to re-apply the right sanitizer at every level, and one forgotten call site lets unsanitized markup in. Natively, every include is sanitized unless it opts out with `sanitizer="unsafe"`. Nested includes inherit the enclosing sanitizer, so an inner fragment can add restrictions but never remove them, and it can't target markers outside its own fragment.
2. **A CSP directive for HTML inclusion (`fragment-src`):** A userland `fetch()` is governed by `connect-src`, which can't tell fetching JSON apart from fetching markup that will be injected into the page. A native include has its own [request destination (`"fragment"`)](#resource-fetching-and-lifecycle), so CSP can restrict which origins may supply HTML (`fragment-src`, falling back to `script-src`). It also gets strict `text/fragment` MIME checking, `nonce`, and `integrity` through the standard Fetch paths, instead of each library reimplementing them.
3. **Taking part in document loading:** Script can't hold back `DOMContentLoaded` or `window.onload` without being parser-blocking itself, so `defer` scripts and `DOMContentLoaded` handlers can run before userland includes have inserted shared markup such as the header or main content. A native include can delay the document's load events (which ones is an [open question](#should-template-for-src-delay-domcontentloaded-or-only-load)). It can also be render-blocking via `<link rel="expect" blocking="render">`, and the preload scanner can start fetching it before any script runs.
4. **A building block other features can extend:** Once includes are a platform concept, other features can hook into them: `loading="lazy"` with the browser's viewport heuristics, gating [`hidden="while-loading"`](./partial-render-blocking-explainer.md) and `:loading` on in-flight includes, [`MutationObserver`](./template-mutation-observer-explainer.md) lifecycle records, and future speculative-loading or routing features. A userland library can't plug into browser scheduling and loading in these ways.

### Relationship to HTML Modules (and HTML Imports)

Earlier platform efforts in this space targeted **JavaScript component packaging** rather than declarative markup inclusion:

- **HTML Imports (`<link rel="import">`, deprecated/removed):** Loaded full sub-documents with their own global script execution and stylesheet rules, which clashed with ES modules and blocked rendering.
- **HTML Modules ([WICG/webcomponents#645](https://github.com/WICG/webcomponents/issues/645), [whatwg/html#4505](https://github.com/whatwg/html/pull/4505), currently stalled/inactive):** Proposed importing HTML files *into the JavaScript ES module graph* (`import doc from "./card.html" with { type: "html" }`), parsing the response into an inert `Document` so JavaScript code could export, clone, and stamp out nodes.
  - **Why HTML Modules stalled:** The proposal got bogged down in how inline `<script>` tags inside an imported HTML file should interact with the ES module graph (`export` bindings, `import.meta`, module map deduplication, and execution ordering) vs. acting as an inert data import.
  - **Why HTML Modules wouldn't solve declarative includes anyway:** Even if revived, an HTML module loads an inert tree into JavaScript memory after the full response downloads; turning it into page content still requires booting JavaScript, waiting for EOF, and imperatively cloning and inserting nodes—sacrificing streaming, non-JS rendering, and parser-driven placement.
  - **How `<template for src>` avoids those pitfalls:** Fragment Include is an **HTML-first** parser primitive ([whatwg/html#2791](https://github.com/whatwg/html/issues/2791)), not an ES module type. It streams directly into a live target location in the DOM without JavaScript, has no module-map singleton or `export` semantics, and strips `<script>` by default (`removeUnsafe()`), avoiding the script-graph complexity that stalled HTML Modules. (If a data-only HTML/DOM module import for JS is ever standardized in the future, the two would be complementary: HTML Modules for importing inert templates into JS, and `<template for src>` for declaratively streaming HTML into the document.)

---

## Detailed Design

### Activation and Targeting

`<template src="...">` reuses the exact targeting model of [inline `<template for="...">`](./patching-explainer.md):

- **Omitted `for`:** Ordinary inert `<template>` (does not fetch `src` or insert into the DOM).
- **Targeted Include (`for="target-name"`):** Fetches `src` and streams the parsed content into the targeted range (`<?start name="target-name">...<?end>`) or insertion point (`<?marker name="target-name">`). Any placeholder content between `<?start>` and `<?end>` is cleared when a valid response begins streaming, incoming chunks are inserted progressively **before** `<?end>` or `<?marker>`, and the marker(s) are removed on completion—leaving **zero `<template>` footprint** in the DOM.
- **Scoped context boundaries:** A fetched fragment is parsed in a fragment context bounded by its target range/container. Nested `<template for>` patches and nested `<template for="..." src="...">` includes work inside the fragment (even in default safe mode), but **cannot escape the fragment's direct context boundaries** to target or overwrite markers elsewhere in the host document. (UAs also enforce a nesting depth limit to prevent infinite self-inclusion cycles.)
- `for`/`src` and `shadowrootmode` are mutually exclusive on the same `<template>` element, and compose via nesting (`<template shadowrootmode="open"><?marker name="widget"><template for="widget" src="widget.fragment"></template></template>`).

### Resource Fetching and Lifecycle

When both `for` and `src` are present on `<template>`, the browser asynchronously fetches the fragment over the network:

- **Always `text/fragment` (`.fragment` on static hosts):** Responses must be served with `Content-Type: text/fragment` (UTF-8, strict MIME checking with no sniffing, to be registered with IANA; `text/html` and other media types are rejected and abort the include). Requiring `text/fragment` ensures endpoints explicitly opt in to serving includable fragments—preventing accidental inclusion of full HTML fallback/error pages and preventing fragment endpoints from rendering as active standalone documents on direct top-level navigation. Static hosts and CDNs will need to add a `.fragment` → `text/fragment` extension mapping (much like `.mjs` or `.wasm`), which is a simple static configuration compared to running a bespoke SSI/ESI runtime. Once verified as `text/fragment`, the payload is parsed with the HTML fragment parsing algorithm in the target parent element's context, natively supporting HTML, `<svg>`, and `<math>`.
- **Request destination `"fragment"`:** Include requests use a new Fetch [request destination](https://fetch.spec.whatwg.org/#concept-request-destination), `"fragment"`. CSP uses it to apply `fragment-src`, and servers see it as `Sec-Fetch-Dest: fragment`, so they can tell include requests apart from navigations and `fetch()` calls.
- **CORS by default (`crossorigin`, matching `<script type="module">`):** Fetches always use Fetch mode `"cors"`. Omitting `crossorigin` (or `crossorigin="anonymous"`) uses `"same-origin"` credentials (cookies sent same-origin, omitted cross-origin); `crossorigin="use-credentials"` uses `"include"` (requiring `Access-Control-Allow-Credentials: true` and an explicit `Access-Control-Allow-Origin` on cross-origin personalized endpoints).
- **Subresource Integrity (`integrity`):** Verifies the cryptographic digest via standard Fetch SRI. Because Fetch verifies the full body before releasing bytes, `integrity` buffers the response prior to parsing rather than streaming chunk-by-chunk.
- **Priority, referrer, and CSP (`fetchpriority`, `referrerpolicy`, `nonce`):** `fetchpriority` (`"high"`, `"low"`, `"auto"`) and `referrerpolicy` map directly to the underlying Fetch request, and `nonce` is passed on the request for CSP `fragment-src` / `script-src` matching.
- **Non-parser-blocking:** Never blocks the HTML parser (`<template>` intentionally omits `async`, `defer`, and `blocking`). Whether pending includes delay `DOMContentLoaded` or only `window.onload` is discussed in [Open Questions](#open-questions).
- **Inline content with `src` (ignored):** When `src` is present, inline child content inside `<template>` is ignored; fallback markup belongs inside `<?start name="...">...<?end>` in the target container.
- **Error, truncation, and disconnection behavior:**
  - *Pre-stream failure* (network error, HTTP error, non-`text/fragment` MIME type, CORS block, CSP block, or `integrity` mismatch): The include aborts before `"start"`. Any fallback content inside `<?start name="...">...<?end>` **remains intact and visible** in the DOM.
  - *Mid-stream truncation or disconnection:* Once streaming has started, the initial placeholder has already been replaced by incoming chunks. If the network stream drops before completion or the target container/document disconnects, any in-flight fetch aborts, already-streamed DOM nodes remain in place, markers are cleaned up, and any [`hidden="while-loading"`](./partial-render-blocking-explainer.md) boundary settles so content is never stuck hidden.
  - *Programmatic observation & retry UI:* Both pre-stream and mid-stream failures emit a `MutationRecord` with `activeTemplateStatus: "abort"` to observers opted into [`MutationObserver` (`activeTemplateAttributeFilter`)](./template-mutation-observer-explainer.md), enabling applications to render retry UI or restore fallback state.

### Avoiding Layout Shifts and FOUC

Authors have three complementary tools to prevent Cumulative Layout Shift (CLS) and Flash of Unstyled Content (FOUC) for asynchronous includes:

1. **Document-level render blocking for critical includes (`<link rel="expect">`):** `<link rel="expect" href="#header-content" blocking="render">` in `<head>` blocks initial page rendering until `<template id="header-content" for="header" src="header.fragment">` is fetched, parsed, and applied, while the parser continues scanning the rest of the document in parallel.
2. **Hide while loading ([`hidden="while-loading"`](./partial-render-blocking-explainer.md)):** Placing `hidden="while-loading"` on a target container (`<section class="comments" hidden="while-loading"><?marker name="comments"></section>`) keeps the container `visibility: hidden` (matching `:loading` with implicit `aria-busy="true"`) while its fragment streams in and its `<link rel="stylesheet">` / media subresources load, revealing cleanly once ready. *(Note: because `hidden="while-loading"` hides the container while loading, use `<?start>...<?end>` skeletons when you want immediate visible placeholder UI instead of `hidden="while-loading"`, or place loading indicators outside the hidden container.)*
3. **Placeholders and CSS space reservation:** Put skeleton/loading markup inside `<?start name="...">...<?end>` and reserve container dimensions (`min-height`, `aspect-ratio`, or `contain-intrinsic-size`) so surrounding layout stays stable when the fragment arrives.

### Security & Sanitization (`sanitizer`)

The `sanitizer` attribute applies **exclusively when `src` is present** (`<template for="..." src="...">`); inline `<template for="...">` elements without `src` are already part of their enclosing HTML stream.

#### Default Safety (`removeUnsafe`) vs. `sanitizer="unsafe"`

Every HTML parsing context has an ambient sanitizer state: an **unsafe context** (such as the main document parser, or `setHTMLUnsafe()` / `streamHTMLUnsafe()` with no `sanitizer` option) has no active sanitizer restrictions, whereas a **safe/sanitized context** (`setHTML()`, `streamHTML()`, `streamHTMLUnsafe({ sanitizer })`, or an outer sanitized `<template for src>`) enforces an active `Sanitizer` configuration.

- **Omitting `sanitizer` (default safe mode):** Clones the enclosing parser context's `Sanitizer` if one exists. Otherwise it starts from an empty, allow-everything configuration (`new Sanitizer({})`). It then calls [`removeUnsafe()`](https://html.spec.whatwg.org/multipage/#dom-sanitizer-removeunsafe) on it:
  - **Strips script-executing constructs:** `removeUnsafe()` removes the elements HTML categorizes as *Unsafe* (`<script>`, `<iframe>`, `<embed>`, `<object>`, `<frame>`, `<base>`, SVG `<script>` and `<use>`), all inline `on*` event handler attributes, and `javascript:` URLs.
  - **Keeps everything else:** Styles (`<style>`, `<link rel="stylesheet">`, `style` attributes), images, forms, `class`/`id` and `data-*` attributes are preserved, so a fragment can be self-contained. *(Note: CSS inside an included fragment participates in the target tree's cascade unless scoped via `@scope` or Shadow DOM.)*
  - **Allows bounded nested composition:** `<template>` and the `<?start>`/`<?end>`/`<?marker>` processing instructions are kept, so nested `<template for>` and `<template for src>` work in safe mode, scoped strictly within the fragment's own direct context boundaries (unable to target markers in the outer document).
- **`sanitizer="unsafe"`:** **Does nothing** to the sanitizer configuration—the fetched fragment inherits the enclosing parser's ambient sanitizer state unchanged:
  - Embedded in an **unsafe context** (such as the main document parser), the fetched fragment is likewise unsanitized, allowing `<script>` and inline event handlers (still subject to CSP).
  - Embedded in an **already-sanitized context** (such as `streamHTML()` or inside an outer sanitized `<template for src>`), `sanitizer="unsafe"` inherits that enclosing sanitizer configuration unchanged—so `sanitizer` can **only restrict** an ambient sanitizer configuration, **never relax or escape it**.

```html
<!-- Default: empty Sanitizer + removeUnsafe() (scripts, iframes, <base>, event handlers & javascript: URLs stripped; styles & bounded nested includes kept) -->
<div id="profile"><?start name="profile">Loading...<?end></div>
<template for="profile" src="user-profile.fragment"></template>

<!-- External SVG served as text/fragment: inserted as a sanitized inline <svg> (stylable via currentColor) -->
<button class="icon-btn"><?start name="star-icon"><?end> Star</button>
<template for="star-icon" src="https://icons.example/star.fragment"></template>

<!-- sanitizer="unsafe": inherits main parser's unsafe context as-is (scripts allowed, subject to CSP) -->
<div id="widget"><?start name="widget">Loading...<?end></div>
<template for="widget" src="trusted-widget.fragment" sanitizer="unsafe"></template>
```

#### Content Security Policy (CSP) Integration

1. **`fragment-src` Directive (New, falls back to `script-src`):**
   Governs which origins may serve HTML fragments via `<template for="..." src="url">`, by matching requests whose destination is `"fragment"`. When `fragment-src` is omitted from a CSP policy, it falls back to `script-src` (and then `default-src`). Falling back to `script-src` rather than `default-src` or `connect-src` is intentionally conservative: because `sanitizer="unsafe"` in an unsanitized document can execute scripts from the fetched fragment, falling back to `connect-src` or `default-src` could unexpectedly widen script/HTML inclusion on existing sites that lock down `script-src` while permitting broader `connect-src` endpoints. Sites that fetch sanitized fragments from CDNs or CMS origins can explicitly configure a broader `fragment-src` while keeping `script-src` strict.
2. **`script-src` Enforcement for `sanitizer="unsafe"`:**
   When `sanitizer="unsafe"` is used in an unsanitized parser context, any `<script>` elements inside the fetched fragment must still satisfy `script-src` (including nonces or hashes) in order to execute.

### Relative Paths, Performance, and Lifecycle Observation

- **Relative paths (`document.baseURI`):** Relative URLs inside an included fragment resolve against the host document's `document.baseURI`—matching `innerHTML`, `setHTML()`, and inline `<template for>`, and keeping speculative preload URLs aligned with DOM URLs. Cross-origin fragments (e.g., served from a separate CDN domain) must therefore use absolute URLs for their own subresources.
- **Performance tradeoffs:** Overusing client-side includes can create client-side network waterfalls compared to server multiplexing, whereas fetching personalized or secondary fragments asynchronously avoids delaying the initial shell or shipping client-side JS frameworks. Like ES modules, authors and build tools can choose per boundary whether to stream inline `<template for>` patches from the server or fetch external `<template for src>` fragments.
- **Observing lifecycle & attribution:** See [template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md) for observing `"start"`, `"update"`, `"end"`, and `"abort"` records and reading `templateAttributes` via `MutationObserver`.

### Try it out

An early experimental prototype of `<template>`-based patching and external fetching is in progress in Chromium behind `chrome://flags/#enable-experimental-web-platform-features`. Attribute names and newer parts of this explainer (such as `text/fragment` enforcement, `sanitizer`, and `hidden="while-loading"`) are actively evolving and may differ in current Canary builds; feedback is welcome as issues on this repo.

---

## Open Questions

### Should `<template for src>` delay `DOMContentLoaded` or only `load`?

Unlike `<img>` or `<iframe>` (which load leaf media or isolated subdocuments), `<template for="..." src="...">` populates part of the host document's **own DOM structure**:
- **Case for delaying `DOMContentLoaded` (like `<script defer>`):** Authors and libraries routinely use `<script defer>`, module scripts, and `DOMContentLoaded` handlers to query and enhance the document's DOM (`querySelectorAll`, event listeners, form wiring). If `<template for src>` only delayed `window.onload`, `defer` scripts could run before shared `<header>` or `<main>` fragments are in the DOM.
- **Case for delaying only `window.onload` (or differentiating eager vs. lazy includes):** When `<template for src>` is used for slower secondary subsections (such as `/partials/comments.fragment`), holding back `DOMContentLoaded` delays all `defer` scripts and `DOMContentLoaded` listeners on the slowest fragment fetch.
- **Options to evaluate:** (1) Delay `DOMContentLoaded` by default, (2) delay only `window.onload`, or (3) have eager includes delay `DOMContentLoaded` while allowing deferred/below-the-fold includes (e.g., paired with `loading="lazy"`) to opt out.

### Should the default sanitizer also strip `<meta http-equiv>`?

`removeUnsafe()` only removes elements HTML categorizes as *Unsafe*. `<meta>` isn't one of them, so `<meta http-equiv="refresh" content="0;url=https://evil.example">` survives default sanitization, and a sanitized fragment could redirect the host page. It can't run script, but it is still a page-level side effect that authors wouldn't expect from a "safe" include. Options:
1. Strip `<meta http-equiv>` (or all `<meta>`) from includes in default safe mode, on top of `removeUnsafe()`.
2. Propose categorizing `<meta http-equiv="refresh">` as *Unsafe* in the Sanitizer itself, which would also fix `setHTML()` with a custom configuration.
3. Leave it, and rely on CSP and `fragment-src` to limit who can supply fragments.

### Potential Future Enhancement: In-place includes via empty `for` (`<template for src="...">`)

Allowing an empty `for` attribute (`<template for src="/partials/header.fragment"></template>`) to insert a fetched fragment in place at the `<template>`'s own position is a natural future extension. It is omitted from the initial proposal because asynchronous includes generally benefit from explicit `<?start>...<?end>` placeholders (or `hidden="while-loading"` containers) and keeping `<template for src>` identical in targeting semantics to inline `<template for>` avoids needing a temporary live-DOM `<template>` anchor in v1.

---

## Prior Art & Considerations Not Tackled

<details>
<summary><strong>Server-Side / Edge Includes (SSI, ESI) & Client-Side Libraries (h-include, HTMX, Turbo Frames)</strong></summary>

### 1. Server-Side and Edge Includes

- **SSI (Server-Side Includes):** E.g. `<!--#include virtual="/header.html" -->`. Standard synchronous markup inclusion compiled server-side.
- **ESI (Edge-Side Includes):** E.g. `<esi:include src="http://example.com/header.html" />`. CDN-level edge assembly.
  - *Not tackled here:* Edge caching DSLs, `<esi:choose>` conditionals, and variable interpolation; caching is delegated to standard HTTP caching headers.

### 2. Client-Side Userland Libraries

- **`h-include`:** Custom element `<h-include src="...">` fetching external HTML and injecting it. Unlike `h-include`'s CSS selector extraction (`select="#main"`), `<template for src>` streams raw `text/fragment` payloads directly without parsing and discarding full documents.
- **HTMX (`hx-get`):** Supports event-driven triggers (click, hover, form submit) and custom response headers; `<template for src>` focuses on declarative HTML loading and composition.
- **Turbo Frames (`<turbo-frame src="...">`):** Intercepts links and forms for scoped navigation; `<template for src>` is an HTML include primitive rather than a navigation router (see [route-matching-explainer.md](./route-matching-explainer.md) for routing).

</details>

## Explored Alternatives

<details>
<summary><strong>Explored Alternatives (`<template buffer>`, `<script type="html">`, `<fragment>`, `fragment` / `sanitize` attributes)</strong></summary>

### 1. Off-screen buffering on `<template>` (`<template buffer>`)

An earlier revision included a boolean `buffer` attribute on `<template>` that accumulated incoming markup inside an inert `DocumentFragment`, speculatively preloaded subresources, and swapped into the live DOM on EOF. We moved away from `<template buffer>` because:
1. Inert `DocumentFragment`s do not normally load subresources or participate in layout, requiring bespoke parser/preload rules duplicating the live DOM.
2. FOUC and half-parsed rendering affect ordinary streamed elements (`<article>`) and `element.streamHTML()` too, not just `<template>`.
3. Off-screen fragments had no layout geometry, `aria-busy`, or CSS `@starting-style` transitions—all of which [Hide While Loading (`hidden="while-loading"`)](./partial-render-blocking-explainer.md) provides directly in the live DOM.

### 2. Extending `<script>` (`<script type="html" for="..." src="...">`)

Rejected because `<script>` tokenizes inline contents as raw text (so inline `<template for>` still requires `<template>`), splitting inline and external patches across two elements duplicates targeting and `MutationObserver` attribution, and `<script>` is parser-blocking by default.

### 3. Introducing a bespoke `<fragment>` element

`<template>` already acts as a parser-consumed directive for Declarative Shadow DOM (`<template shadowrootmode>`) and inline patching (`<template for>`), and is already valid everywhere in HTML (including inside `<table>` and `<select>`) without foster-parenting.

### 4. Target-side `fragment` or `sanitize` attributes + nested `<script>` loader

Configuring safety (`fragment="unsafe"` or `sanitize`) on the destination container creates action-at-a-distance hazards when multiple patches target the same container, looks deceptively like a permanent runtime guard against `el.innerHTML`, and requires verbose nested loader elements.

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

External fragment includes enforce `Content-Type: text/fragment` (no sniffing), CORS by default, default sanitization (`removeUnsafe()`) with monotonic ambient-context inheritance, strict fragment context boundaries, and CSP `fragment-src` (falling back to `script-src`).

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   It does not expose new user information. It provides a declarative mechanism to fetch `text/fragment` responses and stream HTML fragments into the DOM. Resource timing follows standard CORS / `Timing-Allow-Origin` subresource rules.

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
    * **Sanitized by default (context `Sanitizer` + `removeUnsafe()`):** Omitting `sanitizer` strips `<script>`, inline event handlers, and other XSS-unsafe constructs while keeping styles and scoping any nested `<template for>` / `<template for src>` strictly within the fragment's own context boundaries; `sanitizer="unsafe"` only preserves (never relaxes) the enclosing sanitizer context.
    * **Strict `text/fragment` MIME check:** Responses must use `Content-Type: text/fragment` (no sniffing; `text/html` is rejected), preventing accidental full-page inclusion and direct-navigation XSS.
    * **CSP (`fragment-src` / `script-src`) & `nonce`:** Fragment URLs are governed by `fragment-src` (falling back to `script-src`, then `default-src`), and any scripts inside `sanitizer="unsafe"` fragments must satisfy `script-src`.
    * **Subresource Integrity (`integrity`):** Verifies the full response digest prior to parsing when specified.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    * **CORS by default (`crossorigin`):** Always uses Fetch mode `"cors"` with `"same-origin"` credentials by default (matching `<script type="module">`), requiring CORS headers cross-origin and `crossorigin="use-credentials"` to send cross-origin credentials.
    * **Referrer & partitioning:** Respects `referrerpolicy` and standard third-party cache/storage partitioning.

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Standard subresource caching and partitioning rules apply.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes, these will be integrated into the HTML Standard.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No. `sanitizer="unsafe"` only skips adding `removeUnsafe()` and inherits the enclosing parser's sanitizer configuration as-is—it can never relax an existing sanitizer, escape fragment context boundaries, bypass CSP, or disable CORS / `text/fragment` MIME enforcement.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    No specific impact; standard BFCache handling for in-flight subresource fetches applies.

19. **What happens when a document that uses your feature gets disconnected?**
    In-flight `src` fetches abort immediately if the target document or container is disconnected.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Network failures, `text/fragment` MIME mismatches, CORS/CSP blocks, `integrity` failures, and disconnection aborts halt the include and surface via `activeTemplateStatus: "abort"` ([template-mutation-observer-explainer.md](./template-mutation-observer-explainer.md)).

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Whether the feature introduces new declarative HTML injection surfaces and how nested includes are contained within ambient sanitizer and target context boundaries (addressed in [Security & Sanitization (`sanitizer`)](#security--sanitization-sanitizer) and [Activation and Targeting](#activation-and-targeting)).

</details>
