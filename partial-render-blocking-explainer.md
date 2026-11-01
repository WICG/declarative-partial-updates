# Partial Render Blocking (`hidden="while-loading"` & `:loading`)

## Status of this document

This is an early-stage explainer exploring declarative, element-scoped render blocking on the web platform, incubated alongside [Interleaved HTML Streaming (`<template for>`)](./patching-explainer.md), [Fragment Includes (`<template for src>`)](./fragment-include-explainer.md), and [Parser-Aware `MutationObserver` Records](./parser-mutation-records-explainer.md).

## Overview & Motivation

Today, render blocking on the web platform is **document-wide and `<head>`-only**: `<link rel="stylesheet" blocking="render">` and `<link rel="expect" href="#id" blocking="render">` hold back first paint for the *entire document*. Once the HTML parser enters `<body>` and paints the initial shell, document-level render blocking is over—and even on initial load, holding back the entire page for a secondary widget or slower card hurts First Contentful Paint (FCP).

At the same time, modern pages increasingly deliver HTML incrementally:
- **Chunked server-rendered HTML**, where slow sections stream across multiple network chunks.
- **Out-of-order patches ([`<template for>`](./patching-explainer.md))** and **client-side includes ([`<template for="..." src="...">`](./fragment-include-explainer.md))**, where markup streams into target containers asynchronously after the surrounding layout has already painted.
- **Script-driven HTML streams ([`element.streamHTML()`](./dynamic-markup-revamped-explainer.md))**, where fragments stream progressively into an existing container.

Without an element-scoped way to hold rendering until a subtree is ready, incremental HTML suffers from three visual and accessibility problems:

1. **Half-parsed subtrees:** An element that spans network chunks paints mid-sentence or with half its flex/grid children before its closing tag arrives.
2. **Scoped Flash of Unstyled Content (FOUC):** A component or included fragment that brings its own `<link rel="stylesheet">` paints unstyled markup before that stylesheet finishes loading.
3. **Uncoordinated subresource pop-in:** Avatars, hero images, `<video>` posters, or `<iframe>` embeds inside a newly inserted card pop in piecemeal instead of appearing together cleanly.

### Why hide in the live DOM instead of buffering off-screen?

