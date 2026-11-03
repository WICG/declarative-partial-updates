# Hide While Loading (`hidden="while-loading"` & `:loading`)

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

1. **A new `hidden="while-loading"` state** for the global `hidden` attribute, alongside the existing `hidden` (Hidden) and `hidden="until-found"` (Hidden Until Found) states. It opts the element into loading-boundary tracking and hides it by default while it is loading.
2. **`:loading` CSS pseudo-class:** Matches an element in the `while-loading` state while it is parsing and/or while its gating subresources are loading (subject to a browser fallback timeout so stalled subresources never hide content indefinitely).
3. **Customizable UA stylesheet default (`visibility: hidden` + `opacity: 0` + `@starting-style`):** Hides incomplete content while preserving real layout geometry and enabling zero-JS CSS fade-in transitions. It is an ordinary UA style, so authors can override it (e.g. dim instead of hide).
4. **Accessibility & lifecycle (`aria-busy` + `load` event):** Maps `:loading` to implicit `aria-busy="true"` and fires a completion event at the element each time it stops loading.

The attribute stays on the element after loading finishes. If the element starts loading again (for example, a later `streamHTML()` or `<template for>` patch into it), `:loading` matches again and the element is hidden again until it settles.

> [!IMPORTANT]
> **Opt-in only:** `:loading` and the completion event apply only to elements in the `while-loading` state. Flipping `:loading` or queueing tasks on *every* HTML end tag across a document would be prohibitively chatty during parsing.

### At a Glance

```html
<style>
  .card {
    min-height: 12rem;
    /* Fades from 0 -> 1 when :loading clears, thanks to UA @starting-style / opacity: 0 */
    transition: opacity 200ms ease-out;
  }

  /* Dim instead of hiding */
  .feed:loading {
    visibility: visible;
    opacity: 0.5;
  }
</style>

<!-- 1. Shell-to-content card: the shell paints immediately; the card stays hidden while its
        HTML streams in and while card.css + avatar.jpg load, then fades in -->
<article class="card" hidden="while-loading" onload="console.log('Card ready!')">
  <link rel="stylesheet" href="/styles/card.css">
  <img src="/avatars/ada.jpg" width="64" height="64" alt="Ada">
  <p>Bio content streamed or rendered after the app shell...</p>
</article>

<!-- 2. A visible boundary: stays visible but dimmed while loading -->
<section class="feed" hidden="while-loading">...</section>

<!-- 3. Composes with declarative partial updates (<template for> / src) -->
<aside class="card" hidden="while-loading">
  <?marker name="promo">
</aside>
<template for="promo" src="/partials/promo.fragment"></template>
```

---

## Detailed Design

### 1. The `hidden="while-loading"` State

The `hidden` attribute gains a third state, **While Loading**, for the ASCII case-insensitive keyword `while-loading`:

| Keyword | State | Rendering |
|---|---|---|
| (empty / `hidden` / invalid) | Hidden | `display: none` |
| `until-found` | Hidden Until Found | `content-visibility: hidden`, revealed by find-in-page and fragment navigation |
| `while-loading` | **While Loading** | `visibility: hidden; opacity: 0` while `:loading` matches; rendered normally otherwise |

- **IDL reflection:** As with `until-found`, the `HTMLElement.hidden` getter returns the string `"while-loading"` for this state, and setting `el.hidden = "while-loading"` sets the attribute value.
- **Not loading → rendered normally:** An element in the While Loading state that is not `:loading` is rendered as if it had no `hidden` attribute. The UA stylesheet's `[hidden]` rule excludes it the same way it excludes `until-found`.
- **Separate from `loading=lazy`:** Fetch scheduling stays with the `loading` attribute on `<img>`/`<iframe>`. `hidden="while-loading"` is only about presentation and readiness tracking, so `<img loading="lazy" hidden="while-loading">` has no keyword collision and no legacy reflection issue.

#### Backwards compatibility & polyfilling

