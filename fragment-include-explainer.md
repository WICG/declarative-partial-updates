# Fragment Include

## Overview

One of the longest-standing requests on the web platform is a native, declarative client-side HTML include mechanism (see [WHATWG HTML Issue #2791](https://github.com/whatwg/html/issues/2791)). Historically, developers have had to choose between server-only composition (SSI, ESI, server templates) and JavaScript `fetch()`-and-inject libraries.

### Why Client-Side Includes Stalled

Previous attempts at declarative client-side includes stalled on three fundamental problems:

1. **Parser-Blocking Waterfalls:** Synchronous includes halt the HTML parser while waiting on the network, serializing fetches and delaying the rest of the document.
2. **FOUC & Layout Shifts:** Making includes asynchronous avoids blocking the parser, but fragments either paint before their subresource stylesheets finish loading (Flash of Unstyled Content) or arrive after subsequent content has already rendered, pushing elements down and causing layout shifts.
3. **Cross-Site Scripting (XSS):** Without a built-in browser sanitizer, inserting externally fetched markup directly into the document meant trusting the remote payload not to inject scripts or inline event handlers.

### What Changed

We now have the platform building blocks to address all three problems directly in HTML:

1. **Out-of-Order Streaming ([`<template for>`](https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md)):** Decouples where a fragment fetch is initiated from where its markup is inserted, allowing fragments to be fetched early in parallel while the main document continues parsing and rendering placeholders (`<?start name="...">...<?end>`).
2. **Render-Blocking (`rel="expect"`) & Buffering (`buffer`):** Authors can manage layout shifts and FOUC per fragment—either holding initial page render for critical above-the-fold chrome via `<link rel="expect" blocking="render">` in `<head>`, or adding `buffer` so asynchronous fragments parse off-screen, wait for `<link rel="preload">` stylesheets, and swap in atomically on EOF.
3. **Built-in Sanitization (`sanitize`) & CSP (`fragment-src`):** External `<template for src="...">` includes are sanitized by default via the browser's native Sanitizer API. Executing scripts requires an explicit `sanitize="unsafe"` opt-out and remains governed by Content Security Policy (`fragment-src` and `script-src`).

While server-side composition remains ideal for many documents, client-side includes are a better trade-off when:
- **Independent Caching & Static Hosting:** Shared chrome (headers, footers, navigation) can be cached independently by the browser across pages, or composed on static hosts without server-side multiplexing.
- **Asynchronous Widgets & Feeds:** Auxiliary sections (comments, personalized sidebars, recommendations) can load independently without delaying the main document response.
- **Client-Side Sanitization Context:** Sanitizing untrusted fragments in the browser uses the engine's actual parser and native Sanitizer API rather than downstream server regex/DOM approximations.


## Proposed solution

We propose extending the `<template>` element to support native, client-side HTML includes and dynamic content updates by introducing the `for`, `src`,`buffer`, and `sanitize` attributes, as well as resource fetching attributes (`nonce`, `crossorigin`, `referrerpolicy`).

### Activation Model and Modes

An HTML `<template>` actively inserts into the DOM when it has a `for` attribute. If `for` is omitted, it behaves as an ordinary inert `<template>` (and does not fetch `src`). `for`/`src` and `shadowrootmode` are mutually exclusive on the same `<template>` element, and compose via nesting (`<template shadowrootmode="open"><template for src="widget.html"></template></template>`).

#### Targeting and Placement
- **Omitted `for`**: ordinary inert `<template>` (does not fetch or insert into DOM)
- **Targeted Include (`for="target-name"`)**:
  Applies the template content to a targeted range (`<?start name="target-name">...<?end>`) or insertion point (`<?marker name="target-name">`). Content is inserted **before** the `<?end>` or `<?marker>` node.
- **In-place Include (empty `for=""` / `for`)**:
  Inserts the content in-place at the template's position in the HTML stream.

```html
<!-- Inert template (does not render) -->
<template id="menu-tpl">
  <li>Menu Item</li>
</template>

<!-- Active in-place rendering (inline streaming, unsafe by default) -->
<template for>
  <p>Renders progressively in-place.</p>
</template>

<!-- Active in-place rendering (buffered, unsafe by default) -->
<template for buffer>
  <p>Renders atomically once inline parsing is complete.</p>
</template>

<!-- Targeted rendering (streaming, unsafe by default) -->
<section id="gallery">
  <?start name="gallery-patch">Loading...<?end>
</section>
<template for="gallery-patch">
  <p>Streams contents directly into the gallery section.</p>
</template>

<!-- Targeted rendering (buffered, sanitized explicitly) -->
<section id="comments">
  <?start name="comments-patch">Loading...<?end>
</section>
<template for="comments-patch" buffer sanitize>
  <p>Inserts atomically once comments are fully parsed, with scripts stripped.</p>
</template>
```

During active in-place template processing (streaming or buffered), the browser temporarily attaches the `<template>` element to the DOM at its declared position to act as the parser's insertion anchor. Incoming content is parsed and inserted directly **before** the template element. Once processing completes (network EOF or closing tag), the template element is detached and removed, leaving **zero DOM footprint** in the final tree.

### Resource Fetching and Attributes

When the `src` attribute is present on a `<template for>`, the template asynchronously fetches its HTML payload over the network.
- Reuses network configuration attributes like `nonce`, `crossorigin` (`anonymous` / `use-credentials`), and `referrerpolicy`.
- Delays `DOMContentLoaded` until pending `<template for src>` includes complete (similar to `<script defer>`), without blocking the HTML parser.
- Unlike `<script>`, it does not support `async`, `defer`, or `blocking`. All fetches are non-parser-blocking by default. Synchronous parser-blocking fetches are considered a performance footgun. Developers looking to avoid Flash of Unstyled Content (FOUC) should use `<link rel="expect" blocking="render">`, `buffer`, or CSS rather than relying on parser-blocking DOM insertion.

```html
<!-- Asynchronous in-place include (sanitized by default) -->
<template src="header.html" for=""></template>

<!-- Asynchronous targeted include (sanitized by default) -->
<div id="content">
  <?start name="main-content">Loading...<?end>
</div>
<template for="main-content" src="content.html"></template>
```

### Lifecycle and Inline Fallbacks

- **Inline Content with `src` (Ignored):** If a `<template>` declares a `src` attribute, any inline child content is ignored and discarded by the browser. Attempting to use inline content as a network fallback or dynamic placeholder introduces complex parser/network race conditions and rendering flashes. 
  Instead, authors should place initial loading placeholders or fallbacks for non-supporting browsers directly in the target DOM range (e.g., inside the `<?start>`/`<?end>` tags), which will be naturally replaced once the template's stream begins.
- **Template Disconnection (Abort):** If an active template is removed from the document (e.g. via `element.remove()`) or disconnected while its `src` retrieval is in progress:
  - The network fetch is aborted immediately.
  - In `buffer` mode, no DOM mutations occur.
  - In streaming mode, any DOM nodes already appended remain in the document, but streaming and parsing halt immediately.

### Buffering vs. Streaming

The delivery mode is configured using the boolean `buffer` attribute:
- **Streaming (Default, `buffer` absent)**:
  Content is progressively parsed and inserted into the live DOM before the marker/template anchor as network chunks arrive.
- **Buffered (`buffer` present)**:
  The browser parses the content directly into the template's own `content` DocumentFragment property. Once parsing completes, the sanitized contents of this DocumentFragment are cloned and inserted in a single atomic update.

```html
<!-- 1. Streaming (Progressive Render) -->
<!-- In-place: elements render as they arrive from network -->
<template for src="feed-stream.html"></template>

<!-- Targeted: rows stream progressively into tbody without foster-parenting -->
<table>
  <tbody id="table-rows">
    <?start name="rows-patch"><tr><td>Loading rows...</td></tr><?end>
  </tbody>
</table>
<template for="rows-patch" src="rows.html"></template>


<!-- 2. Buffered (Atomic Render once complete) -->
<!-- In-place: parsed to template.content first, inserted in one single batch on EOF -->
<template for src="dialog-modal.html" buffer></template>

<!-- Targeted: comments block is parsed fully to fragment and inserted atomically -->
<section id="comments-section">
  <?start name="comments-patch">Loading comments...<?end>
</section>
<template for="comments-patch" src="comments.html" buffer></template>
```

### Speculative Resource Fetching in Buffered Templates

Unlike an inert `<template>`, where subresources inside `template.content` are not fetched until cloned into the document, external resources inside a `<template buffer>` (such as `<link rel="stylesheet">`, `<img src>`, and `<link rel="preload">`) are **fetched speculatively** by the browser's preload scanner while the template is buffering:

```html
<template for buffer>
  <link rel="stylesheet" href="widget.css">
  <img src="avatar.jpg">
  <div class="widget-body">
    <p>Widget Content</p>
  </div>
</template>
```

**Behavior & Spec Integration:**
1. **Speculative Fetch:** While the HTML parser is tokenizing content into a `<template buffer>`'s `content` DocumentFragment (whether from `src` or inline on the main stream), the speculative preload scanner initiates fetches for external subresources (`<link rel="stylesheet">`, `<img>`, `<script src>`, `<link rel="preload">`, `<link rel="modulepreload">`).
2. **Buffer Activation Gating:** If the buffered template contains `<link rel="stylesheet">`, `<link rel="preload">`, or `<link rel="modulepreload">` elements, those resources gate the buffer's commit until they finish loading (or fail). *(Note: Which subresource types gate buffer activation is an open discussion point.)*
3. **Atomic Commit:** When the template reaches `</template>` (or EOF for `src`) and any gating resources complete, the DocumentFragment is committed to the DOM in a single atomic batch.
4. **Non-Parser Blocking:** The main document parser continues to parse and render content *after* the `</template>` element concurrently. Only the insertion of the template's own buffer is held.

### Avoiding Layout Shifts

Because `<template src>` is non-parser-blocking, the main document parser continues past an include and renders subsequent content (`<main>`, `<footer>`). When an above-the-fold fragment arrives later and inserts content into `<body>`, it can push already-rendered elements down and cause Cumulative Layout Shift (CLS). Furthermore, once the HTML parser has entered `<body>`, it is too late for elements inside `<body>` to initiate document-level render-blocking.

To prevent layout shifts from critical above-the-fold includes without making `<template src>` parser-blocking, authors can combine `<link rel="expect">` in `<head>` with buffered templates and CSS space reservation:

#### 1. Render-blocking instead of parser-blocking via `<link rel="expect">`
HTML's `<link rel="expect" href="#id" blocking="render">` in `<head>` blocks initial rendering until the element with the matching `id` is connected and fully parsed.

To work with asynchronous client-side includes, element render-blocking is extended so that **if `rel="expect"` expects an element `#id`, it also blocks on any active client-side include preceding `#id` in tree order** (any in-place `<template for src>` before `#id`, or any targeted `<template for="slot" src>` whose target range precedes `#id`). Meanwhile, the HTML parser continues parsing `<main>` and the rest of the document in parallel, and any client-side includes *after* `#id` do not block initial rendering:

```html
<!doctype html>
<html>
  <head>
    <link rel="expect" href="#content" blocking="render">
  </head>
  <body>
    <template for src="header.html"></template>
    <main id="content">Content</main>
    <template for src="footer.html"></template>
  </body>
</html>
```

In this example:
1. The parser kicks off `header.html`, continues parsing `<main id="content">` and `footer.html` without blocking, and discovers subresources in parallel.
2. Because `<template for src="header.html">` precedes `#content`, the `<link rel="expect" href="#content" blocking="render">` hold remains active until both `#content` and `header.html` finish parsing (while `footer.html`, which appears after `#content`, does not block initial render).

#### 2. CSS space reservation and `<template buffer>` (non-render-blocking)
For non-critical or below-the-fold fragments that should not hold back first paint, authors can avoid layout shifts by:
- Reserving layout dimensions on the target container (via `min-height`, `aspect-ratio`, or `contain-intrinsic-size`) or placing skeleton placeholder markup inside `<?start name="...">...<?end>`.
- Combining size reservation with `<template buffer>` (and inline `<link rel="preload">` for fragment stylesheets) so the placeholder is swapped for the fully styled fragment in a single atomic frame.

### Security & Sanitization

Security safety is configured via the `sanitize` attribute, which accepts either an empty value (`sanitize` or `sanitize=""`) or `sanitize="unsafe"`.

#### Default Safety Resolution
To optimize security and compatibility, the default safety behavior is determined by the presence of the `src` attribute:
1. **External Includes (`src` is present)**: **Sanitized by default**.
   - If `sanitize` is omitted, it defaults to safe sanitization, which strips scripts, inline event handlers, and nested `<template for>` elements (preventing untrusted fragments from hijacking host document slots or triggering recursive `<template for src>` fetches).
   - To execute scripts or allow nested `<template for>`, the author must explicitly opt-out with `sanitize="unsafe"`.
2. **Inline Templates (`src` is absent)**: **Unsafe by default**.
   - If `sanitize` is omitted, script execution is allowed (preserving compatibility with standard patching behavior).
   - To enable sanitization on inline content, the author must explicitly declare `sanitize`.

```html
<!-- External: sanitized by default (scripts stripped) -->
<template for src="user-profile.html"></template>

<!-- External 3P SVG: inserted as a sanitized inline <svg> (stylable with CSS currentColor) without bloating the main stream -->
<button class="icon-btn">
  <template for src="https://icons.example/star.svg" crossorigin></template>
  Star
</button>

<!-- External with unsafe token: unsanitized (allows script execution) -->
<template for src="ad.html" sanitize="unsafe"></template>

<!-- External buffered with unsafe token -->
<template for src="modal-widget.html" buffer sanitize="unsafe"></template>

<!-- Inline: unsafe by default (script runs) -->
<template for="gallery">
  <script>alert(1)</script>
</template>

<!-- Inline but sanitized: explicit sanitize attribute overrides default -->
<template for="gallery" sanitize>
  <div>User input: <script>alert(1)</script></div>
</template>
```

#### Content Security Policy (CSP) Integration
To allow granular security configuration for declarative includes, this proposal integrates with Content Security Policy (CSP):

1. **`fragment-src` Directive (New):**
   Governs which origins are allowed to serve HTML subresources fetched via `<template src="url">`. Fallback defaults to `default-src`.
   Since standard active templates (without `sanitize="unsafe"`) are sanitized by default (scripts stripped), pages can allow a relaxed `fragment-src` policy (e.g. allowing third-party CDNs or CMS domains) without exposing themselves to script-execution vulnerabilities.
2. **`script-src` Enforcement:**
   If a template includes `sanitize="unsafe"`, any inline `<script>` tags parsed from the fetched HTML must pass standard `script-src` policies (e.g. nonce or hash checks) to be allowed to execute.

## Performance

The main issue with this approach is that overuse of client-side includes can be a performance anti-pattern vs. multiplexing in the server.
However, this performance drawback is very context dependent.
In some cases, adding markup asynchronously rather than having to multiplex it in the server or passing it through JS setters can be a performance win.
Like with JS modules, bundlers are very mature and authors can make the decision of whether to bundle the markup or fetch it client-side based on their specific context.

## Relative paths in templates

Relative URLs inside an included fragment are **document-relative** (resolved against the host document's `document.baseURI`, both during speculative preloading in `buffer` mode and after DOM insertion). This matches standard HTML fragment parsing (`innerHTML`, `setHTML`, `<template for>`) and avoids discrepancies between speculative preload URLs and DOM element URLs.

## Relationship with [HTML modules](https://github.com/WICG/webcomponents/issues/645)

The "module-ness" of this is similar to text or JSON modules, where the content is in the module tree and fetched like a module, but is not mutable in a way that affects all of its importers. In JS, you can do:
`import fragment from "something.html" { type: "fragment" }` which returns a cloned, sanitized `DocumentFragment`.

## Observing Template Lifecycles and Attribution

As page fragments load asynchronously and stream progressive updates, application code (such as analytics, framework hydration engines, or error telemetry) often needs to coordinate with these updates. Specifically, script authors need to know:
1. **Attribution:** Which `<template>` include or patch caused a given DOM insertion, and what attributes (`for`, `src`, `data-*`, etc.) were declared on it?
2. **Lifecycle & Element Completion:** When did a streaming update start, progress, and complete (or abort), and when have streamed elements finished parsing their closing tags?

Standard DOM `MutationObserver` observes the *result* of a mutation (a list of added/removed nodes) but lacks context about the *cause* (the parser-consumed `<template>`). Furthermore, since active templates are detached and removed from the DOM upon completion, they are not stable targets for direct event listeners.

This is addressed by the companion [**Parser-Aware `MutationObserver` Records** explainer](./parser-mutation-records-explainer.md), which introduces `{ parser: true }` on `MutationObserverInit` and surfaces `templateAttributes`, `templateStatus` (`"start" | "update" | "end" | "abort"`), `parsedElements`, and `parserContextElement` on `MutationRecord`:

```javascript
const observer = new MutationObserver((records) => {
  for (const record of records) {
    const attrs = record.templateAttributes;
    if (!attrs) continue;

    const target = attrs.getNamedItem("for")?.value;
    const src = attrs.getNamedItem("src")?.value || "inline";
    console.log(`Mutation from <template for="${target}" src="${src}">: ${record.templateStatus}`);

    if (record.templateStatus === "end") {
      console.log(`Finished loading from: ${src}`);
    } else if (record.templateStatus === "abort") {
      console.warn(`Template include/patch aborted: ${src}`);
    }
  }
});

observer.observe(document.documentElement, {
  childList: true,
  characterData: true,
  subtree: true,
  parser: true,
});
```

See [parser-mutation-records-explainer.md](./parser-mutation-records-explainer.md) for the full Web IDL, coalescing rules, and walkthroughs.



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

## Alternatives considered

### 1. Extending the `<script>` element (`type="html"`)
An alternative approach is extending `<script>` (e.g., `<script type="html" src="...">`), either as a standalone element that carries `src`, `buffer`, `sanitize`, and `for`, or composed inside `<template>` solely for fetching (`<template for buffer><script type="html" src="..."></script></template>`).

**Why it wasn't chosen:**
1. **Inline HTML cannot live in `<script>`:** Routing (`for`), buffering (`buffer`), and sanitization (`sanitize`) are needed for *inline* HTML streams just as much as for external (`src`) fetches. However, the HTML parser tokenizes `<script>` contents as raw text, requiring any nested `</script>` tags in inline markup to be escaped (e.g. `<\/script>`) and preventing normal HTML tokenization. Therefore, inline HTML *must* use `<template>`.
2. **Imbalance and duplication between `<template>` and `<script>`:** Because inline HTML requires `for`, `buffer`, and `sanitize` on `<template>`, introducing `<script type="html" src="...">` for external fetches creates an awkward split:
   - If `buffer`, `sanitize`, and `for` are placed on `<script>`, every attribute must be duplicated across both `<template>` (for inline markup) and `<script>` (for fetched markup), and `<script type="html">` would also have to self-destruct from the DOM after loading.
   - If `for`, `buffer`, and `sanitize` stay on `<template>` while `<script>` only handles `src` (`<template for buffer><script type="html" src="..."></script></template>`), the parser has to special-case a `<script>` inside an otherwise-inert `<template>` fragment just to trigger a fetch.
   Putting `src` directly on `<template>` keeps all four orthogonal controls (`for`, `src`, `buffer`, `sanitize`) on a single element.
3. **Parser-Blocking Footgun:** `<script>` is parser-blocking by default unless `async` or `defer` is specified, whereas HTML fragment includes should always be non-blocking.

### 2. Introducing a bespoke `<fragment>` element
An alternative is introducing a new bespoke element specifically for in-place or targeted updates, e.g. `<fragment src="fragment.html">` or `<fragment>Inline</fragment>`.

**Why it wasn't chosen:**
`<template>` already acts as a "self-destructing parser directive" for Declarative Shadow DOM (`<template shadowrootmode>`) and declarative partial updates (`<template for>`), where the parser consumes the `<template>` and routes its contents without leaving the `<template>` element in the DOM (and is already valid anywhere in the HTML grammar without foster-parenting). Extending `<template>` is a natural continuation of this existing mechanism, whereas introducing `<fragment>` would either require giving a second element this special self-destructing parser behavior or keeping `<fragment>` in the DOM (polluting sibling traversal and CSS selectors).

### 3. Global `fragment` attribute composed with Script and Template
Another alternative is introducing a global attribute (e.g. `fragment="..."`) that resides on the destination DOM container to handle sanitization and buffering, composed with `<script type="fragment">` for fetching and `<template for>` for out-of-order routing:
- **Sanitization without inclusion:** `<div fragment><a onclick="alert('hi')">X</a></div>`
- **Buffering without inclusion:** `<div fragment="buffer"><!-- lots of content... --></div>`
- **In-place Include:** `<div fragment><script type="fragment" src="fragment.html"></script></div>`
- **Targeted Include:** `<tbody fragment="buffer"><?marker name="rows"?></tbody>` paired with `<template for="rows"><script type="fragment" src="rows.html"></script></template>`

**Why it wasn't chosen:**
1. **Observability:** While the content is buffering, it's simply not anywhere in the DOM, but rather kept inside the parser internally.
This makes errors or latency difficult to observe, unlike the `<template>` based behavior where the content accumulates in the template until it is ready to be swapped in.

2. **Verbosity:** Placing includes in-place requires writing both a wrapper tag (`<div fragment>`) and a nested loader tag (`<script type="fragment">`), which is significantly more verbose for simple inclusions than `<template src="fragment.html">`.
3. **Action at a Distance for Safety Configuration:** The security policy (`unsafe`) is configured on the *target container* (e.g., `<div fragment="unsafe">`) rather than on the resource loading stream. If a container receives patches/inclusions from multiple independent templates, it must declare `unsafe` globally, potentially allowing script execution from an untrusted template stream.

### 4. Deconstructed Primitives (Global `sanitize`/`buffer` attributes + `<script>` loader)
Another alternative is decomposing these features into separate, composable primitives rather than bundling them into `<template>`:
- A global `sanitize` attribute that strips scripts/handlers from descendants *only during parsing*.
- Reusing `<script type="html" src="...">` or `type="unsafehtml"` for fetching.
- A global `buffer` attribute that registers a `:buffer` CSS pseudo-class (applying `display: none` by default) to hide the container until the included HTML and its stylesheets are loaded.

Example usage:
```html
<div sanitize buffer>
  <script type="html" src="header.html"></script>
</div>
```

**Why it wasn't chosen:**
1. **DOM Pollution / Transient Directive Abuse:** Because `sanitize` and `buffer` are parser-only instructions, they serve no runtime purpose once loading completes. However, they remain permanently in the DOM as attributes. The loader `<script>` tag also remains as a dead node. Furthermore, wrapping includes in-place forces developers to either introduce unnecessary wrapper elements (like `<div>` which can violate layout nesting rules in lists or tables) or apply the attribute to the parent container permanently.
2. **Hidden Initialization Layout Failures:** Progressive rendering inside a container hidden via `display: none` (the default `:buffer` styling) means that any inline scripts (in `unsafe` mode) execute immediately upon being parsed. If those scripts attempt to calculate layout dimensions (e.g. `offsetWidth` or `getBoundingClientRect()`), they will receive `0`. This causes layout-dependent widgets (carousels, charts, maps) to initialize in a broken state. In contrast, `<template>` parses into an inert DocumentFragment, delaying script execution until the entire fragment is atomically inserted into the active tree with correct dimensions.
3. **False Security Contracts:** A permanent global `sanitize` attribute in the DOM looks like a runtime security contract. Developers might easily assume that it sanitizes dynamic JavaScript DOM insertions (like `div.innerHTML = ...`), whereas it only works during parser-level tree construction, creating a false sense of security.


## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   It does not expose new user information. It provides a declarative mechanism to fetch and insert HTML fragments, which is already possible via standard fetch APIs and `element.innerHTML` or `element.setHTML()`. Network fetch statistics and latency are exposed via the Performance timeline, matching standard subresource guidelines.

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
    Yes. By importing external HTML subresources, the feature allows loading and parsing HTML which may contain scripts. 
    **Mitigation:** The proposal enforces security-by-default for external resource includes. When `src` is present, HTML sanitization is enabled by default, stripping out all script tags and event handler attributes before DOM insertion. To execute scripts, authors must explicitly opt-out of sanitization by setting `sanitize="unsafe"`.
    Furthermore, fetching external templates is governed by Content Security Policy (CSP):
    * The new **`fragment-src`** directive controls which origins are allowed to serve HTML payloads for active templates. Because external templates are sanitized by default, sites can configure a relaxed `fragment-src` policy for trusted CDN content without allowing script-injection paths.
    * If `sanitize="unsafe"` is declared, any inline `<script>` tags loaded from the template must strictly comply with the document's standard **`script-src`** directives (e.g., matching nonce/hash).


11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    Subresources fetched via `<template src="...">` are subject to standard Cross-Origin Resource Sharing (CORS) rules. Cross-origin templates require CORS headers to be read.

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Standard subresource caching and partitioning rules apply.


16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes, these will be integrated into the HTML Standard.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No. Active templates default to a sanitized safe-mode, with an explicit opt-out via `unsafe`.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    No specific impact; active templates are parsed and detached at parsing time, leaving no active network fetches running in BFCache.

19. **What happens when a document that uses your feature gets disconnected?**
    If an active template is disconnected from the document while a network fetch is in progress, the fetch is aborted.

20. **Does your spec define when and how new kinds of errors should be raised?**
    To some extent, though this needs to be further developed.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.



