# Partial Render Blocking (`loading="hidden"` & `:loading`)

## Status of this document

This is an early-stage explainer exploring declarative, element-scoped loading boundaries and render suppression ("Suspense-like" coordination) for the web platform.

## Overview & Motivation

Render blocking on the web platform today is **document-wide and `<head>`-only**: `<link rel="stylesheet" blocking="render">` and `<link rel="expect" href="#id" blocking="render">` hold back first paint for the *entire document*. That model was designed for **top-down** page loads—block in `<head>` until critical styles are ready, then paint `<body>` from top to bottom.

However, this is a long-standing mismatch with how most modern web applications are actually built. Rather than rendering strictly top-down, modern apps render **shell-to-content**:
- An outer application shell (navigation chrome, layout grid, sidebars, skeletons) paints immediately for a fast First Contentful Paint (FCP).
- Independent content regions—cards, feeds, route outlets, widgets, or slow server-rendered sections—populate asynchronously or across chunks, often bringing their own markup, component stylesheets, and media *after* the shell has already painted.
- Even during an initial MPA load, blocking the entire page in `<head>` for a slower secondary section hurts FCP, while letting that section paint incrementally without coordination produces visual jank:
  1. **Half-parsed subtrees:** An element that spans network chunks paints mid-sentence or with half its flex/grid items before its closing tag arrives.
  2. **Localized Flash of Unstyled Content (FOUC):** A self-contained component or server-rendered island that includes `<link rel="stylesheet">` inside `<body>` flashes unstyled HTML before its stylesheet loads.
  3. **Uncoordinated subresource pop-in:** Avatars, hero images, `<video>` posters, or `<iframe>` embeds inside a card pop in piecemeal ("popcorn UI") instead of revealing as a coherent unit.

### How frameworks mitigate this today

Because the browser lacks a native element-level readiness boundary, frameworks build userland primitives to manage shell-to-content rendering—most notably **React `<Suspense>`** (as well as Vue `<Suspense>`, Solid `<Suspense>`, and custom JS skeleton/onload state machines). These boundaries hold back revealing a subtree until its async work finishes.

However, JavaScript framework boundaries cannot natively observe or coordinate browser-level loading pipelines:
- They do not know whether an HTML element is still open on the HTML parser's stack across network chunks without shipping inline scripts or client-side heuristics.
- They cannot natively hold paint for a scoped `<link rel="stylesheet">` or wait for eager `<img>`/`<video>`/`<iframe>` loads inside a subtree without manual JS `onload`/`onerror` counters or off-DOM staging.
- Newer declarative HTML primitives—such as out-of-order streaming ([`<template for>`](./patching-explainer.md)), client-side includes ([`<template for src>`](./fragment-include-explainer.md)), and streaming DOM insertion ([`element.streamHTML()`](./dynamic-markup-revamped-explainer.md))—bring native HTML primitives into this same shell-to-content architecture, making a native HTML/CSS loading boundary even more valuable.

---

## Proposed Solution

We propose extending HTML's `loading` attribute from `<img>` and `<iframe>` into a **global, space-separated token attribute** on all HTML elements:

1. **Multi-token global `loading` attribute (`eager | lazy` and `hidden`):**
   - **Opt-in boundary:** Placing `loading` on any element opts it into loading-boundary tracking.
   - **Scheduling token (`eager` | `lazy`):** Controls fetch scheduling for the element itself (`<img>`, `<iframe>`) and sets the inherited default for descendant subresources inside a container (`<img>`, `<iframe>`, `<template for src>`) that omit an explicit scheduling token.
   - **Presentation token (`hidden`):** Visually suppresses the element while loading (`loading="hidden"`, `loading="lazy hidden"`, `loading="eager hidden"`).
