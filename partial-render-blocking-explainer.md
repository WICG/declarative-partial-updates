# Hide While Loading (`loading="hidden"` & `:loading`)

## Status of this document

This is an early-stage explainer exploring declarative, element-scoped loading boundaries and hide-while-loading presentation ("Suspense-like" coordination) for the web platform.

## Overview & Motivation

Coordinating initial rendering on the web platform today is **document-wide and `<head>`-only**: `<link rel="stylesheet" blocking="render">` and `<link rel="expect" href="#id" blocking="render">` hold back first paint for the *entire document*. That model was designed for **top-down** page loads—block in `<head>` until critical styles are ready, then paint `<body>` from top to bottom.

However, modern web applications are overwhelmingly structured around **shell-to-content** delivery rather than top-down document rendering:
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
- They cannot natively hide a subtree while a scoped `<link rel="stylesheet">` or eager `<img>`/`<video>`/`<iframe>` loads without manual JS `onload`/`onerror` counters or off-DOM staging.
- Newer declarative HTML primitives—such as out-of-order streaming ([`<template for>`](./patching-explainer.md)), client-side includes ([`<template for src>`](./fragment-include-explainer.md)), and streaming DOM insertion ([`element.streamHTML()`](./dynamic-markup-revamped-explainer.md))—bring native HTML primitives into this same shell-to-content architecture, making a native HTML/CSS hide-while-loading boundary even more valuable.

---

## Proposed Solution

We propose extending HTML's `loading` attribute from `<img>` and `<iframe>` into a **global, space-separated token attribute** on all HTML elements:

1. **Multi-token global `loading` attribute (`eager | lazy` and `hidden`):**
   - **Opt-in boundary:** Placing `loading` on any element opts it into loading-boundary tracking.
   - **Scheduling token (`eager` | `lazy`):** Controls fetch scheduling for the element itself (`<img>`, `<iframe>`) and sets the inherited default for descendant subresources inside a container (`<img>`, `<iframe>`, `<template for src>`) that omit an explicit scheduling token.
   - **Presentation token (`hidden`):** Opts into the default UA hide-while-loading stylesheet (`loading="hidden"`, `loading="lazy hidden"`, `loading="eager hidden"`).
2. **`:loading` CSS pseudo-class (scoped to `[loading]` elements):** Matches an element with a `loading` attribute while it is parsing and/or while its gating subresources are loading (subject to a browser fallback timeout so stalled subresources never hide content indefinitely).
3. **Customizable UA stylesheet default (`visibility: hidden` + `opacity: 0` + `@starting-style`):** Provides a sensible default for `[loading~="hidden"]:loading` that hides incomplete content while preserving real layout geometry and enabling zero-JS CSS fade-in transitions—while remaining intentionally overridable in the CSS cascade when authors want custom `:loading` styling.
4. **Accessibility & lifecycle (`aria-busy` + `load` event on `[loading]` elements):** Maps `:loading` to implicit `aria-busy="true"` and fires a completion event on the boundary element when loading finishes.

