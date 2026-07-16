# Fragment Include

## Overview

One of the longest-standing design gaps in the HTML standard is the lack of a native, declarative client-side include mechanism (see [WHATWG Issue #2791](https://github.com/whatwg/html/issues/2791)). Historically, developers have relied on Server-Side Includes (SSI), Edge-Side Includes (ESI), or custom JavaScript fetch-and-inject scripts to compose HTML modularly.

While server-side composition is highly performant for many use cases, it is not always the optimal trade-off:
1. **Tooling & Multiplexing Complexity:** Forcing the server to multiplex and assemble all page elements on every request increases runtime complexity, especially for auxiliary widgets (e.g., ads, sidebars, related feeds) that could be fetched asynchronously.
2. **Client-Side Sanitization Gap:** Server-side templating engines do not have access to the browser's native client-side sanitization context. Performing safety filtering at the server level often relies on custom, downstream sanitizers that can easily fall out of sync with browser security updates.
3. **Ergonomic Dev-Time Modularity:** In modern web development, standard ergonomics favor modular development enablers. Similar to how JS Modules (`import`) allow developers to author modular code while letting build/optimization tooling (like bundlers) handle merging if necessary, HTML needs an equivalent modular primitive.

## Relationship to HTML Patching

The proposed [Declarative Out-of-order streaming specification](https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md) addresses out-of-order streaming of markup. While patching offers a powerful streaming update model, it has several limitations when applied to client-side resource inclusion:

1. **Mandatory Streaming:** Patches always stream directly into the live DOM chunk-by-chunk. There is no declarative way to buffer the template content and render it atomically once parsing completes to avoid layout jank.
2. **Mandatory Multiplexing:** Patches must be interleaved inside the main HTML response stream, requiring the server to run interleaving and multiplexing logic.
3. **No Independent Sanitization:** Patches inherit the safety/sanitization permissions of their parent context. They cannot easily be configured to sanitize untrusted content separately.


## Proposed solution

Proposing to extend the `<template>` element to support native, client-side HTML includes and dynamic content updates by introducing the `active` attribute, as well as fetching attributes (`src`, `crossorigin`, `referrerpolicy`, `nonce`, `integrity`, `blocking`).

### Activation Model and Modes
The operational mode of the `<template>` element is explicitly declared and activated using the `active` attribute
which accepts a space-separated list of configuration tokens (represented as a `DOMTokenList` in JS):
  - **`buffered`**: Parses content into a detached buffer and renders it atomically on stream completion.
  - **`unsafe`**: Disables sanitization, allowing full HTML fragment parsing and script execution.
  - **`async`**: Configures the network fetch (`src` present) to be asynchronous and non-blocking relative to document parsing.


#### Default `active` Resolution
To determine the template's activation state and delivery/safety modes, the browser resolves the `active` token list using the following ordered algorithm:

1. **If the `active` attribute is explicitly present**:
   Use the declared token list (e.g. `active=""` resolves to streaming, sanitized; `active="buffered"` resolves to buffered, sanitized).
2. **Else if the `src` attribute is present**:
   Resolve the activation state to **`""`** (streaming, sanitized).
3. **Else if the `for` attribute is present**:
   Resolve the activation state to **`"unsafe"`** (streaming, unsanitized, matching existing "patching" behavior).
4. **Otherwise**:
   Resolve to **`null`** (inert classic template behavior).


Targeting is controlled via the `for` attribute:
- **Targeted Activation (`for="target-name"`)**:
  Applies the template content to a targeted range (`<?start name="target-name">...<?end>`) or insertion point (`<?marker name="target-name">`). Content is inserted **before** the `<?end>` or `<?marker>` node.
- **In-place Activation (omitted or empty `for` with active template)**:
  Inserts the content in-place at the template's position in the HTML stream.

```html
<!-- Inert template (legacy behavior, does not render) -->
<template id="menu-tpl">
  <li>Menu Item</li>
</template>

<!-- Active in-place rendering (streaming, sanitized) -->
<template active>
  <p>Renders progressively in-place.</p>
</template>

<!-- Active in-place rendering (buffered, sanitized) -->
<template active="buffered">
  <p>Renders atomically once fully parsed.</p>
</template>

<!-- Targeted rendering (streaming, unsafe by default) -->
<section id="gallery">
  <?start name="gallery-patch">Loading...<?end>
</section>
<template for="gallery-patch">
  <p>Streams contents directly into the gallery section.</p>
</template>

<!-- Targeted rendering (buffered, sanitized) -->
<section id="comments">
  <?start name="comments-patch">Loading...<?end>
</section>
<template for="comments-patch" active="buffered">
  <p>Inserts atomically once comments are fully parsed.</p>
</template>
```

During active non-targeted template processing (streaming or buffered), the browser temporarily attaches the `<template>` element to the DOM at its declared position to act as the parser's insertion anchor. Incoming content is parsed and inserted directly **before** the template element. Once parsing/streaming completes (network EOF or closing tag), the template element is detached and removed, leaving **zero DOM footprint** in the final tree.

### Resource Fetching and Script Attributes
When the `src` attribute is present, the template fetches its HTML payload over the network.
- `<template active="async" src="fragment.html"></template>`
- Reuses `<script>`'s other network configuration attributes: `blocking`, `nonce`, `crossorigin`, and `referrerpolicy`. Async/non-blocking behavior is controlled directly by the `async` token in the `active` token list.


### Buffering vs. Streaming
- **Streaming (Default active mode)**:
  If the `buffered` token is absent (e.g. `<template active>`), content is progressively parsed and inserted into the live DOM before the marker/template anchor.
- **Buffered (`active="buffered"`)**:
  The browser parses the content directly into the template's own `content` DocumentFragment property. Once parsing completes, the sanitized contents of this DocumentFragment are cloned and inserted in a single batch.


```html
<!-- 1. Streaming (Progressive Render) -->
<!-- In-place: elements render as they arrive from network -->
<template active src="feed-stream.html"></template>

<!-- Targeted: rows stream progressively into tbody without foster-parenting -->
<table>
  <tbody id="table-rows">
    <?start name="rows-patch"><tr><td>Loading rows...</td></tr><?end>
  </tbody>
</table>
<template for="rows-patch" src="rows.html"></template>


<!-- 2. Buffered (Atomic Render once complete) -->
<!-- In-place: parsed to template.content first, inserted in one single batch on EOF -->
<template active="buffered" src="dialog-modal.html"></template>

<!-- Targeted: comments block is parsed fully to fragment and inserted atomically -->
<section id="comments-section">
  <?start name="comments-patch">Loading comments...<?end>
</section>
<template for="comments-patch" active="buffered" src="comments.html"></template>
```

### Security & Sanitization
- **Explicitly Activated (`active` present)**: **Sanitized by default**. To disable sanitization and execute scripts, include the `unsafe` token in the `active` token list.
- **Implicitly Activated (`for` present, `active` omitted)**: **Unsafe by default** (implicitly resolves to `active="unsafe"`), matching standard patching behavior.

```html
<!-- Explicit active: sanitized by default (scripts stripped) -->
<template active src="user-profile.html"></template>

<!-- Explicit active with unsafe token: unsanitized (allows script execution) -->
<template active="unsafe" src="ad.html"></template>

<!-- Explicit active buffered with unsafe token -->
<template active="buffered unsafe" src="modal-widget.html"></template>

<!-- Implicit active: unsafe by default (script runs) -->
<template for="gallery">
  <script>alert(1)</script>
</template>

<!-- Implicit active, but sanitized: explicit active (without unsafe) overrides default -->
<template for="gallery" active>
  <div>User input: <script>alert(1)</script></div>
</template>
```

#### Content Security Policy (CSP) Integration
To allow granular security configuration for declarative includes, this proposal integrates with Content Security Policy (CSP):

1. **`fragment-src` Directive (New):**
   Governs which origins are allowed to serve HTML subresources fetched via `<template active src="url">`. Fallback defaults to `default-src`.
   Since standard active templates (without the `unsafe` token) are sanitized by default (scripts stripped), pages can allow a relaxed `fragment-src` policy (e.g. allowing third-party CDNs or CMS domains) without exposing themselves to script-execution vulnerabilities.
2. **`script-src` Enforcement:**
   If a template includes the `unsafe` token (e.g. `<template active="unsafe" src="...">`), any inline `<script>` tags parsed from the fetched HTML must pass standard `script-src` policies (e.g. nonce or hash checks) to be allowed to execute.

## Performance

The main issue with this approach is that overuse of client-side includes can be a performance anti-pattern vs. multiplexing in the server.
However, this performance drawback is very context dependent.
In some cases, adding markup asynchronously rather than having to multiplex it in the server or passing it through JS setters can be a performance win.
Like with JS modules, bundlers are very mature and authors can make the decision of whether to bundle the markup or fetch it client-side based on their specific context.

## Relative paths in templates

This proposal deliberately *does not* deal with resolving relative paths in the included content.
For keeping this solution focused on the problem space of updating the DOM declaratively, the current semantics of inserting fragments to the document are maintained.
This leaves it up to the author to make sure relative paths in an included fragment are modified to match the document, if desired.

## Relationship with [HTML modules](https://github.com/WICG/webcomponents/issues/645)

The "module-ness" of this is similar to text or JSON modules, where the content is in the module tree and fetched like a module, but is not mutable in a way that affects all of its importers. In JS, you can do:
`import fragment from "something.html" { type: "fragment" }` which returns a cloned, sanitized `DocumentFragment`.

## Alternatives considered

### 1. Introducing a bespoke `<fragment>` element
An alternative is introducing a new bespoke element specifically for in-place or targeted updates, e.g. `<fragment src="fragment.html">` or `<fragment>Inline</fragment>`.

**Why it wasn't chosen:**
1. **HTML Parser Foster-parenting:** Unrecognized/custom elements (and standard layout elements that aren't specific table components) are subject to foster-parenting by the HTML parser. Placing `<fragment>` inside a table (e.g. `<table><tbody><fragment src="rows.html"></fragment></tbody></table>`) will cause the parser to throw it outside the table structure, breaking streaming updates for tables. Modifying HTML parsing table rules is a non-starter due to cross-browser backward compatibility.
2. **Layout Footprint:** Keeping `<fragment>` in the DOM (even with `display: contents`) pollutes the sibling structure, breaking CSS selectors like `:first-child`, `:nth-child`, and sibling combinators (`+`/`~`), as well as JS DOM traversal APIs (`nextSibling`). 

### 2. Extending the `<script>` element
Another alternative is using `<script>` to fetch and render markup:
- `<script type="text/html" src="fragment.html"></script>`

**Why it wasn't chosen:**
The HTML parser treats the content of `<script>` tags as raw text until it matches a closing `</script>` tag. This means any inline markup containing nested `<script>` tags would require escaping the closing tags (e.g. as `<\/script>`). This is a substantial developer footgun for inline templates. Furthermore, inserting arbitrary markup inside table tags from a `<script>` elements can trigger foster-parenting.

### 3. Composing `<script>` and `<template>`
A third alternative is composing the two elements such that `<template active>` acts as the layout/activation wrapper, and a nested `<script type="fragment">` executes to fetch and insert the external resource:
- `<template active buffered><script type="fragment" src="fragment.html"></script></template>`

**Why it wasn't chosen:**
While this separation of concerns is clean for external resource loading (keeping fetch controls on the script and routing/layout on the template), it falls short for inline content. If inline content is written directly inside a `<template active>` container:
```html
<template active>
  <div>Inline content markup</div>
</template>
```
There is no associated script tag to declare sanitization preferences (like `unsafe` or `sanitizer`). To support sanitizing inline content, the `<template>` element itself would have to support sanitization attributes directly. Doing so duplicates all safety/security configuration onto the template, defeating the purpose of separating concerns via composition.

However, composition (with `<template>` as the outer element) retains the key advantage of being allowed inside tables without foster-parenting issues.

### 4. Global `fragment` attribute composed with Script and Template
Another alternative is introducing a global attribute (e.g. `fragment="..."`) that resides on the destination DOM container to handle sanitization and buffering, composed with `<script type="fragment">` for fetching and `<template for>` for out-of-order routing:
- **Sanitization without inclusion:** `<div fragment><a onclick="alert('hi')">X</a></div>`
- **Buffering without inclusion:** `<div fragment="buffered"><!-- lots of content... --></div>`
- **In-place Include:** `<div fragment><script type="fragment" src="fragment.html"></script></div>`
- **Targeted Include:** `<tbody fragment="buffered"><?marker name="rows"?></tbody>` paired with `<template for="rows"><script type="fragment" src="rows.html"></script></template>`

**Why it wasn't chosen:**
1. **Attribute-Based Tree Builder Redirection:** If a developer writes inline content with scripts inside an element annotated with `fragment` (e.g. `<div fragment>some <script>alert(1)</script></div>`), preventing eager script execution requires the HTML tree builder to dynamically redirect parsed tokens into a detached `DocumentFragment` buffer rather than appending them directly to the active element node. In standard HTML parsing, tree builder insertion logic is determined *solely* by the tag name and the current parser context stack. Changing tree builder destination behavior based on arbitrary tag attributes introduces new complexity to the HTML parser construction phase.

2. **Verbosity:** Placing includes in-place requires writing both a wrapper tag (`<div fragment>`) and a nested loader tag (`<script type="fragment">`), which is significantly more verbose for simple inclusions than `<template active src="fragment.html">`.
3. **Action at a Distance for Safety Configuration:** The security policy (`unsafe`) is configured on the *target container* (e.g., `<div fragment="unsafe">`) rather than on the resource loading stream. If a container receives patches/inclusions from multiple independent templates, it must declare `unsafe` globally, potentially allowing script execution from an untrusted template stream.





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
    **Mitigation:** The proposal enforces security-by-default for explicitly activated templates. Explicitly declaring `active` (e.g. `<template active src="...">`) enables HTML sanitization by default, stripping out all script tags and event handler attributes before DOM insertion. To execute scripts, authors must explicitly opt-out of sanitization by including the `unsafe` token in the `active` token list (e.g., `active="unsafe"`). 
    Furthermore, fetching external templates is governed by Content Security Policy (CSP):
    * The new **`fragment-src`** directive controls which origins are allowed to serve HTML payloads for active templates. Because templates are sanitized by default, sites can configure a relaxed `fragment-src` policy for trusted CDN content without allowing script-injection paths.
    * If `unsafe` is declared, any inline `<script>` tags loaded from the template must strictly comply with the document's standard **`script-src`** directives (e.g., matching nonce/hash).


11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    Subresources fetched via `<template active src="...">` are subject to standard Cross-Origin Resource Sharing (CORS) rules. Cross-origin templates require CORS headers to be read.

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