2. **`:loading` CSS pseudo-class (scoped to `[loading]` elements):** Matches an element with a `loading` attribute while it is still being parsed and/or while its gating subresources are loading.
3. **UA stylesheet (`visibility: hidden` + `opacity: 0` + `@starting-style`):** Hides `[loading~="hidden"]:loading` while preserving real layout geometry, and enables zero-JS CSS fade-in transitions on reveal.
4. **Accessibility & lifecycle (`aria-busy` + `load` event on `[loading]` elements):** Maps `:loading` to implicit `aria-busy="true"` and fires a `load` event on the boundary element when loading finishes.

> [!IMPORTANT]
> **Performance & 1:1 mental model:** Both `:loading` and the new container `load` event **only apply to elements with a `loading` attribute**. Flipping `:loading` (invalidating styles) or queueing `load` tasks on *every* HTML end tag (`</div>`, `</p>`, `</li>`, `</span>`) across a document would be prohibitively chatty during parsing. Tying both `:loading` and `onload` directly to `[loading]` makes the opt-in self-explanatory (`loading="..."` $\leftrightarrow$ `:loading` $\leftrightarrow$ `onload`) and lets authors opt into custom *visible* `:loading` styles (`<section loading="eager">`) or automatic hiding (`<section loading="hidden">`) without contradiction.

### At a Glance

```html
<style>
  .card {
    min-height: 12rem;
    /* Smoothly fades from 0 -> 1 when :loading clears, thanks to UA @starting-style / opacity: 0 */
    transition: opacity 200ms ease-out;
  }

  /* Custom visible loading state (opted in via loading="eager" / loading="lazy", without "hidden") */
  .feed:loading {
    opacity: 0.5;
  }
</style>

<!-- 1. Shell-to-content card: shell paints immediately; card stays hidden while its
        HTML streams in and while card.css + avatar.jpg finish loading, then fades in -->
<article class="card" loading="hidden" onload="console.log('Card ready!')">
  <link rel="stylesheet" href="/styles/card.css">
  <img src="/avatars/ada.jpg" width="64" height="64" alt="Ada">
  <p>Bio content streamed or rendered after the app shell...</p>
</article>

<!-- 2. Below-the-fold lazy + hidden boundary: inner images/iframes default to lazy,
        and the section stays hidden while loading once scrolled near the viewport -->
<section class="card" loading="lazy hidden">
  <link rel="stylesheet" href="/styles/gallery.css">
  <img src="/photos/1.jpg" width="300" height="200" alt="">
  <img src="/photos/2.jpg" width="300" height="200" alt="">
</section>

<!-- 3. Composes naturally with declarative partial updates (<template for> / src) -->
<aside class="card" loading="hidden">
  <?marker name="promo">
</aside>
<template for="promo" src="/partials/promo.html"></template>
```

---

## Detailed Design

### 1. The Global Multi-Token `loading` Attribute

`loading` is promoted to a global content attribute on `HTMLElement` parsed as an unordered set of unique space-separated ASCII case-insensitive tokens from two orthogonal categories:

| Category | Tokens | Meaning |
|---|---|---|
| **Fetch scheduling** *(at most one)* | `eager`, `lazy` | Controls whether resource fetching starts immediately (`eager`) or defers until near the viewport (`lazy`). If omitted, inherits from the nearest ancestor with an `eager`/`lazy` token, defaulting to `eager`. |
| **Render suppression** *(optional)* | `hidden` | Applies the UA `[loading~="hidden"]:loading` suppression rules so the element is hidden while `:loading` matches. |

- Writing `loading=""` or `loading="eager"` opts a container into `:loading` pseudo-class matching, `aria-busy`, and the `load` event *without* hiding it—useful when authors want custom visible loading treatments (dimming, shimmer borders, blur) in CSS.
- Writing `loading="hidden"` (equivalent to `loading="eager hidden"` unless inside a `loading="lazy"` ancestor) both opts into boundary tracking and hides the element while `:loading`.
- Writing `loading="lazy hidden"` defers lazy-eligible subresources while far off-screen and hides the boundary until ready.

#### Web IDL & Backwards Compatibility with `img.loading` / `iframe.loading`