> [!IMPORTANT]
> **Performance & 1:1 mental model:** Both `:loading` and the container completion event **only apply to elements with a `loading` attribute**. Flipping `:loading` (invalidating styles) or queueing tasks on *every* HTML end tag (`</div>`, `</p>`, `</li>`, `</span>`) across a document would be prohibitively chatty during parsing. Tying `:loading` and completion events directly to `[loading]` keeps tracking 100% opt-in on containers. *(See [Key Design Questions](#key-design-questions) for ongoing discussion on visible-boundary opt-in tokens, `<img>` backwards compatibility, and event naming.)*

### At a Glance

```html
<style>
  .card {
    min-height: 12rem;
    /* Smoothly fades from 0 -> 1 when :loading clears, thanks to UA @starting-style / opacity: 0 */
    transition: opacity 200ms ease-out;
  }

  /* Custom visible loading state without hiding */
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

<!-- 3. Composes with declarative partial updates (<template for> / src) -->
<aside class="card" loading="hidden">
  <?marker name="promo">
</aside>
<template for="promo" src="/partials/promo.fragment"></template>
```

---

## Detailed Design

### 1. The Global Multi-Token `loading` Attribute

`loading` is promoted to a global content attribute on `HTMLElement` parsed as an unordered set of unique space-separated ASCII case-insensitive tokens from two orthogonal categories:

| Category | Tokens | Meaning |
|---|---|---|
| **Fetch scheduling** *(at most one)* | `eager`, `lazy` | Controls whether resource fetching starts immediately (`eager`) or defers until near the viewport (`lazy`). If omitted, inherits from the nearest ancestor with an `eager`/`lazy` token, defaulting to `eager`. |
| **Presentation** *(optional)* | `hidden` | Applies the default UA `[loading~="hidden"]:loading` stylesheet rules so the element is hidden while `:loading` matches. |

- Writing `loading="hidden"` both opts into boundary tracking and hides the element by default while `:loading`.
- Writing `loading="lazy hidden"` defers lazy-eligible subresources while far off-screen and hides the boundary until ready.
- Opting into `:loading` and lifecycle events *without* hiding is also supported (currently sketched via `loading="eager"` / `loading=""`; see [Key Design Question #1](#1-opting-into-visible-boundaries--backwards-compatibility-on-img--iframe) for cleaner token/attribute options).

#### Web IDL & Precedent (`rel` / `relList`)

Promoting `loading` to `HTMLElement` removes the separate `loading` IDL attribute declarations from `HTMLImageElement` and `HTMLIFrameElement`. Following HTML's `HTMLLinkElement.rel` / `relList` (and `HTMLAnchorElement.rel` / `relList`) precedent—preserving `typeof img.loading === "string"` while providing `DOMTokenList` ergonomics—`HTMLElement` exposes both `loading` and `loadingList`:

```webidl
partial interface HTMLElement {
  [CEReactions] attribute DOMString loading;
  [SameObject, PutForwards=value] readonly attribute DOMTokenList loadingList;
};
```

- **Graceful degradation on containers:** On containers (`<section loading="hidden">`, `<article loading="lazy hidden">`), legacy browsers ignore the unrecognized `loading` attribute and render content progressively as usual (avoiding the permanent `display: none` trap of overloading `[hidden]`). *(Note: on `<img>` and `<iframe>` specifically, legacy browsers treat multi-token `loading="lazy hidden"` as an invalid enumerated keyword and fall back to `"eager"`; see [Key Design Question #1](#1-opting-into-visible-boundaries--backwards-compatibility-on-img--iframe).)*

### 2. The `:loading` CSS Pseudo-Class & Shared "Parsing" Definition

An element only matches `:loading` when it has a **`loading` content attribute** (`[loading]`). Removing the `loading` attribute immediately stops `:loading` from matching.

*(Note on existing `<img loading="lazy">` pages: `<img>` and `<iframe>` are leaf/void elements with no HTML end-tag chatter, and browsers already track their fetch completion and queue a single `load`/`error` task per resource—so matching `:loading` on `[loading]` images/iframes adds no new parser invalidation passes, while containers remain 100% opt-in.)*

When an element has a `loading` attribute, `:loading` matches while **any** of the following hold (up to the UA fallback timeout):

- **The element is parsing** *(shared definition with [`delivery: "parse-end"` `MutationObserver`](./parse-end-mutation-observer-explainer.md#1-definition-of-parsing); see also [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) / [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts#12578)):*
  1. It is on the HTML parser's [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) (its start tag has been inserted, and its end tag has not yet been popped), **or**
  2. It is the context element of an active streaming fragment parser—either an active `element.streamHTML*()` call, or an active `<template for="...">` / `<template for="..." src="...">` patch currently streaming into a marker whose parent is this element.
- **Own external resource (`<img>`, `<video>`, `<iframe>`, `<link rel="stylesheet">` with `[loading]`):**
  - **`<img>` (and `<input type="image">`):** Matches while an active image request is pending (before its `load` or `error` task runs; for `loading="lazy"`, once its fetch starts—or while deferred if `hidden` is also specified).
  - **`<video>`:** Matches while fetching media resources required for its initial visual state (`poster` image if specified, or metadata/first frame up to `loadeddata` / `error` when `preload` is not `"none"`).
  - **`<iframe>`:** Matches while its child navigable is loading (until the `<iframe>`'s `load` event fires).
  - **`<link rel="stylesheet">`:** Matches while the stylesheet is being fetched and parsed (until `load` or `error`).
- **Pending descendant subresources (containers with `[loading]`):** Continues to match after the container finishes parsing while any gating descendant subresource (including an in-flight `<template for="..." src="...">` fetch targeting a marker inside the container) is still pending (see [Subresource Gating](#2-subresource-gating-blockingrender-vs-existing-delays-the-load-event)).
- **Default slow-network fallback timeout:** Matching document-level render-blocking (`blocking="render"`) and `font-display: block` safeguards, browsers apply a default fallback timeout (e.g., **~3 seconds** from when the boundary begins waiting on network subresources) after which `[loading~="hidden"]` stops suppressing rendering of already-parsed content even if a slow subresource has not yet settled—ensuring stalled subresources on poor connections never leave users staring at a permanently blank region.

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

#### `"hidden"` is a customizable default, not a hard rendering lock

Putting `[loading~="hidden"]:loading` in the **normal UA stylesheet** (without `!important` or engine-locked suppression) is **deliberate**: `"hidden"` defines the *default* presentation while loading—just as HTML's `[hidden] { display: none }` provides a default style that authors can customize in CSS. This gives authors zero-CSS hiding out of the box, while letting components or design systems override *how* a `loading="hidden"` element looks while loading (for example, `opacity: 0.25`, `filter: blur(6px)`, or custom `@starting-style` keyframes) using ordinary CSS selectors. *(As with `[hidden]`, authors setting unconditional `opacity: 1` or `visibility: visible` on the element itself should scope those overrides with `:not(:loading)` if they want to preserve the default hiding behavior.)*

#### Why `visibility: hidden`, `opacity: 0`, and `@starting-style`?

1. **Preserves layout geometry (`visibility: hidden` instead of `display: none`):**
   - Elements inside the container still generate boxes and participate in layout while loading, so `getBoundingClientRect()` / `offsetWidth` return real geometry and subresources (`<link rel="stylesheet">`, eager `<img>`, `<iframe>`) fetch through normal browser pipelines.
   - Explicit container dimensions (`min-height`, `aspect-ratio`, `contain-intrinsic-size`, or Grid/Flexbox tracks) reserve space immediately, preventing layout shifts on reveal.
   - Hit-testing and pointer events are suppressed while `visibility: hidden` is active.
2. **Prevents descendant `visibility: visible` leaks (`opacity: 0`):**
   - Pairing `visibility: hidden` with `opacity: 0` forms a `0`-opacity group so a descendant with `visibility: visible` cannot accidentally paint prematurely.
3. **Zero-JS entry animations (`opacity: 0` + `@starting-style`):**
   - Adding `transition: opacity 200ms` smoothly fades the container in when `:loading` clears—both when `:loading` spanned multiple frames and (via `@starting-style`) when cached subresources resolved in the initial frame.
4. **Interaction with inline placeholders (`<?start>...<?end>`):**
   - Because `loading="hidden"` hides the **entire** container while `:loading` matches, any fallback/skeleton markup placed *inside* that same container (e.g., `<aside loading="hidden"><?start name="promo">Loading…<?end></aside>`) will **also be hidden**. To show a visible skeleton or spinner while loading, either omit `hidden` on the container holding `<?start>...<?end>`, render the skeleton as a sibling/wrapper *outside* the `loading="hidden"` element, or place `loading="hidden"` on an inner element inside the streamed fragment.
5. **Find-in-page & below-the-fold `loading="lazy hidden"`:**
   - Standard `visibility: hidden` omits descendants from browser find-in-page (`Ctrl+F` / `Cmd+F`) and the accessibility tree while hidden. Consequently, `loading="lazy hidden"` far below the fold is best suited for visual media/widget sections rather than primary searchable article text (where `loading="lazy"` without `hidden` keeps text immediately searchable).

### 4. Accessibility: Mapping to `aria-busy`

In WAI-ARIA, [`aria-busy="true"`](https://w3c.github.io/aria/#aria-busy) signals to assistive technologies that an element is currently being populated or modified and that screen readers should wait until updates finish before announcing live changes.

- While a `[loading]` container matches `:loading` (unless overridden by an explicit `aria-busy` attribute), its implicit ARIA state maps to **`aria-busy="true"`**, returning to **`aria-busy="false"`** when `:loading` clears.
- Under `[loading~="hidden"]:loading`, `visibility: hidden` suppresses half-parsed text nodes and unstyled controls from the accessibility tree while incomplete, then exposes the complete subtree once ready.
- On a visible `[loading]` container without `hidden`, implicit `aria-busy="true"` communicates the active loading state to assistive technologies while skeleton or dimmed content is visible.

### 5. Lifecycle: Firing the Completion Event (`load` vs. Dedicated Event Name)

When a container with a `loading` attribute transitions out of `:loading`—meaning it is no longer parsing **and** all of its gating subresources have settled—the browser queues a global task on the DOM manipulation task source to fire a simple (non-bubbling) **`load`** `Event` at that element:

- **Scoped to `[loading]` elements:** Ordinary containers (`<div>`, `<section>`, `<article>`) without `loading` **never** fire `load` events on end tags or child resource loads.
- **Reuses `GlobalEventHandlers.onload`:** `<section loading="hidden" onload="...">` and `el.addEventListener("load", ...)` work with no new event handler IDL attributes.
- **Subresource errors never wedge visibility:** Just as `window.onload` still fires when an image `404`s or a stylesheet errors, any subresource that fails (or any parser stream that aborts/truncates at EOF) settles its pending count so `:loading` clears and `load` fires.
- **Known quirks of reusing `load` (and alternative event name consideration):**
  1. *`<body>` outlier:* In HTML, `<body onload="...">` / `document.body.onload` is a legacy window-reflecting handler for `window.onload` rather than listening on `<body>` itself (though `document.body.addEventListener("load", ...)` receives target `load` events on `<body>`). Having `<body>` remain an outlier for inline `onload` is acceptable in practice since loading boundaries normally wrap sections inside `<body>`, not `<body>` itself.
  2. *Capture-phase listeners:* Existing `document.addEventListener("load", fn, true)` capture listeners (used by some analytics or image-tracking scripts) will also receive container `load` events (filterable via tag name or `e.target.hasAttribute("loading")`).
  3. *Alternative:* If avoiding `body.onload` and capture-listener overlap is preferred over reusing `onload`, we can fire a dedicated non-bubbling event name such as **`loadingend`** or **`contentload`** instead.

---

## Key Design Questions

### 1. Opting into Visible Boundaries & Backwards Compatibility on `<img>` / `<iframe>`

Two design details of multi-token `loading` warrant discussion:
- **Visible boundary opt-in:** Using `loading="eager"` or `loading=""` on `<section>` to opt into `:loading` + `onload` *without* hiding overloads a fetch-scheduling keyword (`eager`). Adding an explicit presentation token such as `loading="visible"` (pairing `hidden | visible` orthogonally with `eager | lazy`), or splitting boundary presentation into a dedicated attribute, would make the opt-in clearer.
- **`<img loading="lazy hidden">` in legacy browsers:** Shipping browsers parse `HTMLImageElement.loading` as a single enumerated keyword (`"eager" | "lazy"`, invalid default `"eager"`), so `<img loading="lazy hidden">` degrades to *eager* in older browsers (and changing `img.loading` string reflection could affect scripts checking `img.loading === "lazy"`). Possible resolutions include keeping `hidden` container-only, keeping `img.loading` enum reflection unchanged while exposing tokens on `loadingList`, or using a separate attribute for hide-while-loading.

### 2. Subresource Gating: `blocking="render"` vs. Existing "Delays the Load Event"

Which descendant subresources keep a `[loading]` container in `:loading`?

- **Option A — Reuse HTML's [delays the load event](https://html.spec.whatwg.org/multipage/parsing.html#delay-the-load-event) predicate (scoped to the subtree):** Waits for descendant `<link rel="stylesheet">`, eager `<img>` (and `loading="lazy"` images once started), `<iframe>`, `<script>`, initial `<video>`/`<audio>` poster/metadata, and active `<template for src>` includes. Zero inner-markup boilerplate and 1:1 alignment with `load`, though a single slow eager `<img>` holds back text reveal unless marked `loading="lazy"` (or until the fallback timeout).
- **Option B — Explicit `blocking="render"` on non-stylesheet subresources:** Waits by default only for parser completion, descendant `<link rel="stylesheet">`, and active fragment streams/includes; `<img>`/`<video>`/`<iframe>` only hold back the `[loading]` ancestor when explicitly marked `blocking="render"`. Avoids accidental image stalls, at the cost of inner-markup boilerplate and overloading `<head>`'s `blocking="render"`.

### 3. Container `loading="lazy"` Inheritance & LCP

Allowing `<section loading="lazy">` to set the default scheduling mode for descendant `<img>`, `<iframe>`, and `<template for src>` elements avoids repeating `loading="lazy"` on every element inside a below-the-fold section. Unlike browser *auto-lazy* heuristics, `<section loading="lazy">` is an explicit author signal—authors would not place their primary LCP hero inside a lazy section to begin with (and an explicit `loading="eager"` on a descendant can always override). Still, two aspects merit further discussion:
- **Responsive layouts & reusable components:** A sidebar or secondary section below the fold on desktop may shift above the fold on mobile viewports, accidentally deferring an LCP candidate if authors apply `loading="lazy"` broadly to layout wrappers.
- **Preload scanner state:** Speculative preload scanners must track ancestor `loading` tokens on an open-tag stack before full tree construction (similar to existing `<picture>` / `<template>` tracking).

### 4. Lazy Boundary State Before Entering the Viewport (`loading="lazy hidden"`)

When `<section loading="lazy hidden">` is far below the viewport (so inner lazy fetches have not yet started), keeping `:loading` active from insertion until those deferred fetches eventually run and complete avoids flashing empty image boxes on fast scroll (whereas `<section loading="lazy">` without `hidden` stays visible throughout). We also welcome feedback on whether the ~3s slow-network fallback timeout should be configurable via CSS or HTML.

---

## Explored Alternatives & Platform Relationships

<details>
<summary><strong>Explored Alternatives (`hidden="while-loading"`, `<template buffer>`) & Relationship to Other Features</strong></summary>

### 1. `hidden="while-loading"` (Overloading the `hidden` Attribute)

An earlier draft proposed `<section hidden="while-loading">`. Moving to `loading="hidden"` solved three major issues:
1. **Backwards-compatibility hazard:** HTML's UA stylesheet applies `display: none` to `[hidden]:not([hidden="until-found" i])`, so legacy browsers permanently hide `hidden="while-loading"` content. Legacy browsers ignore `loading="hidden"` on containers and render content normally.
2. **Contradiction for visible `:loading` states:** Gating `:loading` on `hidden="while-loading"` forced authors wanting visible `:loading` styles (`opacity: 0.5`) to write `hidden="while-loading"` and override `visibility: visible`.
3. **Unifies scheduling and presentation:** Combines `lazy` and `hidden` cleanly on containers (`loading="lazy hidden"`).

### 2. Off-Screen `DocumentFragment` Buffering (`<template buffer>`)

Buffering fragments inside an inert `DocumentFragment` ([Fragment Include: Explored Alternatives](./fragment-include-explainer.md#explored-alternatives)) did not load subresources or compute layout geometry without bespoke engine rules, could not expose `aria-busy` in place or animate with `@starting-style`, and only helped `<template>` rather than ordinary shell-to-content elements.

### 3. Relationship to Other Platform Features

| Feature | Scope | How it relates |
|---|---|---|
| **Framework `<Suspense>` boundaries** | JS component trees | Solves shell-to-content coordination in userland JS; `loading="hidden"` provides a native HTML/CSS counterpart coordinating HTML parsing, `<link rel="stylesheet">`, and media loads. |
| **`<link rel="expect" href="#id" blocking="render">`** | Document first paint (`<head>` only) | Holds initial page render for critical above-the-fold elements; `loading="hidden"` handles localized shell-to-content and post-first-paint boundaries without blocking the whole page. |
| **`content-visibility: hidden`** | CSS containment & rendering | Skips layout and painting entirely, whereas `loading="hidden"` uses `visibility: hidden` so real layout boxes and subresource loads proceed normally. |
| **`<template for>`, `<template for src>`, `streamHTML()`** | Declarative & streaming updates | Stream HTML into shell outlets after first paint; `loading="hidden"` prevents half-streamed flashes and FOUC in the live DOM. |
| **`MutationObserver` `delivery: "parse-end"`** | JS observation | Imperative counterpart ([explainer](./parse-end-mutation-observer-explainer.md)) sharing the exact same "element is parsing" definition. |

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`loading="hidden"` and `:loading` expose no new cross-origin information: subresource settlement (`<img>`, `<iframe>`, `<link rel="stylesheet">`, `<video>`) already fires observable `load`/`error` events and delays `window.onload`, and clearing `:loading` / firing `load` on an opted-in `[loading]` ancestor when those same subresources settle (whether on load, error, or timeout) adds no new timing channels or script execution capabilities.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. `:loading` and the container completion event reflect only HTML parser openness of same-document elements and settlement (load or error) of subresources whose `load`/`error` events are already observable by the embedding document.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. Both load and error settle pending subresource counts identically on the ancestor container, leaking no cross-origin error details.

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
    No. Unlike `<script>`, container `onload` only dispatches a standard `Event` when an opted-in `[loading]` boundary finishes loading; existing CSP rules for inline event handlers (`script-src`) apply unchanged.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    Cross-origin subresources (`<img>`, `<link rel="stylesheet">`, `<iframe>`, `<template for src>`) follow their existing Fetch/CORS/framing security models; `loading="hidden"` inside or around an `<iframe>` exposes nothing across frame boundaries beyond the existing `iframe.onload` signal.

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Identically to normal browsing mode, using the ephemeral profile's partitioned network/cache state.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes, these will be integrated into the HTML and CSS Specifications.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Standard BFCache rules apply; already-loaded `[loading]` boundaries remain settled across BFCache restoration.

19. **What happens when a document that uses your feature gets disconnected?**
    Disconnecting a `[loading]` element or its document aborts/settles parser tracking and stops `:loading` matching as appropriate without firing spurious completion events on detached documents.

20. **Does your spec define when and how new kinds of errors should be raised?**
    No new exceptions or error types are raised; subresource failures and slow-network timeouts settle `:loading` gracefully so content is never permanently hidden.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No. Mapping `:loading` to implicit `aria-busy="true"` is one-way from the DOM/style engine to platform accessibility APIs.

22. **What should this questionnaire have asked?**
    Whether visually suppressing content via `loading="hidden"` can leave regions permanently blank on stalled networks or subresource errors—mitigated by settling `:loading` on subresource errors/aborts and enforcing a default UA fallback timeout.

</details>
