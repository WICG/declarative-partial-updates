# Hide While Loading (`hidden="while-loading"`)

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

1. **A new `hidden="while-loading"` state** for the global `hidden` attribute, alongside the existing `hidden` (Hidden) and `hidden="until-found"` (Hidden Until Found) states. The element is hidden and [inert](https://html.spec.whatwg.org/multipage/interaction.html#inert) while it is loading. When loading finishes, the browser removes the attribute and fires `load` at the element.
2. **Customizable UA stylesheet default (`visibility: hidden` + `opacity: 0` + `@starting-style`):** Hides incomplete content while preserving real layout geometry and enabling zero-JS CSS fade-in transitions. It is an ordinary UA style, so authors can override it (e.g. dim instead of hide) with `[hidden="while-loading" i]` selectors.
3. **Accessibility & lifecycle:** The element is implicitly `aria-busy="true"` while loading, and fragment navigation to content inside it waits until it is revealed.

**Modeled on `hidden="until-found"`:** Like `until-found`, which the browser removes when find-in-page or fragment navigation reveals content, `hidden="while-loading"` is **one-shot**: the browser removes it once the element finishes loading. The attribute's presence therefore *is* the loading state, so no new pseudo-class is needed (`[hidden="while-loading" i]` matches exactly while the element is loading, as `[hidden="until-found" i]` matches exactly while content is unrevealed). Content that has been shown is never hidden again by later updates (for example, a later `streamHTML()` or `<template for>` patch into it), so text the user is reading, a focused control, or a find-in-page match doesn't disappear. To hide an element during a later update, set `hidden="while-loading"` again before starting it.

> [!IMPORTANT]
> **Opt-in only:** loading tracking and the completion event apply only to elements in the `while-loading` state. Tracking every element and queueing tasks on *every* HTML end tag across a document would be prohibitively chatty during parsing.

### At a Glance

```html
<style>
  .card {
    min-height: 12rem;
    /* Fades from 0 -> 1 when the attribute is removed, thanks to UA @starting-style / opacity: 0 */
    transition: opacity 200ms ease-out;
  }

  /* Dim instead of hiding (the element stays inert while loading) */
  .feed[hidden="while-loading" i] {
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

<!-- 2. Dimmed instead of hidden while loading -->
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

| Keyword | State | Rendering | Removed by the browser when |
|---|---|---|---|
| (empty / `hidden` / invalid) | Hidden | `display: none` | never |
| `until-found` | Hidden Until Found | `content-visibility: hidden` | find-in-page or fragment navigation reveals content inside it |
| `while-loading` | **While Loading** | `visibility: hidden; opacity: 0`, and the element is inert | the element has finished loading |

- **IDL reflection:** As with `until-found`, the `HTMLElement.hidden` getter returns the string `"while-loading"` for this state, and setting `el.hidden = "while-loading"` sets the attribute value. Once the element has loaded and the attribute is removed, `el.hidden` returns `false`.
- **Inert while loading:** An element in the While Loading state is [inert](https://html.spec.whatwg.org/multipage/interaction.html#inert), like an element with the `inert` attribute: it and its descendants can't be focused or clicked and are hidden from assistive technology and find-in-page. This holds even if author CSS makes the element or a descendant visible (`visibility: visible`), so a dimmed or partially visible loading region can't be interacted with before it is complete. `hidden="until-found"` gets the same guarantee from `content-visibility: hidden`, which can't be used here because it skips layout (see [below](#why-visibility-hidden-opacity-0-and-starting-style)).
- **Separate from `loading=lazy`:** Fetch scheduling stays with the `loading` attribute on `<img>`/`<iframe>`. `hidden="while-loading"` is only about presentation and readiness tracking, so `<img loading="lazy" hidden="while-loading">` has no keyword collision.

### 2. When Is an Element Loading?

An element in the While Loading state is **loading** while **any** of the following hold:

- **The element is parsing** *(shared definition with [`element.isParsing` and parse-end `MutationObserver`](./parse-end-mutation-observer-explainer.md#1-definition-of-parsing); see also [whatwg/html#12200](https://github.com/whatwg/html/issues/12200) / [w3c/csswg-drafts#12578](https://github.com/w3c/csswg-drafts/issues/12578)):*
  1. It is on the HTML parser's [stack of open elements](https://html.spec.whatwg.org/multipage/parsing.html#stack-of-open-elements) (its start tag has been inserted, and its end tag has not yet been popped), **or**
  2. It is the context element of an open streaming fragment parser—either an open `element.streamHTML*()` stream (from the moment the stream is created until it is closed or aborted, even before any chunk is written), or an active `<template for="...">` / `<template for="..." src="...">` patch currently streaming into a marker whose parent is this element.
- **Own external resource** (when the element itself is an `<img>`, `<video>`, `<iframe>`, or `<link rel="stylesheet">`):
  - **`<img>` (and `<input type="image">`):** An active image request is pending (before its `load` or `error` task runs). A `loading="lazy"` image that hasn't started fetching isn't loading.
  - **`<video>`:** Media resources required for its initial visual state are being fetched (`poster` image if specified, or metadata/first frame up to `loadeddata` / `error` when `preload` is not `"none"`).
  - **`<iframe>`:** Its child navigable is loading (until the `<iframe>`'s `load` event fires).
  - **`<link rel="stylesheet">`:** The stylesheet is being fetched and parsed (until `load` or `error`).
- **Pending descendant subresources:** After the element finishes parsing, any gating descendant subresource (including an in-flight `<template for="..." src="...">` fetch targeting a marker inside the element) is still pending (see [Subresource Gating](#1-subresource-gating-blockingrender-vs-existing-delays-the-load-event)).
- **Default slow-network fallback timeout:** As with `font-display: block`, browsers apply a default fallback timeout (e.g., **~3 seconds** from when the element begins waiting on network subresources) after which the element stops being loading even if a slow subresource has not yet settled—ensuring stalled subresources on poor connections never leave users staring at a permanently blank region.

### 3. Revealing: Removing the Attribute

Like the [ancestor revealing algorithm](https://html.spec.whatwg.org/multipage/interaction.html#ancestor-revealing-algorithm) for `until-found`, removal is an explicit algorithm, not a side effect of style matching. As part of [update the rendering](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering), before style and layout are updated, for each element in the document whose `hidden` attribute is in the While Loading state and which is not loading:

1. If the element is not connected, or its `hidden` attribute is no longer in the While Loading state, skip it.
2. Remove the element's `hidden` attribute.
3. Queue a global task on the DOM manipulation task source to fire `load` at the element (see [Lifecycle](#6-lifecycle-firing-the-completion-event-load-vs-dedicated-event-name)).

Consequences:

- **No flash of incomplete content:** The check runs right before the frame is produced, so the first frame that shows the element shows it complete.
- **Setting the attribute on an element that isn't loading** (e.g. a script-created element whose children are already settled) removes it at the next rendering update.
- **Observable as a normal mutation:** The removal is an ordinary attribute mutation, observable by `MutationObserver`, just like the `until-found` removal.

### 4. Default UA Stylesheet

```css
[hidden="while-loading" i]:not(embed) {
  visibility: hidden;
  opacity: 0;
}

@starting-style {
  [hidden="while-loading" i]:not(embed) {
    opacity: 0;
  }
}
```

The existing `[hidden]:not([hidden="until-found" i]):not(embed)` rule that applies `display: none` also excludes `[hidden="while-loading" i]`.

#### Hiding is a customizable default, not a hard rendering lock

The rule above is in the **normal UA stylesheet** (without `!important` or engine-locked suppression) on purpose: it defines the *default* presentation while loading—just as HTML's `[hidden] { display: none }` is a default that authors can override in CSS. Authors get hiding with zero CSS, and components or design systems can change *how* a loading element looks (for example, `opacity: 0.25`, `filter: blur(6px)`, or custom `@starting-style` keyframes) with ordinary `[hidden="while-loading" i]` selectors. Overriding the style never makes a loading element interactive: it stays inert until the attribute is removed. *(As with `[hidden]`, authors setting unconditional `opacity: 1` or `visibility: visible` on the element itself should scope those overrides with `:not([hidden="while-loading" i])` if they want to keep the default hiding.)*

#### Why `visibility: hidden`, `opacity: 0`, and `@starting-style`?

1. **Preserves layout geometry (`visibility: hidden` instead of `display: none` or `content-visibility: hidden`):**
   - Elements inside the container still generate boxes and participate in layout while loading, so `getBoundingClientRect()` / `offsetWidth` return real geometry and subresources (`<link rel="stylesheet">`, eager `<img>`, `<iframe>`, and lazy images near the viewport) fetch through normal browser pipelines.
   - Explicit container dimensions (`min-height`, `aspect-ratio`, `contain-intrinsic-size`, or Grid/Flexbox tracks) reserve space immediately, preventing layout shifts on reveal.
2. **Prevents descendant `visibility: visible` from painting (`opacity: 0`):**
   - Pairing `visibility: hidden` with `opacity: 0` forms a `0`-opacity group so a descendant with `visibility: visible` cannot accidentally paint prematurely. Focus, hit-testing, and accessibility are handled by inertness, not by these styles.
3. **Zero-JS entry animations (`opacity: 0` + `@starting-style`):**
   - Adding `transition: opacity 200ms` fades the element in when the attribute is removed—both when loading spanned multiple frames and (via `@starting-style`) when cached subresources resolved in the initial frame.
4. **Interaction with inline placeholders (`<?start>...<?end>`):**
   - Because `hidden="while-loading"` hides the **entire** element while it is loading, any fallback/skeleton markup placed *inside* it (e.g., `<aside hidden="while-loading"><?start name="promo">Loading…<?end></aside>`) is **also hidden**. To show a visible skeleton while loading, render it outside the hidden element, put `hidden="while-loading"` on an inner element inside the streamed fragment, or override the default style to keep the element visible.

### 5. Accessibility, Find-in-Page & Fragment Navigation

- **`aria-busy`:** While an element is in the While Loading state (unless overridden by an explicit `aria-busy` attribute), its implicit ARIA state is **`aria-busy="true"`**. In WAI-ARIA, [`aria-busy="true"`](https://w3c.github.io/aria/#aria-busy) signals that an element is being populated and that assistive technologies should wait before announcing changes.
- **Out of the accessibility tree until complete:** Because the element is inert, half-parsed text and unstyled controls stay out of the accessibility tree while incomplete, and the complete subtree is exposed once the attribute is removed.
- **Find-in-page:** Inert content isn't searchable. Unlike `hidden="until-found"`, find-in-page does not reveal a loading element early; its content becomes searchable once it finishes loading.
- **Fragment navigation waits for the reveal:** If the [indicated part](https://html.spec.whatwg.org/multipage/browsing-the-web.html#the-indicated-part-of-the-document) of a fragment navigation (or a text fragment match) is inside an element in the While Loading state, the browser waits until that element is revealed before scrolling to it and setting the sequential focus navigation starting point, instead of scrolling to invisible content that may still move. This is the same treatment the document already gives to `<link rel="expect" blocking="render">` targets.

### 6. Lifecycle: Firing the Completion Event (`load` vs. Dedicated Event Name)

When the browser removes the attribute (see [Revealing](#3-revealing-removing-the-attribute)), it queues a task to fire a simple (non-bubbling) **`load`** `Event` at the element. This happens once per `hidden="while-loading"` attribute:

- **Scoped to opted-in elements:** Ordinary containers (`<div>`, `<section>`, `<article>`) without `hidden="while-loading"` **never** fire `load` events on end tags or child resource loads.
- **Reuses `GlobalEventHandlers.onload`:** `<section hidden="while-loading" onload="...">` and `el.addEventListener("load", ...)` work with no new event handler IDL attributes.
- **Subresource errors never wedge visibility:** Just as `window.onload` still fires when an image `404`s or a stylesheet errors, any subresource that fails (or any parser stream that aborts/truncates at EOF) settles its pending count so the element stops loading and `load` fires.
- **Known quirks of reusing `load` (and alternative event name consideration):**
  1. *`<body>` outlier:* In HTML, `<body onload="...">` / `document.body.onload` is a legacy window-reflecting handler for `window.onload` rather than listening on `<body>` itself (though `document.body.addEventListener("load", ...)` receives target `load` events on `<body>`). Having `<body>` remain an outlier for inline `onload` is acceptable in practice since loading boundaries normally wrap sections inside `<body>`, not `<body>` itself.
  2. *Capture-phase listeners:* Existing `document.addEventListener("load", fn, true)` capture listeners (used by some analytics or image-tracking scripts) will also receive container `load` events (filterable by target type, since container events target elements that don't otherwise fire `load`).
  3. *Alternative:* If avoiding `body.onload` and capture-listener overlap is preferred over reusing `onload`, we can fire a dedicated non-bubbling event name such as **`loadingend`** or **`contentload`** instead.

### 7. Script-Driven Updates (`streamHTML()`)

With `streamHTML()`, script already knows when parsing finishes (the `pipeTo()` promise resolves), so a page could toggle its own class around the stream. `hidden="while-loading"` adds what script can't easily do: waiting for the stylesheets, images, iframes, and nested `<template for src>` includes that arrive *inside* the stream (including ones added late in the stream), plus inertness, `aria-busy`, fragment-navigation waiting, and the fallback timeout.

**Open the stream before fetching.** An element only counts as loading once its stream is open, and an element in the While Loading state that isn't loading is revealed at the next rendering update. So create the stream first, then fetch:

```js
const sink = el.streamHTML();            // el is loading from here on (its old children are replaced)
el.hidden = "while-loading";
const response = await fetch(url);
await response.body.pipeThrough(new TextDecoderStream()).pipeTo(sink);
```

Setting the attribute and *then* awaiting `fetch()` before creating the stream would reveal the (empty) element in the frame rendered while waiting for the response.

**Non-goal: keeping the old content visible.** `streamHTML()` replaces the element's children as soon as the stream opens, so the old content disappears. Keeping it visible until the new content is ready means streaming into a separate element and swapping it in, which is out of scope here.

### 8. Backwards Compatibility & Feature Detection

Browsers that don't support the state treat `hidden="while-loading"` as plain `hidden` (`display: none`), the same as `hidden="until-found"` in browsers without support for it. Unlike `until-found`, which hides content that is collapsed anyway, `while-loading` usually wraps primary content, so pages need a fallback.

**Feature detection** uses the IDL reflection, as for `until-found`:

```js
const el = document.createElement("div");
el.hidden = "while-loading";
const supported = el.hidden === "while-loading"; // legacy browsers return true
```

- **Script-driven updates:** detect before setting the attribute, and fall back to the page's own class (or to no hiding) when unsupported.
- **Server-sent HTML:** a small inline script in `<head>`, before any `hidden="while-loading"` element is parsed, can remove the attribute as the parser inserts it, so legacy browsers render the content progressively instead of never:

  ```html
  <script>
    const probe = document.createElement("div");
    probe.hidden = "while-loading";
    if (probe.hidden !== "while-loading") {
      new MutationObserver(records => {
        for (const r of records)
          for (const n of r.addedNodes)
            if (n.nodeType === 1 && /^while-loading$/i.test(n.getAttribute("hidden") ?? "")) n.removeAttribute("hidden");
      }).observe(document, { childList: true, subtree: true });
    }
  </script>
  ```

  Mutation observer callbacks run at the end of the parser task that inserted the element, before the next rendering update, so the content never paints hidden. A fuller polyfill can instead track parsing and subresource loads and remove the attribute when the element finishes loading, as `hidden="until-found"` polyfills do when they reveal content.

---

## Key Design Questions

### 1. Subresource Gating: `blocking="render"` vs. Existing "Delays the Load Event"

Which descendant subresources keep an element loading?

- **Option A — Reuse HTML's [delays the load event](https://html.spec.whatwg.org/multipage/parsing.html#delay-the-load-event) predicate (scoped to the subtree):** Waits for descendant `<link rel="stylesheet">`, eager `<img>` (and `loading="lazy"` images once started), `<iframe>`, `<script>`, initial `<video>`/`<audio>` poster/metadata, and active `<template for src>` includes. Zero inner-markup boilerplate and 1:1 alignment with `load`, though a single slow eager `<img>` holds back text reveal unless marked `loading="lazy"` (or until the fallback timeout).
- **Option B — Explicit `blocking="render"` on non-stylesheet subresources:** Waits by default only for parser completion, descendant `<link rel="stylesheet">`, and active fragment streams/includes; `<img>`/`<video>`/`<iframe>` only hold back the ancestor when explicitly marked `blocking="render"`. Avoids accidental image stalls, at the cost of inner-markup boilerplate and overloading `<head>`'s `blocking="render"`.

### 2. Lazy Descendants

A `loading="lazy"` image inside a `hidden="while-loading"` element doesn't gate it until its fetch starts. Since a hidden element still has layout boxes, lazy images inside it start fetching as normal once they are near the viewport, and the element is then loading until they settle. Lazy images that start fetching *after* the element has been revealed don't affect it, because the attribute is already gone.

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

`hidden="while-loading"` follows the `hidden="until-found"` precedent instead: a one-shot hidden state that the browser lifts (and removes) under specific conditions, with the same "hidden in legacy browsers, polyfillable" compatibility story.

### 2. Off-Screen `DocumentFragment` Buffering (`<template buffer>`)

Buffering fragments inside an inert `DocumentFragment` ([Fragment Include: Explored Alternatives](./fragment-include-explainer.md#explored-alternatives)) did not load subresources or compute layout geometry without bespoke engine rules, could not expose `aria-busy` in place or animate with `@starting-style`, and only helped `<template>` rather than ordinary shell-to-content elements.

### 3. Relationship to Other Platform Features

| Feature | Scope | How it relates |
|---|---|---|
| **Framework `<Suspense>` boundaries** | JS component trees | Solves shell-to-content coordination in userland JS; `hidden="while-loading"` provides a native HTML/CSS counterpart coordinating HTML parsing, `<link rel="stylesheet">`, and media loads. |
| **`hidden="until-found"`** | Hidden content revealed on demand | Same pattern: a `hidden` state with a UA-defined condition for showing the content, after which the browser removes the attribute. `until-found` reveals on find-in-page / fragment navigation; `while-loading` reveals once the content has loaded. |
| **`<link rel="expect" href="#id" blocking="render">`** | Document first paint (`<head>` only) | Holds initial page render for critical above-the-fold elements; `hidden="while-loading"` handles localized shell-to-content and post-first-paint boundaries without blocking the whole page. |
| **`content-visibility: hidden`** | CSS containment & rendering | Skips layout and painting entirely, whereas `hidden="while-loading"` uses `visibility: hidden` so real layout boxes and subresource loads proceed normally. |
| **`<template for>`, `<template for src>`, `streamHTML()`** | Declarative & streaming updates | Stream HTML into shell outlets after first paint; `hidden="while-loading"` prevents half-streamed flashes and FOUC in the live DOM. |
| **`MutationObserver` parse-end notification** (`delivery: "parse-end"` or `parseEnd: true`) | JS observation | Imperative counterpart ([explainer](./parse-end-mutation-observer-explainer.md)) sharing the exact same "element is parsing" definition. |

</details>

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`hidden="while-loading"` exposes no new cross-origin information: subresource settlement (`<img>`, `<iframe>`, `<link rel="stylesheet">`, `<video>`) already fires observable `load`/`error` events and delays `window.onload`, and removing the attribute and firing `load` on an opted-in ancestor when those same subresources settle (whether on load, error, or timeout) adds no new timing channels or script execution capabilities.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. The attribute removal and the completion event reflect only HTML parser openness of same-document elements and settlement (load or error) of subresources whose `load`/`error` events are already observable by the embedding document.

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
    Disconnecting an opted-in element or its document aborts/settles parser tracking as appropriate without firing spurious completion events on detached documents.

20. **Does your spec define when and how new kinds of errors should be raised?**
    No new exceptions or error types are raised; subresource failures and slow-network timeouts settle the loading state gracefully so content is never permanently hidden.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No. Mapping the While Loading state to implicit `aria-busy="true"` is one-way from the DOM/style engine to platform accessibility APIs.

22. **What should this questionnaire have asked?**
    Whether visually suppressing content via `hidden="while-loading"` can leave regions permanently blank on stalled networks or subresource errors—mitigated by settling the loading state on subresource errors/aborts and enforcing a default UA fallback timeout. In browsers without support, the content stays hidden (`display: none`) unless a fallback is used; see [Backwards Compatibility & Feature Detection](#8-backwards-compatibility--feature-detection).

</details>