Today, `HTMLImageElement` and `HTMLIFrameElement` expose `[CEReactions] attribute DOMString loading` (returning `"eager"` or `"lazy"`, with invalid/missing value default `"eager"`). Changing `.loading` to return a `DOMTokenList` object would break existing scripts checking `typeof img.loading === "string"` or `img.loading === "lazy"`.

Following HTML's `autocomplete` precedent, `loading` moves to the `HTMLElement` mixin as a normalized `DOMString` (optionally paired with `loadingList` like `rel` / `relList`):

```webidl
partial interface HTMLElement {
  [CEReactions] attribute DOMString loading;
  [SameObject, PutForwards=value] readonly attribute DOMTokenList loadingList;
};
```

- On `<img>` and `<iframe>`: `<img loading="lazy">` continues to reflect `"lazy"` and `<img>` continues to reflect `"eager"`, preserving 100% compatibility with existing web content; `<img loading="lazy hidden">` reflects `"lazy hidden"`.
- **Graceful degradation in legacy browsers:**
  - On containers (`<section loading="hidden">`, `<article loading="lazy hidden">`), legacy browsers completely ignore the unrecognized `loading` attribute and render content progressively as usual (avoiding the permanent `display: none` trap of overloading `[hidden]`).
  - On `<img>` and `<iframe>` specifically, legacy browsers treat `loading="lazy hidden"` as an unrecognized single keyword and fall back to `"eager"` (the image still loads and renders normally; it only loses lazy deferral in older browsers).

### 2. The `:loading` CSS Pseudo-Class

An element only matches `:loading` when it has a **`loading` content attribute** (`[loading]`). Removing the `loading` attribute immediately stops `:loading` from matching.

*(Note on existing `<img loading="lazy">` pages: `<img>` and `<iframe>` are leaf/void elements with no HTML end-tag chatter, and browsers already track their fetch completion and queue a single `load`/`error` task per resource—so matching `:loading` on `[loading]` images/iframes adds no new parser invalidation passes, while containers remain 100% opt-in.)*

When an element has a `loading` attribute, `:loading` matches while **any** of the following hold:

- **Parser openness:**
  - The element is on the HTML parser's [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) (its start tag has been inserted, and its end tag has not yet been popped), **or**
  - It is the active fragment/streaming parser context element (e.g., an active `element.streamHTML*()` target, or the target parent receiving an active `<template for="...">` / `<template for="..." src="...">` patch).
  *(This uses the same parser openness condition as [`delivery: "parse-end"` `MutationObserver` buffering](./parse-end-mutation-observer-explainer.md); see also [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) / [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578).)*