We previously explored an off-screen buffering attribute on templates (`<template buffer>`, documented in [Fragment Include: Explored Alternatives](./fragment-include-explainer.md#explored-alternatives)), which parsed markup into an inert `DocumentFragment` and swapped it in atomically once stylesheets finished. However, off-screen `DocumentFragment` buffering had structural drawbacks:
- It required bespoke preload-scanner and activation-gating rules because inert `DocumentFragment`s do not normally load subresources.
- It only worked for `<template>`, forcing authors to wrap ordinary server-streamed sections in `<template for buffer>` just to avoid FOUC.
- Because buffered nodes were absent from the live DOM, it could not reserve or measure layout boxes, expose `aria-busy` state, or animate entry with CSS (`@starting-style` / transitions).

Instead, **partial render blocking** keeps elements in the live DOM—computing layout boxes and loading subresources through standard browser pipelines—while visually hiding the element until its parsing and subresources complete.

---

## Proposed Solution

We propose four connected pieces:
1. **`hidden="while-loading"`:** A new state on the global `hidden` attribute that hides an element while it is loading.
2. **`:loading` CSS pseudo-class:** Matches an element while it is still being parsed (on the stack of open elements or active streaming parser context) and/or while its subresources are loading (`src` loading on `<img>`/`<video>`/`<iframe>`, plus gating subresources inside a container).
3. **UA stylesheet (`visibility: hidden` + `@starting-style` `opacity: 0`):** Hides `[hidden="while-loading"]:loading` while preserving layout geometry, and enables zero-JS CSS fade-in transitions on reveal.
4. **Accessibility & lifecycle (`aria-busy` + `load` event):** Maps `:loading` to implicit `aria-busy="true"` and fires a `load` event on the container when loading finishes.

### At a Glance

```html
<style>
  .card {
    min-height: 12rem;
    /* Smoothly fades from 0 -> 1 when :loading clears, thanks to UA @starting-style / opacity: 0 */
    transition: opacity 200ms ease-out;
  }

  /* Optional custom styling for individual loading media */
  img:loading {
    filter: blur(8px);
  }
</style>

<!-- 1. Server-streamed section: hidden while open on the parser stack
        and while card.css + avatar.jpg finish loading -->
<article class="card" hidden="while-loading" onload="console.log('Card ready!')">
  <link rel="stylesheet" href="/styles/card.css">
  <img src="/avatars/ada.jpg" width="64" height="64" alt="Ada">
  <p>Streamed bio content across multiple chunks...</p>
</article>

<!-- 2. Client-side include target: stays hidden while promo.html streams in
        and its subresources load -->
<aside class="card" hidden="while-loading">
  <?marker name="promo">
</aside>
<template for="promo" src="/partials/promo.html"></template>
```

---

## Detailed Design

### 1. The `:loading` CSS Pseudo-Class

The `:loading` pseudo-class reflects whether an element's markup or resource payload is still in flight:

- **Parser openness (any element):** `:loading` matches an element while:
  - It is on the HTML parser's [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) (its start tag has been inserted, and its end tag has not yet been popped), **or**
  - It is the active fragment/streaming parser context element (e.g., an active `element.streamHTML*()` WritableStream, or the target parent receiving an active `<template for="...">` / `<template for="..." src="...">` patch).
  *(This directly parallels `Element.isParsing` in [Parser-Aware `MutationObserver` Records](./parser-mutation-records-explainer.md) and [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) / [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578).)*
- **Replaced / external resource elements (`<img>`, `<video>`, `<iframe>`, `<link rel="stylesheet">`):** `:loading` matches based on `src` / `href` loading:
  - **`<img>` (and `<input type="image">`):** Matches while an active image request is pending (not yet completely available or broken—i.e., before its `load` or `error` task runs). Does not match when `src`/`srcset` is absent.
  - **`<video>`:** Matches while fetching media resources required to display the initial visual state (its `poster` image if specified, or video metadata/first frame up to `loadeddata` / `error` when `preload` is not `"none"`).
  - **`<iframe>`:** Matches while its child navigable is actively loading (until the `<iframe>`'s `load` event fires).
  - **`<link rel="stylesheet">`:** Matches while the stylesheet is being fetched and parsed (until `load` or `error`).
- **Containers with pending subresources:** A container opted into `hidden="while-loading"` (see [Subresource Gating](#1-subresource-gating-blockingrender-vs-delays-the-load-event) below for whether this applies to all containers or only opted-in ones) continues to match `:loading` after its closing tag is parsed until its gating descendant subresources finish loading (or erroring).

### 2. `hidden="while-loading"` and Default UA Stylesheet

The HTML `hidden` global attribute currently supports three states: *hidden* (`hidden` / `hidden=""`), *until-found* (`hidden="until-found"`), and *not hidden* (omitted). This proposal adds a *while-loading* state (`hidden="while-loading"`), reflected as `"while-loading"` via `element.hidden`.

Unlike `hidden="until-found"` (which mutates the DOM by removing the `hidden` attribute when revealed via find-in-page), `hidden="while-loading"` acts as a **state-driven rendering policy** coupled to `:loading`:
- While the element matches `:loading`, it is hidden by the UA stylesheet.
- When `:loading` stops matching, the element becomes visible without mutating its DOM attributes.
- If the container later receives a new streaming update (e.g., another `<template for>` patch or `element.streamHTML()` call), `:loading` matches again automatically while the new update is in flight.

#### Default UA Stylesheet

```css
[hidden="while-loading"]:loading {
  visibility: hidden;
  opacity: 0;
}

@starting-style {
  [hidden="while-loading"] {
    opacity: 0;
  }
}
```

Why this combination of `visibility: hidden`, `opacity: 0`, and `@starting-style`?

1. **Preserves layout geometry (`visibility: hidden` instead of `display: none`):**
   - Elements inside the container still generate boxes and participate in layout while loading. Any inline or module scripts that measure `getBoundingClientRect()` or `offsetWidth` during initialization read real layout dimensions rather than `0x0`.
   - Subresources (`<link rel="stylesheet">`, eager `<img>`, `<iframe>`) fetch and lay out through normal browser pipelines.
   - Explicit dimensions on the container (`min-height`, `aspect-ratio`, `contain-intrinsic-size`, or CSS Grid/Flexbox track sizes) reserve space immediately, preventing layout shifts when the content reveals.
   - Pointer events and hit-testing are suppressed while `visibility: hidden` is active.
2. **Prevents descendant `visibility: visible` leaks (`opacity: 0`):**
   - In CSS, a child with `visibility: visible` inside a `visibility: hidden` parent normally paints on screen. Pairing `visibility: hidden` with `opacity: 0` on `[hidden="while-loading"]:loading` creates a `0`-opacity group so no descendant can paint prematurely while the container is still loading.
3. **Zero-JS entry animations (`opacity: 0` + `@starting-style`):**
   - If `:loading` spans one or more rendered frames, computed `opacity` is `0` while loading and `1` once `:loading` clears (while `visibility` flips from `hidden` to `visible` at the start of the transition). Adding `transition: opacity 200ms` on the element produces a smooth fade-in with no JavaScript.
   - If the element's markup and cached subresources complete within the *same* frame it is inserted (so no frame ever painted while `:loading`), `@starting-style { opacity: 0; }` still provides an initial before-change `opacity: 0` for authors who declared a CSS `transition`—while having zero visual delay when no `transition` is specified.

### 3. Accessibility: Mapping to `aria-busy`

In WAI-ARIA, [`aria-busy="true"`](https://w3c.github.io/aria/#aria-busy) signals to assistive technologies that an element is currently being populated or modified and that screen readers should wait until updates finish before announcing live changes.

- While an element matches `:loading` (when `hidden="while-loading"` is set, or generally for `:loading` containers unless an explicit `aria-busy` attribute is present), its implicit ARIA state maps to **`aria-busy="true"`**, returning to **`aria-busy="false"`** when `:loading` clears.
- Under the default UA `visibility: hidden` rule, half-parsed text nodes and unstyled controls inside `[hidden="while-loading"]:loading` are hidden from the accessibility tree while incomplete, then exposed cleanly once ready.
- If an author overrides `visibility: visible` on the container (for example, to display a visible skeleton or loading indicator on the container box while hiding inner content), the implicit `aria-busy="true"` informs assistive technologies that the container is still actively loading.

### 4. Lifecycle: Firing the `load` Event

When a `hidden="while-loading"` element finishes loading—meaning it is no longer open on the parser stack / streaming context **and** all of its gating subresources have settled—the browser queues a global task on the DOM manipulation task source to fire a simple (non-bubbling) **`load`** `Event` at the element.

- **Reuses `GlobalEventHandlers.onload`:** Because `onload` is already defined on `GlobalEventHandlers` in the HTML Standard, `<section hidden="while-loading" onload="...">` and `el.addEventListener("load", ...)` work without introducing new event handler IDL attributes.
- **Subresource errors never wedge visibility:** Just as `window`'s `load` event still fires even if an image returns `404` or a stylesheet fails to load, any subresource that errors (or any parser stream that aborts/truncates at EOF) stops blocking the container. Once every gating operation has settled (whether via success or error), `:loading` clears and `load` fires so broken subresources never leave content permanently invisible.

---

## Key Design Questions & Extensions

### 1. Subresource Gating: `blocking="render"` vs. Existing "Delays the Load Event"

A central design question is **which descendant subresources** keep a `hidden="while-loading"` container in the `:loading` state (and delay its `load` event):

#### Option A: Reuse HTML's existing "delays the load event" concept (scoped to the subtree)
The HTML Standard already defines a battle-tested set of operations that [delay the load event](https://html.spec.whatwg.org/multipage/parsing.html#delay-the-load-event) of a `Document`:
- `<link rel="stylesheet">`
- Eager `<img>` / `<input type="image">` fetches (and `loading="lazy"` images *only once their fetch has started*)
- `<iframe>` navigations (unless deferred via `loading="lazy"`)
- `<script>` execution inside the subtree
- `<video>` / `<audio>` initial media/poster fetches
- Active `<template for="..." src="...">` includes targeting the subtree

Scoping this exact predicate to the container's subtree means a `hidden="while-loading"` element stays `:loading` while it is parsing or while any descendant in its subtree would delay the load event.
- **Pros:**
  - **Zero inner-markup boilerplate:** Works out of the box with reusable partials, CMS content, and third-party `<template for src>` fragments where the author cannot annotate every inner `<img>` with `blocking="render"`.
  - **1:1 alignment with the `load` event:** What keeps `:loading` active on the container is literally what delays the container's `load` event.
  - **Natural escape hatch via `loading="lazy"`:** Non-critical images or iframes inside the container that specify `loading="lazy"` do not delay the load event before they are fetched.
- **Cons:**
  - A single slow eager `<img>` (e.g., an uncached user avatar) or slow `<iframe>` inside a large section holds back revealing the surrounding text unless marked `loading="lazy"`.

#### Option B: Explicit `blocking="render"` on descendant subresources
Under this model, a `hidden="while-loading"` container waits by default only for **parser completion**, **nested `<template for src>` includes**, and **descendant `<link rel="stylesheet">`** (preventing half-parsed DOM and FOUC). Other subresources (`<img>`, `<video>`, `<iframe>`, `<link rel="preload">`) only hold back the ancestor `hidden="while-loading"` container when they explicitly declare `blocking="render"` (scoped to the nearest `hidden="while-loading"` ancestor rather than the whole document):

```html
<section hidden="while-loading">
  <link rel="stylesheet" href="hero.css"> <!-- blocks section by default -->
  <img src="hero.jpg" blocking="render">   <!-- opted in: blocks section -->
  <img src="badge.png">                    <!-- does not block section -->
</section>
```

- **Pros:**
  - Fine-grained opt-in ensures slow secondary images never delay text rendering by accident.
- **Cons:**
  - Requires modifying inner fragment HTML (`blocking="render"` currently only exists on `<link>`, `<script>`, and `<style>`, and means *document-level* render blocking in `<head>`, so giving `blocking="render"` inside `<body>` ancestor-scoped semantics could be confusing if no `hidden="while-loading"` ancestor is present).
  - Creates a split between when `:loading` clears and when all `<img>`/`<iframe>` descendants have loaded for the container's `load` event.

*(Note: Option A with `loading="lazy"` as the opt-out—potentially paired with `<link rel="preload" blocking="render">` for CSS background images—avoids overloading `blocking="render"` on `<img>`/`<iframe>` while keeping reusable fragments clean.)*

### 2. Extending `loading="eager" | "lazy"` to Any Container

Today, `loading="lazy"` and `loading="eager"` are only supported on individual `<img>` and `<iframe>` elements. Extending `loading="eager" | "lazy"` to **any HTML container element** complements partial render blocking in three ways:

1. **Container-scoped default for descendant subresources:**
   Descendant `<img>`, `<iframe>`, and `<template for="..." src="...">` elements without an explicit `loading` attribute inherit the mode of their nearest ancestor with `loading="lazy"` or `loading="eager"`. Reusable partials (`product-card.html`) no longer need to hardcode whether they appear above or below the fold:
   ```html
   <!-- Above the fold: inner images and includes fetch eagerly -->
   <section loading="eager">
     <?start name="hero-cards">Loading...<?end>
   </section>

   <!-- Below the fold: inner images, iframes, and includes default to lazy -->
   <section loading="lazy">
     <?start name="related-cards">Loading...<?end>
   </section>
   ```
2. **Viewport-deferred `<template for="..." src="...">` includes:**
   When a `<template for="related-cards" src="/related.html">` targets a marker inside a `loading="lazy"` container that is far below the viewport, the browser can defer fetching `/related.html` until the container approaches the viewport (matching `<img loading="lazy">` heuristics).
3. **Clean composition with `hidden="while-loading"`:**
   - On `<section loading="lazy" hidden="while-loading">`, the section defers lazy fetches while far off-screen; once scrolled near the viewport, fetches begin and the section reveals (and fades in) once complete.
   - Inside an *eager* `<section hidden="while-loading">`, explicitly `loading="lazy"` descendants that have not started fetching do not block the parent section from revealing, avoiding deadlocks.

### 3. Backwards Compatibility of `hidden="while-loading"`

> [!IMPORTANT]
> In existing browsers today, HTML's UA stylesheet applies `display: none` to `[hidden]:not([hidden="until-found" i])`. A legacy browser that does not recognize `"while-loading"` will treat `<section hidden="while-loading">` as a boolean `hidden` attribute and apply `display: none` **permanently** (unless cleared by script or overridden in CSS).

We should evaluate three paths for backwards compatibility:
1. **Keep `hidden="while-loading"`** (consistent with `hidden="until-found"`), recommending progressive enhancement in CSS during rollout:
   ```css
   /* Undo display:none in legacy browsers; supporting browsers still apply UA visibility:hidden on :loading */
   @supports not selector(:loading) {
     [hidden="while-loading"] { display: revert; }
   }
   ```
   *(Caveat: legacy browsers would still expose `el.hidden === true` and strip the subtree from the accessibility tree if HTML-AAM maps unrecognized `hidden` states to hidden!)*
2. **Use a dedicated new attribute instead of overloading `hidden`**—for example, `render="while-loading"` (or `cloak` / `loading="cloak"` / `blocking="local"`). Unrecognized attributes are completely ignored by legacy browsers, degrading gracefully to normal progressive streaming rather than permanently hiding content.
3. **Pure CSS via `:loading`:** Since `:loading` + `@supports selector(:loading)` degrades cleanly on its own, verify what `hidden="while-loading"` enables beyond CSS alone (namely: default UA styles without `<head>` stylesheet dependencies, opt-in subtree subresource tracking, implicit `aria-busy`, and firing the `load` event).

### 4. Scope of Subtree `:loading` Tracking (All Elements vs. Opt-In Containers)

- Checking whether an element is open on the parser stack (`isParsing`) or checking `src` state on `<img>`/`<video>`/`<iframe>` is $O(1)$ state the browser already tracks, so `:loading` can match on **all** open elements and `<img>`/`<video>`/`<iframe>`/`<link>` elements unconditionally.
- Propagating descendant subresource state up to arbitrary ancestor `<div>`s (`div:loading` matching because a deep `<img>` child is loading) either requires maintaining pending-subresource counters up the ancestor chain, or scoping automatic subresource propagation to elements with `hidden="while-loading"` (while letting authors write `.container:is(:loading, :has(:loading))` in CSS for arbitrary containers).

### 5. Render-Blocking Timeout / Slow-Network Fallback

Document-level render blocking (and `font-display: swap`) typically enforce a browser-managed timeout on very slow connections so users are not left staring at a blank region indefinitely if a non-critical subresource stalls. Should `hidden="while-loading"` include a default UA timeout (or CSS/attribute control) after which `:loading` stops hiding already-parsed content even if a slow subresource is still pending?

---

## Relationship to Other Platform Features

| Feature | Scope | How it relates |
|---|---|---|
| **`<link rel="expect" href="#id" blocking="render">`** | Document first paint (`<head>` only) | Holds initial page render for critical above-the-fold elements/includes. `hidden="while-loading"` handles localized, post-first-paint, and below-the-fold containers without holding back the whole page. |
| **`<template for>` & `<template for src>`** | Out-of-order streaming & includes | Streams HTML into target ranges; `hidden="while-loading"` on the target container prevents half-streamed flashes and FOUC, replacing `<template buffer>`. |
| **Parser-Aware `MutationObserver` & `Element.isParsing`** | JS observation | Imperative counterpart ([explainer](./parser-mutation-records-explainer.md)) exposing the same parser-openness state to scripts. |
| **`content-visibility: hidden`** | CSS containment & rendering | Skips layout and painting entirely (requiring `contain-intrinsic-size`), whereas `hidden="while-loading"` uses `visibility: hidden` so real layout boxes and subresource loads proceed normally. |

---

## Security and Privacy Considerations

- **No new cross-origin information:** Subresource completion (`<img>`, `<iframe>`, `<link rel="stylesheet">`, `<video>`) already settles `load`/`error` events observable by the embedding document (and delays `window.onload`). Clearing `:loading` and firing `load` on the ancestor container when those same subresources settle (on either load or error) exposes no additional cross-origin state or timing channels.
- **No script execution changes:** Unlike off-screen `DocumentFragment` buffering, `hidden="while-loading"` does not alter when scripts execute or how HTML is parsed or sanitized.