Browsers that don't support the state treat `hidden="while-loading"` as plain `hidden` (`display: none`), the same as `hidden="until-found"` in browsers without support for it. A polyfill can approximate the native behavior by tracking the element's parsing and subresource loads and removing the `hidden` attribute when the element finishes loading, as `hidden="until-found"` polyfills do when they reveal content. Unlike the native behavior, the polyfilled element won't hide again if it starts loading again.

The failure mode without a polyfill is content that stays hidden, not content that flashes, so pages that can't rely on a polyfill should feature-detect (e.g. `CSS.supports("selector(:loading)")`) before emitting the attribute.

### 2. The `:loading` CSS Pseudo-Class & Shared "Parsing" Definition

An element only matches `:loading` when its `hidden` attribute is in the **While Loading** state. Removing the attribute (or changing its value) immediately stops `:loading` from matching.

When an element is in the While Loading state, `:loading` matches while **any** of the following hold (up to the UA fallback timeout):

- **The element is parsing** *(shared definition with [`delivery: "parse-end"` `MutationObserver`](./parse-end-mutation-observer-explainer.md#1-definition-of-parsing); see also [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) / [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts#12578)):*
  1. It is on the HTML parser's [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) (its start tag has been inserted, and its end tag has not yet been popped), **or**
  2. It is the context element of an active streaming fragment parser—either an active `element.streamHTML*()` call, or an active `<template for="...">` / `<template for="..." src="...">` patch currently streaming into a marker whose parent is this element.
- **Own external resource** (when the element itself is an `<img>`, `<video>`, `<iframe>`, or `<link rel="stylesheet">`):
  - **`<img>` (and `<input type="image">`):** Matches while an active image request is pending (before its `load` or `error` task runs). A `loading="lazy"` image that hasn't started fetching does not match.
  - **`<video>`:** Matches while fetching media resources required for its initial visual state (`poster` image if specified, or metadata/first frame up to `loadeddata` / `error` when `preload` is not `"none"`).
  - **`<iframe>`:** Matches while its child navigable is loading (until the `<iframe>`'s `load` event fires).
  - **`<link rel="stylesheet">`:** Matches while the stylesheet is being fetched and parsed (until `load` or `error`).
- **Pending descendant subresources:** Continues to match after the element finishes parsing while any gating descendant subresource (including an in-flight `<template for="..." src="...">` fetch targeting a marker inside the element) is still pending (see [Subresource Gating](#1-subresource-gating-blockingrender-vs-existing-delays-the-load-event)).
- **Default slow-network fallback timeout:** Matching document-level render-blocking (`blocking="render"`) and `font-display: block` safeguards, browsers apply a default fallback timeout (e.g., **~3 seconds** from when the element begins waiting on network subresources) after which `:loading` stops matching even if a slow subresource has not yet settled—ensuring stalled subresources on poor connections never leave users staring at a permanently blank region.

### 3. Default UA Stylesheet

```css
[hidden="while-loading" i]:loading {
  visibility: hidden;
  opacity: 0;
}

@starting-style {
  [hidden="while-loading" i] {
    opacity: 0;
  }
}
```

The existing `[hidden]:not([hidden="until-found" i])` rule that applies `display: none` also excludes `[hidden="while-loading" i]`.

#### Hiding is a customizable default, not a hard rendering lock

The rule above is in the **normal UA stylesheet** (without `!important` or engine-locked suppression) on purpose: it defines the *default* presentation while loading—just as HTML's `[hidden] { display: none }` is a default that authors can override in CSS. Authors get hiding with zero CSS, and components or design systems can change *how* a loading element looks (for example, `opacity: 0.25`, `filter: blur(6px)`, or custom `@starting-style` keyframes) with ordinary selectors. *(As with `[hidden]`, authors setting unconditional `opacity: 1` or `visibility: visible` on the element itself should scope those overrides with `:not(:loading)` if they want to keep the default hiding.)*

#### Why `visibility: hidden`, `opacity: 0`, and `@starting-style`?

1. **Preserves layout geometry (`visibility: hidden` instead of `display: none`):**
   - Elements inside the container still generate boxes and participate in layout while loading, so `getBoundingClientRect()` / `offsetWidth` return real geometry and subresources (`<link rel="stylesheet">`, eager `<img>`, `<iframe>`) fetch through normal browser pipelines.
   - Explicit container dimensions (`min-height`, `aspect-ratio`, `contain-intrinsic-size`, or Grid/Flexbox tracks) reserve space immediately, preventing layout shifts on reveal.
   - Hit-testing and pointer events are suppressed while `visibility: hidden` is active.
2. **Prevents descendant `visibility: visible` leaks (`opacity: 0`):**
   - Pairing `visibility: hidden` with `opacity: 0` forms a `0`-opacity group so a descendant with `visibility: visible` cannot accidentally paint prematurely.
3. **Zero-JS entry animations (`opacity: 0` + `@starting-style`):**
   - Adding `transition: opacity 200ms` fades the element in when `:loading` clears—both when `:loading` spanned multiple frames and (via `@starting-style`) when cached subresources resolved in the initial frame.
4. **Interaction with inline placeholders (`<?start>...<?end>`):**
   - Because `hidden="while-loading"` hides the **entire** element while `:loading` matches, any fallback/skeleton markup placed *inside* it (e.g., `<aside hidden="while-loading"><?start name="promo">Loading…<?end></aside>`) is **also hidden**. To show a visible skeleton while loading, render it outside the hidden element, put `hidden="while-loading"` on an inner element inside the streamed fragment, or override the default style to keep the element visible.
5. **Find-in-page:**
   - `visibility: hidden` omits descendants from find-in-page (`Ctrl+F` / `Cmd+F`) and the accessibility tree while hidden. Unlike `hidden="until-found"`, find-in-page does not reveal a loading element early; its content becomes searchable once it finishes loading.

### 4. Accessibility: Mapping to `aria-busy`

In WAI-ARIA, [`aria-busy="true"`](https://w3c.github.io/aria/#aria-busy) signals to assistive technologies that an element is currently being populated or modified and that screen readers should wait until updates finish before announcing live changes.

- While an element matches `:loading` (unless overridden by an explicit `aria-busy` attribute), its implicit ARIA state maps to **`aria-busy="true"`**, returning to **`aria-busy="false"`** when `:loading` clears.
- With the default style, `visibility: hidden` keeps half-parsed text and unstyled controls out of the accessibility tree while incomplete, then exposes the complete subtree once ready.
- When authors override the default to keep the element visible, implicit `aria-busy="true"` still communicates the loading state while dimmed or partial content is shown.

### 5. Lifecycle: Firing the Completion Event (`load` vs. Dedicated Event Name)

Each time an element in the While Loading state transitions out of `:loading`—meaning it is no longer parsing **and** all of its gating subresources have settled (or the fallback timeout elapsed)—the browser queues a global task on the DOM manipulation task source to fire a simple (non-bubbling) **`load`** `Event` at that element:

- **Scoped to opted-in elements:** Ordinary containers (`<div>`, `<section>`, `<article>`) without `hidden="while-loading"` **never** fire `load` events on end tags or child resource loads.
- **Reuses `GlobalEventHandlers.onload`:** `<section hidden="while-loading" onload="...">` and `el.addEventListener("load", ...)` work with no new event handler IDL attributes.
- **Subresource errors never wedge visibility:** Just as `window.onload` still fires when an image `404`s or a stylesheet errors, any subresource that fails (or any parser stream that aborts/truncates at EOF) settles its pending count so `:loading` clears and `load` fires.
- **Known quirks of reusing `load` (and alternative event name consideration):**
  1. *`<body>` outlier:* In HTML, `<body onload="...">` / `document.body.onload` is a legacy window-reflecting handler for `window.onload` rather than listening on `<body>` itself (though `document.body.addEventListener("load", ...)` receives target `load` events on `<body>`). Having `<body>` remain an outlier for inline `onload` is acceptable in practice since loading boundaries normally wrap sections inside `<body>`, not `<body>` itself.
  2. *Capture-phase listeners:* Existing `document.addEventListener("load", fn, true)` capture listeners (used by some analytics or image-tracking scripts) will also receive container `load` events (filterable via `e.target.hidden === "while-loading"`).
  3. *Alternative:* If avoiding `body.onload` and capture-listener overlap is preferred over reusing `onload`, we can fire a dedicated non-bubbling event name such as **`loadingend`** or **`contentload`** instead.

---

## Key Design Questions

### 1. Subresource Gating: `blocking="render"` vs. Existing "Delays the Load Event"

Which descendant subresources keep an element in `:loading`?

- **Option A — Reuse HTML's [delays the load event](https://html.spec.whatwg.org/multipage/parsing.html#delay-the-load-event) predicate (scoped to the subtree):** Waits for descendant `<link rel="stylesheet">`, eager `<img>` (and `loading="lazy"` images once started), `<iframe>`, `<script>`, initial `<video>`/`<audio>` poster/metadata, and active `<template for src>` includes. Zero inner-markup boilerplate and 1:1 alignment with `load`, though a single slow eager `<img>` holds back text reveal unless marked `loading="lazy"` (or until the fallback timeout).
- **Option B — Explicit `blocking="render"` on non-stylesheet subresources:** Waits by default only for parser completion, descendant `<link rel="stylesheet">`, and active fragment streams/includes; `<img>`/`<video>`/`<iframe>` only hold back the ancestor when explicitly marked `blocking="render"`. Avoids accidental image stalls, at the cost of inner-markup boilerplate and overloading `<head>`'s `blocking="render"`.

### 2. Lazy Descendants

A `loading="lazy"` image inside a `hidden="while-loading"` element doesn't gate it until its fetch starts. Since a hidden element still has layout boxes, lazy images inside it start fetching as normal once they are near the viewport, and the element is then `:loading` until they settle. Should a lazy image that starts fetching *after* the element has already been revealed re-enter `:loading` (hiding the element again), or should only subresources pending at reveal time count? The current sketch is the latter: once revealed, only new parsing or a new streamed patch re-enters `:loading`.

### 3. Fallback Timeout

We welcome feedback on whether the ~3s slow-network fallback timeout should be configurable via CSS or HTML.

---

## Explored Alternatives & Platform Relationships

<details>
<summary><strong>Explored Alternatives (multi-token <code>loading="hidden"</code>, <code>&lt;template buffer&gt;</code>) &amp; Relationship to Other Features</strong></summary>

### 1. Multi-token global `loading` attribute (`loading="hidden"`, `loading="lazy hidden"`)

An earlier draft promoted `loading` to a global, space-separated token attribute combining fetch scheduling (`eager` | `lazy`) with a `hidden` presentation token. It degraded gracefully on containers (legacy browsers ignore an unknown `loading` attribute), but:

1. **Conflated two concerns:** `loading` means fetch scheduling on `<img>`/`<iframe>`; mixing in presentation made `loading="eager"` double as a "visible boundary" opt-in.
2. **Broke `<img>`/`<iframe>` compatibility:** Shipping browsers parse `loading` as a single enumerated keyword, so `<img loading="lazy hidden">` degrades to *eager*, and changing `img.loading` reflection could affect scripts that check `img.loading === "lazy"`.
3. **Required new IDL** (`loadingList`) and container-level `loading="lazy"` inheritance, which raises its own LCP and preload-scanner questions. Container-level lazy inheritance may still be worth pursuing as a separate proposal.

`hidden="while-loading"` follows the `hidden="until-found"` precedent instead: a hidden state that the browser lifts under specific conditions, with the same "hidden in legacy browsers, polyfillable" compatibility story.

### 2. Off-Screen `DocumentFragment` Buffering (`<template buffer>`)

Buffering fragments inside an inert `DocumentFragment` ([Fragment Include: Explored Alternatives](./fragment-include-explainer.md#explored-alternatives)) did not load subresources or compute layout geometry without bespoke engine rules, could not expose `aria-busy` in place or animate with `@starting-style`, and only helped `<template>` rather than ordinary shell-to-content elements.

### 3. Relationship to Other Platform Features

| Feature | Scope | How it relates |
|---|---|---|
| **Framework `<Suspense>` boundaries** | JS component trees | Solves shell-to-content coordination in userland JS; `hidden="while-loading"` provides a native HTML/CSS counterpart coordinating HTML parsing, `<link rel="stylesheet">`, and media loads. |
| **`hidden="until-found"`** | Hidden content revealed on demand | Same pattern: a `hidden` state with a UA-defined condition for showing the content. `until-found` reveals on find-in-page / fragment navigation; `while-loading` shows the content once it has loaded. |
| **`<link rel="expect" href="#id" blocking="render">`** | Document first paint (`<head>` only) | Holds initial page render for critical above-the-fold elements; `hidden="while-loading"` handles localized shell-to-content and post-first-paint boundaries without blocking the whole page. |
| **`content-visibility: hidden`** | CSS containment & rendering | Skips layout and painting entirely, whereas `hidden="while-loading"` uses `visibility: hidden` so real layout boxes and subresource loads proceed normally. |
| **`<template for>`, `<template for src>`, `streamHTML()`** | Declarative & streaming updates | Stream HTML into shell outlets after first paint; `hidden="while-loading"` prevents half-streamed flashes and FOUC in the live DOM. |
| **`MutationObserver` `delivery: "parse-end"`** | JS observation | Imperative counterpart ([explainer](./parse-end-mutation-observer-explainer.md)) sharing the exact same "element is parsing" definition. |

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`hidden="while-loading"` and `:loading` expose no new cross-origin information: subresource settlement (`<img>`, `<iframe>`, `<link rel="stylesheet">`, `<video>`) already fires observable `load`/`error` events and delays `window.onload`, and clearing `:loading` / firing `load` on an opted-in ancestor when those same subresources settle (whether on load, error, or timeout) adds no new timing channels or script execution capabilities.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. `:loading` and the completion event reflect only HTML parser openness of same-document elements and settlement (load or error) of subresources whose `load`/`error` events are already observable by the embedding document.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. Both load and error settle pending subresource counts identically on the ancestor element, leaking no cross-origin error details.

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
    No. Unlike `<script>`, element `onload` only dispatches a standard `Event` when an opted-in element finishes loading; existing CSP rules for inline event handlers (`script-src`) apply unchanged.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    Cross-origin subresources (`<img>`, `<link rel="stylesheet">`, `<iframe>`, `<template for src>`) follow their existing Fetch/CORS/framing security models; `hidden="while-loading"` inside or around an `<iframe>` exposes nothing across frame boundaries beyond the existing `iframe.onload` signal.

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Identically to normal browsing mode, using the ephemeral profile's partitioned network/cache state.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes, these will be integrated into the HTML and CSS Specifications.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Standard BFCache rules apply; already-loaded elements remain settled across BFCache restoration.

19. **What happens when a document that uses your feature gets disconnected?**
    Disconnecting an opted-in element or its document aborts/settles parser tracking and stops `:loading` matching as appropriate without firing spurious completion events on detached documents.

20. **Does your spec define when and how new kinds of errors should be raised?**
    No new exceptions or error types are raised; subresource failures and slow-network timeouts settle `:loading` gracefully so content is never permanently hidden.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No. Mapping `:loading` to implicit `aria-busy="true"` is one-way from the DOM/style engine to platform accessibility APIs.

22. **What should this questionnaire have asked?**
    Whether visually suppressing content via `hidden="while-loading"` can leave regions permanently blank on stalled networks or subresource errors—mitigated by settling `:loading` on subresource errors/aborts and enforcing a default UA fallback timeout. In browsers without support, the content stays hidden (`display: none`) unless a polyfill or feature detection is used; see [Backwards compatibility & polyfilling](#backwards-compatibility--polyfilling).

</details>