- **Own external resource (`<img>`, `<video>`, `<iframe>`, `<link rel="stylesheet">` with `[loading]`):**
  - **`<img>` (and `<input type="image">`):** Matches while an active image request is pending (before its `load` or `error` task runs; for `loading="lazy"`, once its fetch starts—or while deferred if `hidden` is also specified).
  - **`<video>`:** Matches while fetching media resources required for its initial visual state (`poster` image if specified, or metadata/first frame up to `loadeddata` / `error` when `preload` is not `"none"`).
  - **`<iframe>`:** Matches while its child navigable is loading (until the `<iframe>`'s `load` event fires).
  - **`<link rel="stylesheet">`:** Matches while the stylesheet is being fetched and parsed (until `load` or `error`).
- **Pending descendant subresources (containers with `[loading]`):** Continues to match after the container's closing tag is parsed until its gating descendant subresources finish loading or erroring (see [Subresource Gating](#1-subresource-gating-blockingrender-vs-existing-delays-the-load-event)).

### 3. Default UA Stylesheet for `loading~="hidden"`

```css
[loading~="hidden"]:loading {
  visibility: hidden;
  opacity: 0;
}

@starting-style {
  [loading~="hidden"] {
    opacity: 0;
  }
}
```

Why `visibility: hidden`, `opacity: 0`, and `@starting-style`?

1. **Preserves layout geometry (`visibility: hidden` instead of `display: none`):**
   - Elements inside the container still generate boxes and participate in layout while loading. Scripts that measure `getBoundingClientRect()` or `offsetWidth` during initialization read real layout dimensions rather than `0x0`.
   - Subresources (`<link rel="stylesheet">`, eager `<img>`, `<iframe>`) fetch and lay out through normal browser pipelines.
   - Explicit dimensions on the container (`min-height`, `aspect-ratio`, `contain-intrinsic-size`, or CSS Grid/Flexbox track sizes) reserve space immediately, preventing layout shifts when the content reveals.
   - Pointer events and hit-testing are suppressed while `visibility: hidden` is active.
2. **Prevents descendant `visibility: visible` leaks (`opacity: 0`):**
   - In CSS, a child with `visibility: visible` inside a `visibility: hidden` parent normally paints on screen. Pairing `visibility: hidden` with `opacity: 0` creates a `0`-opacity group so no descendant can paint prematurely while the boundary is still loading.
3. **Zero-JS entry animations (`opacity: 0` + `@starting-style`):**
   - If `:loading` spans one or more rendered frames, computed `opacity` transitions from `0` to `1` once `:loading` clears (while `visibility` flips to `visible` at transition start). Adding `transition: opacity 200ms` on the element produces a smooth fade-in with no JavaScript.
   - If markup and cached subresources complete within the *same* frame the element is inserted (so no frame painted while `:loading`), `@starting-style { opacity: 0; }` still provides a before-change `opacity: 0` for CSS transitions—with zero delay when no `transition` is declared.
4. **Reusable across updates:** Because `loading="hidden"` stays on the element without mutating DOM attributes when `:loading` clears, subsequent streaming updates or dynamically inserted stylesheets/images automatically re-enter `:loading` while in flight.

### 4. Accessibility: Mapping to `aria-busy`

In WAI-ARIA, [`aria-busy="true"`](https://w3c.github.io/aria/#aria-busy) signals to assistive technologies that an element is currently being populated or modified and that screen readers should wait until updates finish before announcing live changes.

- While a `[loading]` container matches `:loading` (unless overridden by an explicit `aria-busy` attribute), its implicit ARIA state maps to **`aria-busy="true"`**, returning to **`aria-busy="false"`** when `:loading` clears.
- Under `[loading~="hidden"]:loading`, `visibility: hidden` suppresses half-parsed text nodes and unstyled controls from the accessibility tree while incomplete, then exposes the complete subtree once ready.
- On a visible `[loading]` container without the `hidden` token (e.g., `<section loading="eager">`), implicit `aria-busy="true"` communicates the active loading state to assistive technologies while skeleton or dimmed content is visible.

### 5. Lifecycle: Firing the `load` Event

When a container with a `loading` attribute transitions out of `:loading`—meaning it is no longer open on the parser stack / streaming context **and** all of its gating subresources have settled—the browser queues a global task on the DOM manipulation task source to fire a simple (non-bubbling) **`load`** `Event` at that element.

- **Scoped to `[loading]` elements:** Ordinary containers (`<div>`, `<section>`, `<article>`) without `loading` **never** fire `load` events on end tags or child resource loads. (Elements that already fire `load` in HTML today—such as `<img>`, `<iframe>`, `<link>`, and `<script>`—continue firing their standard single `load`/`error` event as usual.)
- **Reuses `GlobalEventHandlers.onload`:** `<section loading="hidden" onload="...">` and `el.addEventListener("load", ...)` work with no new event handler IDL attributes.
- **Subresource errors never wedge visibility:** Just as `window.onload` still fires when an image `404`s or a stylesheet errors, any subresource that fails (or any parser stream that aborts/truncates at EOF) settles its pending count so `:loading` clears and `load` fires—ensuring broken subresources never leave `loading="hidden"` content permanently invisible.

---

## Key Design Questions

### 1. Subresource Gating: `blocking="render"` vs. Existing "Delays the Load Event"

Which descendant subresources keep a `[loading]` container in the `:loading` state (and delay its `load` event)?

#### Option A: Reuse HTML's existing "delays the load event" concept (scoped to the subtree)
The HTML Standard already defines the exact operations that [delay the load event](https://html.spec.whatwg.org/multipage/parsing.html#delay-the-load-event) of a `Document`:
- `<link rel="stylesheet">`
- Eager `<img>` / `<input type="image">` fetches (and `loading="lazy"` images *only once their fetch has started*)
- `<iframe>` navigations (unless deferred via `loading="lazy"`)
- `<script>` execution inside the subtree
- `<video>` / `<audio>` initial media/poster fetches
- Active `<template for="..." src="...">` includes targeting the subtree

Scoping this predicate to the container's subtree means a `[loading]` container stays `:loading` while it is parsing or while any descendant in its subtree would delay the load event.
- **Pros:**
  - **Zero inner-markup boilerplate:** Works out of the box with reusable components, CMS markup, and third-party partials where authors cannot annotate every inner `<img>` with `blocking="render"`.
  - **1:1 alignment with the container's `load` event:** What keeps `:loading` active on the boundary is literally what delays its `load` event.
  - **Natural escape hatch via `loading="lazy"`:** Non-critical inner images or iframes explicitly marked `loading="lazy"` do not delay an eager boundary before they start fetching; conversely, on `<section loading="lazy hidden">`, once the section approaches the viewport and starts its lazy fetches, `:loading` stays active until they settle.
- **Cons:**
  - A single slow eager `<img>` (e.g., an uncached avatar) or slow `<iframe>` inside a large section holds back revealing the surrounding text unless marked `loading="lazy"`.

#### Option B: Explicit `blocking="render"` on descendant subresources
A `[loading]` container waits by default only for **parser completion**, **descendant `<link rel="stylesheet">`**, and **active fragment streams/includes** (preventing half-parsed DOM and FOUC). Other subresources (`<img>`, `<video>`, `<iframe>`, `<link rel="preload">`) only hold back the nearest `[loading]` ancestor when they explicitly specify `blocking="render"`:

```html
<section loading="hidden">
  <link rel="stylesheet" href="hero.css"> <!-- blocks section by default -->
  <img src="hero.jpg" blocking="render">   <!-- opted in: blocks section -->
  <img src="badge.png">                    <!-- does not block section -->
</section>
```

- **Pros:** Slow secondary images never delay text reveal by accident.
- **Cons:** Requires modifying inner HTML; `blocking="render"` currently means *document-level* render blocking in `<head>`, so giving it ancestor-scoped semantics inside `<body>` may be confusing when no `[loading]` ancestor is present; and it splits `:loading` timing from when all `<img>`/`<iframe>` descendants finish for `load`.

### 2. Lazy Boundary Behavior Before Entering the Viewport (`loading="lazy hidden"`)

When a container has `loading="lazy hidden"` and is far below the viewport (so its inner lazy `<img>` / `<iframe>` / `<template for src>` fetches have not yet started):
- Should `:loading` match immediately from insertion until those deferred fetches eventually run and complete (keeping the below-the-fold container hidden so it fades in smoothly on scroll)?
- Or should `:loading` clear once initial HTML parsing finishes if zero fetches are currently active, and re-enter `:loading` when scrolling triggers the lazy fetches?
Keeping `loading="lazy hidden"` in `:loading` while deferred child fetches remain unstarted avoids flashing empty image boxes when fast-scrolling into view, whereas `<section loading="lazy">` (without `hidden`) remains visible either way.

### 3. Render-Blocking Timeout / Slow-Network Fallback

Document-level render blocking (and `font-display: swap`) typically enforce a browser-managed timeout on slow connections so users are not left staring at a blank region indefinitely if a non-critical subresource stalls. Should `loading="hidden"` include a default UA timeout (or CSS/attribute control) after which `:loading` stops hiding already-parsed content even if a slow subresource is still pending?

---

## Explored Alternatives

### 1. `hidden="while-loading"` (Overloading the `hidden` Attribute)

An earlier draft proposed a new state on the `hidden` attribute (`<section hidden="while-loading">`). Moving to multi-token `loading="hidden"` solved three significant problems:
1. **Severe backwards-compatibility hazard:** HTML's existing UA stylesheet applies `display: none` to `[hidden]:not([hidden="until-found" i])`. Legacy browsers treat `hidden="while-loading"` as boolean `hidden`, permanently hiding the content (and stripping it from the accessibility tree) unless worked around via CSS/JS. By contrast, legacy browsers ignore `loading="hidden"` on containers and render content normally.
2. **Confusing `:loading` scoping & contradiction for visible loading states:** For performance, `:loading` cannot fire on un-annotated elements on every HTML end tag. When gated on `hidden="while-loading"`, authors wanting a *visible* `:loading` style (e.g., `opacity: 0.5` or blur) had to write `hidden="while-loading"` in HTML and override `visibility: visible` in CSS. With `loading`, `<section loading="eager">` opts into `:loading` + `onload` without hiding, while `loading="hidden"` adds hiding cleanly.
3. **Unifies container `loading="eager" | "lazy"` with render suppression:** Both scheduling and suppression live in one attribute (`loading="lazy hidden"`).

### 2. Off-Screen `DocumentFragment` Buffering (`<template buffer>`)

We previously explored buffering fragments off-screen in an inert `DocumentFragment` (`<template buffer>`, see [Fragment Include: Explored Alternatives](./fragment-include-explainer.md#explored-alternatives)) and swapping them in atomically once stylesheets loaded. Off-screen buffering had major drawbacks: inert fragments do not fetch subresources or compute layout boxes without bespoke engine rules, cannot expose `aria-busy` in place, cannot animate entry with `@starting-style`, and only helped `<template>` rather than ordinary shell-to-content HTML elements. Keeping elements in the live DOM with `loading="hidden"` avoids all of these issues.

---

## Relationship to Other Platform Features

| Feature | Scope | How it relates |
|---|---|---|
| **Framework `<Suspense>` boundaries** | JS component trees | Solves shell-to-content coordination in userland JS; `loading="hidden"` provides a native HTML/CSS counterpart that coordinates HTML parsing, `<link rel="stylesheet">`, and media loads. |
| **`<link rel="expect" href="#id" blocking="render">`** | Document first paint (`<head>` only) | Holds initial page render for critical above-the-fold elements. `loading="hidden"` handles localized, shell-to-content, post-first-paint, and below-the-fold boundaries without blocking the whole page. |
| **`content-visibility: hidden`** | CSS containment & rendering | Skips layout and painting entirely (requiring `contain-intrinsic-size`), whereas `loading="hidden"` uses `visibility: hidden` so real layout boxes and subresource loads proceed normally. |
| **`<template for>`, `<template for src>`, `streamHTML()`** | Declarative & streaming updates | Stream HTML into shell outlets after first paint; `loading="hidden"` on the outlet container prevents half-streamed flashes and FOUC without off-screen `<template buffer>` buffering. |
| **`MutationObserver` `delivery: "parse-end"`** | JS observation | Imperative counterpart ([explainer](./parse-end-mutation-observer-explainer.md)) that buffers `MutationRecord` delivery while an observed target is parsing. |

---

## Security and Privacy Considerations

- **No new cross-origin information:** Subresource completion (`<img>`, `<iframe>`, `<link rel="stylesheet">`, `<video>`) already settles `load`/`error` events observable by the embedding document (and delays `window.onload`). Clearing `:loading` and firing `load` on an opted-in `[loading]` ancestor container when those same subresources settle (on either load or error) exposes no additional cross-origin state or timing channels.
- **No script execution changes:** Unlike off-screen `DocumentFragment` buffering, `loading="hidden"` does not alter when scripts execute or how HTML is parsed or sanitized.
