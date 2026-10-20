# Explainer for Progressive Shells and Navigation Upgrades

This proposal is an early design sketch by Chrome Web Platform to describe the problem below and solicit feedback on the proposed solution. It has not been approved to ship in Chrome.

## Proponents

- Noam Rosenthal (Google)

## Participate

- Issue tracker: [WICG/declarative-partial-updates/issues](https://github.com/WICG/declarative-partial-updates/issues)

## Table of Contents

<!-- Update this table of contents by running `npx doctoc progressive-shell-explainer.md` -->
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Introduction](#introduction)
- [Goals](#goals)
- [Non-goals](#non-goals)
- [User research and motivation](#user-research-and-motivation)
- [Use cases](#use-cases)
  - [Use case 1: Instant cold-start shell rendering from the omnibox, bookmarks, or cross-origin links](#use-case-1-instant-cold-start-shell-rendering-from-the-omnibox-bookmarks-or-cross-origin-links)
  - [Use case 2: Zero-JS MPA-to-SPA navigation upgrades with preserved interactive state](#use-case-2-zero-js-mpa-to-spa-navigation-upgrades-with-preserved-interactive-state)
  - [Use case 3: Bandwidth-efficient responses via active-shell negotiation](#use-case-3-bandwidth-efficient-responses-via-active-shell-negotiation)
  - [Use case 4: Lightweight origin-wide shell pre-warming](#use-case-4-lightweight-origin-wide-shell-pre-warming)
- [Proposed Solution](#proposed-solution)
  - [In a nutshell](#in-a-nutshell)
  - [Code samples](#code-samples)
    - [Initial navigation to `/item/foo123` (Cold Start)](#initial-navigation-to-itemfoo123-cold-start)
    - [Subsequent navigation to `/item/bar456` (Upgraded Navigation)](#subsequent-navigation-to-itembar456-upgraded-navigation)
  - [Step-by-step lifecycle](#step-by-step-lifecycle)
    - [1. The `<meta name="shell">` contract](#1-the-meta-nameshell-contract)
    - [2. The parser cut (`<?shellboundary>`)](#2-the-parser-cut-shellboundary)
    - [3. Instant shell paints and stream continuation](#3-instant-shell-paints-and-stream-continuation)
    - [4. Request header negotiation (`Sec-Active-Shell`)](#4-request-header-negotiation-sec-active-shell)
    - [5. The staged commit (MPA-to-SPA upgrade)](#5-the-staged-commit-mpa-to-spa-upgrade)
    - [6. Deferred loading of non-critical shell resources](#6-deferred-loading-of-non-critical-shell-resources)
  - [Options for shell cache discovery](#options-for-shell-cache-discovery)
  - [Value proposition](#value-proposition)
- [Detailed design discussion & open questions](#detailed-design-discussion--open-questions)
  - [Precise syntax and HTML parser processing model](#precise-syntax-and-html-parser-processing-model)
  - [Lifecycle and Navigation API events](#lifecycle-and-navigation-api-events)
  - [Back/forward navigation and history state](#backforward-navigation-and-history-state)
  - [Security and policy contract validation beyond `revision`](#security-and-policy-contract-validation-beyond-revision)
  - [Render-blocking resources and parser-blocking scripts](#render-blocking-resources-and-parser-blocking-scripts)
  - [Exit transitions](#exit-transitions)
- [Considered alternatives](#considered-alternatives)
  - [Two-phase View Transitions (`deferPageSwap`)](#two-phase-view-transitions-deferpageswap)
  - [Full-page Skeletons](#full-page-skeletons)
  - [DOM Preserve / Merge (`preserve` attribute and `<link rel="shell">`)](#dom-preserve--merge-preserve-attribute-and-link-relshell)
- [Security and Privacy Considerations](#security-and-privacy-considerations)
  - [Self-Review Questionnaire: Security and Privacy](#self-review-questionnaire-security-and-privacy)
- [Stakeholder Feedback / Opposition](#stakeholder-feedback--opposition)
- [References & acknowledgements](#references--acknowledgements)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Introduction

Loading a new web document is, more often than not, far from instant. When a user clicks a link to navigate between documents in a Multi-Page Application (MPA), the browser waits for network response bytes and initial rendering before swapping pages. During this gap—often extended by "paint holding" to avoid flashing a blank white screen—the user is stuck in an uncanny valley: looking at a frozen frame of the old page where nothing is interactive, inputs do not respond, and animations stall, followed by a full-document swap that resets scroll positions, focus, live inputs, and persistent UI elements.

To escape this frozen navigation experience, web developers have largely turned to Single-Page Application (SPA) architectures that intercept navigations in JavaScript, keep an application shell alive in the DOM, and fetch only the next view's data. While SPAs avoid full-page reloads after the initial load, they come with steep tradeoffs for both users and developers:
- **JavaScript bloat and hydration cost**: Shipping a client-side router, templating engine, and state manager degrades initial load performance (First Contentful Paint and Interaction to Next Paint) and duplicates server-side rendering logic.
- **No help on cold starts**: An SPA router only runs *after* the page has loaded. It cannot speed up navigations initiated from the browser's address bar (omnibox), bookmarks, external apps, or cross-origin links.
- **Full-document prerendering is heavy**: While [Speculation Rules](https://wicg.github.io/nav-speculation/prerendering.html) prerendering can make anticipated navigations instant, it requires fetching, parsing, and rendering an entire destination document in a hidden renderer. Full documents often cannot share HTTP cache entries across parameterized URLs (even with `No-Vary-Search`), and pre-rendering many full documents is too memory- and bandwidth-intensive to apply broadly.

This proposal introduces **Progressive Shells and Navigation Upgrades**: a declarative HTML mechanism that splits a document into a reusable **structural shell** and a **page-specific content payload**, separated by a `<?shellboundary>` processing instruction and governed by a `<meta name="shell">` contract in `<head>`.

With this contract, the browser can:
1. **Paint cached shells instantly on matching navigations (including cold starts)**: When a document declares a shell for a same-origin URL pattern (such as `/item/:id`), the browser caches the structural shell up to `<?shellboundary>`. On any subsequent navigation matching that URL pattern—including omnibox or cross-origin navigations—the browser displays the cached shell immediately and streams the network response's payload (after `<?shellboundary>`) into placeholders in the live shell using [declarative out-of-order streaming (`<template for>`)](./patching-explainer.md).
2. **Dynamically upgrade cross-document (MPA) navigations into same-document (SPA) navigations**: When navigating between two pages that share a compatible shell contract (`upgrade=always`), the browser keeps the current document interactive during the network fetch, speculatively parses the incoming `<head>`, verifies the shell contract, skips the redundant bytes up to `<?shellboundary>`, updates the URL and history entry in place, and pipes the remaining `<template for>` patches straight into the existing active document—achieving zero-JavaScript SPA transitions with native state preservation.

## Goals

- **Instant visual feedback on navigation (including cold starts)**: Allow browsers to immediately paint a cached, interactive application shell when navigating to any URL matching a previously learned (or pre-warmed) same-origin route pattern, while the page-specific content streams in.
- **Zero-JS MPA-to-SPA navigation upgrades**: Enable navigations between pages that share a shell contract (`upgrade=always`) to keep the active document alive and interactive during the fetch, updating only the declared dynamic regions (`<template for>`) without tearing down persistent UI state (inputs, focus, scroll containers, media, or subframes).
- **Graceful progressive enhancement and fallback**: Ensure that every document remains a valid, self-contained HTML response. If a client does not support progressive shells, has no cached shell, encounters a `revision` mismatch, or receives a `4xx`/`5xx` error response, the navigation seamlessly behaves as a standard cross-document MPA navigation.
- **Reduced memory and bandwidth overhead compared to full-page prerendering**: Cache a single lightweight structural shell per route pattern rather than rendering and holding entire destination documents in memory, and allow servers to omit redundant shell bytes when the client advertises an active shell via `Sec-Active-Shell`.

## Non-goals

- **Cross-origin shell sharing**: A shell contract is strictly scoped to same-origin URL patterns. One origin cannot register or inject a shell for another origin.
- **General-purpose client-side virtual DOM diffing**: While we discuss element-level DOM preservation (`preserve`) as an alternative/complementary mechanism, the primary progressive shell model relies on explicit boundaries (`<?shellboundary>`) and declarative out-of-order streaming patches (`<template for>`).
- **Solving arbitrary uninterruptible exit animations**: General-purpose exit transitions that delay navigation while the old page runs custom exit animations remain orthogonal to shell continuation and upgrades.

## User research and motivation

Today, authors building multi-view websites face a fragmented set of primitives when trying to eliminate navigation freezes:

1. **Standard MPA navigations with Paint Holding and View Transitions**:
   - Browsers briefly hold the last painted frame of the old document while waiting for the new document to commit and render. If the network or server takes hundreds of milliseconds, the page feels frozen: clicking a search bar, typing into an input, or scrolling does nothing until the new document replaces the old one—at which point any in-progress user input or scroll state in persistent chrome (like a header search box or sidebar) is wiped out.
2. **Client-side SPA routers (Next.js, Remix, React Router, Vue Router, etc.) and HTML-over-the-wire libraries (Hotwire/Turbo, htmx)**:
   - Frameworks maintain a persistent root layout in JavaScript and swap child outlets on navigation. However, achieving this requires loading and executing framework JavaScript before navigation interception can work, and requires maintaining parallel server/client rendering pipelines or custom partial-response endpoints.
3. **Service Worker App Shells**:
   - Service Workers can respond to navigations with a cached HTML shell that then fetches page content via client-side JavaScript (`fetch()`), or can manually stitch `ReadableStream` responses together. In practice, Service Worker boot latency, complex cache invalidation when layouts change, and the difficulty of coordinating history updates and head metadata without a client-side router make handwritten Service Worker shells brittle and rare.

Progressive Shells bring the "App Shell + streaming continuation" architecture directly into the HTML parser and browser navigation pipeline—requiring only declarative HTML markup (`<meta name="shell">`, `<?shellboundary>`, and `<template for>`).

## Use cases

### Use case 1: Instant cold-start shell rendering from the omnibox, bookmarks, or cross-origin links

A user visits an e-commerce site, documentation portal, or issue tracker (`/item/foo123`) once. Later, they click a link to `/item/bar456` from an external search engine, chat app, or bookmark. Because `/item/bar456` matches the cached shell pattern `/item/:id`, the browser paints the site's header, navigation bar, search box, and page skeleton on the very first frame—before the network request to `/item/bar456` even returns—and then streams the item title and details into the `<main>` placeholder as bytes arrive.

### Use case 2: Zero-JS MPA-to-SPA navigation upgrades with preserved interactive state

A user is browsing a catalog or media site with a persistent header (containing a live search input, audio player, or navigation drawer) and clicks links between `/item/foo123` and `/item/bar456`. Instead of freezing the page during the network round-trip and resetting the header DOM on commit, the browser keeps the existing document interactive while fetching `/item/bar456`, verifies that `/item/bar456` uses the same `app-shell` and `revision`, updates the URL in place, and applies the `<template for>` patches after `<?shellboundary>` into the live document.

### Use case 3: Bandwidth-efficient responses via active-shell negotiation

When a user already has `app-shell` (`revision=my-shell-v1`) on screen (either from a cached cold-start shell or an in-page navigation), the browser sends `Sec-Active-Shell: name="app-shell"; rev="my-shell-v1"` on the navigation request. A server or CDN edge worker that understands this header can omit the costly HTML markup above `<?shellboundary>` (or serve a minimal `<head>` contract followed immediately by `<?shellboundary>` and the `<template for>` payload), saving bandwidth and server rendering time while still allowing unmodified static servers to return the full document.

### Use case 4: Lightweight origin-wide shell pre-warming

An origin can advertise its route-to-shell mapping via `.well-known/shells.json`, an HTTP response header, or Speculation Rules. The browser can pre-populate its shell cache for high-probability routes at a fraction of the memory and network cost of prerendering dozens of full HTML documents.

## Proposed Solution

### In a nutshell

By placing a `<meta name="shell">` tag in the document `<head>`, a website establishes an instant-paint shell contract for matching same-origin URL patterns. Documents are divided into two parts separated by a processing instruction (`<?shellboundary>`):
1. **The structural shell** (everything before `<?shellboundary>`), which contains the shared page layout and named placeholders (`<?start>`, `<?marker>`).
2. **The content payload** (everything after `<?shellboundary>`), which uses out-of-order streaming patches (`<template for="...">`) to populate the placeholders inside the shell.

This single document structure unlocks two complementary capabilities:
- **Cached Shell Continuation**: When a document with a shell is loaded, the browser caches the shell markup and maps it to its declared same-origin URL pattern. Navigating to a matching URL (including cold starts) paints the cached shell immediately, then streams the incoming response's post-`<?shellboundary>` content into the live shell.
- **Same-Document Navigation Upgrades**: When navigating from an active document to another URL that shares a compatible shell contract with `upgrade=always`, the browser pauses the page unload (keeping the current document interactive during the network fetch), speculatively parses the incoming `<head>`, discards the incoming bytes up to `<?shellboundary>`, updates the address bar URL and history entry in place, and pipes the remaining `<template for>` stream directly into the existing active document.

### Code samples

#### Initial navigation to `/item/foo123` (Cold Start)

```html
<html>
<head>
  <!-- Cache contract:
       maps to common routes. upgrade=always enables MPA->SPA transitions -->
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

#### Subsequent navigation to `/item/bar456` (Upgraded Navigation)

```html
<!-- Request header includes: Sec-Active-Shell: name="app-shell"; rev="my-shell-v1" -->
<html>
<head>
  <!-- The server repeats the meta contract. If there's a revision mismatch,
       or a non-OK status, the browser aborts the upgrade and triggers a clean MPA reload -->
  <meta name="shell" content="
    name=app-shell,
    revision=my-shell-v1,
    pattern=/item/:id,
    upgrade=always">
</head>
<body>
  <!-- The browser pauses the page unload, skips the bytes up to the matching boundary,
       updates the URL/History Entry in place, and splices the remaining stream into the live page -->
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

### Step-by-step lifecycle

#### 1. The `<meta name="shell">` contract

The `<meta name="shell">` element in `<head>` establishes the shell's identity, route matching rules, and upgrade behavior through four parameters:
- **`name`**: The unique identifier of the structural shell (e.g., `name=app-shell`), used to match the `<meta name="shell">` contract with the `<?shellboundary name="app-shell">` processing instruction and the `Sec-Active-Shell` request header.
- **`pattern`**: A same-origin [URL Pattern](https://urlpattern.spec.whatwg.org/) (e.g., `pattern=/item/:id`) specifying which URLs share this shell.
- **`revision`**: An opaque version token (e.g., `revision=my-shell-v1`). Whenever a deployment changes the structural shell, updating `revision` ensures that any stale cached shell or incompatible active shell triggers a clean cross-document reload.
- **`upgrade`** (`once` | `always`): Controls whether the shell contract is used only for one-shot cached-shell-to-content continuation on initial navigation (`once`), or also upgrades subsequent navigations between matching pages into same-document updates (`always`).

#### 2. The parser cut (`<?shellboundary>`)

The common structural shell begins at the start of the HTML document and ends at the `<?shellboundary name="...">` processing instruction. Everything prior to `<?shellboundary>` defines the reusable shell DOM (including `<?start>` / `<?end>` ranges and `<?marker>` insertion points), while everything after `<?shellboundary>` consists of `<template for="...">` patches that populate those placeholders.

#### 3. Instant shell paints and stream continuation

The User Agent maintains a local shell cache (partitioned by network/storage key) keyed by the same-origin URL `pattern`. When a navigation to a URL matching a cached shell pattern begins (including cold starts from the omnibox or cross-origin links):
1. The cached shell markup (up to `<?shellboundary>`) is parsed and displayed on screen immediately.
2. In parallel, the destination URL is fetched from the network.
3. The incoming document response is speculatively parsed up to `<head>` and `<?shellboundary>`. If the `<meta name="shell">` contract (`name` and `revision`) matches the painted shell, the bytes before `<?shellboundary>` are discarded and the bytes after `<?shellboundary>` are appended/streamed into the live document parser as a continuation.

#### 4. Request header negotiation (`Sec-Active-Shell`)

Whenever the browser fetches a destination document while a shell is active (either because it just painted a cached shell for a cold start, or because it is performing an upgraded navigation from an already-loaded document), the navigation request includes the `Sec-Active-Shell` header:

```http
Sec-Active-Shell: name="app-shell"; rev="my-shell-v1"
```

This header is a progressive optimization:
- **Static servers / CDNs** can ignore the header and return the complete HTML document (containing both the shell and the post-`<?shellboundary>` payload); the browser will simply skip the bytes before `<?shellboundary>`.
- **Dynamic servers / edge workers** can inspect `Sec-Active-Shell` and, when `name` and `rev` match the current deployment, omit the redundant shell markup between `<head>` and `<?shellboundary>` to save bandwidth and server CPU.

#### 5. The staged commit (MPA-to-SPA upgrade)

When navigating from an active document that has an active shell contract with `upgrade=always` to another URL:
1. The browser **holds the navigation commit**, leaving the existing page fully interactive while the network request is in flight.
2. As response bytes arrive, the browser speculatively tokenizes the incoming `<head>`.
3. **Contract match**: If the HTTP status is `200 OK` and the incoming `<meta name="shell">` matches the active shell's `name` and `revision` (with `upgrade=always`), the browser discards the incoming bytes up to `<?shellboundary>`, updates the address bar URL and session history entry in place, and pipes the remaining `<template for>` blocks directly into the live document context.
4. **Contract mismatch or error fallback**: If the `revision` or `name` mismatches, the HTTP status is `4xx`/`5xx`, or no matching `<?shellboundary>` is encountered, the browser immediately aborts the upgrade and falls back to a standard cross-document MPA navigation using the already-received response bytes (preserving form state where possible).

#### 6. Deferred loading of non-critical shell resources

To maximize First Contentful Paint (FCP) of the shell, `async` scripts (`<script async>`) and lower-priority resource preloads (`fetchpriority` lower than `high`) declared inside the shell are deferred during shell loading and only begin fetching after the initial shell frame has been painted on screen.

### Options for shell cache discovery

While declaring `<meta name="shell">` inside the document `<head>` is the most ergonomic option for authors who do not control HTTP headers or origin-wide configuration files, the pattern-to-shell cache can be populated through four complementary discovery mechanisms:

1. **In-document `<meta name="shell">`**: Discovered naturally whenever a user visits any page that includes the `<meta name="shell">` tag and `<?shellboundary>`. Scope is restricted to paths under or matching the document's route constraints.
2. **Origin-wide `.well-known/shells.json` manifest**: Allows an origin to advertise its shells and route patterns up front so the User Agent (or a speculation trigger) can pre-warm shells across the entire domain before the user visits a specific sub-route.
3. **HTTP Response Header (`Shell` / `Link` or `103 Early Hints`)**: A response header can advertise a shell pattern and revision with more relaxed path scoping than an in-document `<meta>` tag (for example, `/items/foo123` can advertise a shell for `/` in a response header).
4. **Programmatic / Initiator-driven discovery**: Declared in the initiating document via [Speculation Rules](https://wicg.github.io/nav-speculation/speculation-rules.html) or Service Worker static routing APIs.

### Value proposition

- **Learn once, instant everywhere**: Once a user loads a single matching document (or the origin pre-warms its shell cache), all similar documents matching the URL pattern render their shell instantly.
- **Faster single-document FCP**: Even on the very first visit to a page when the shell is not yet cached, the explicit `<?shellboundary>` marker lets the browser prioritize painting the initial frame at the boundary and defer lower-priority fetches and `async` scripts until after the shell is presented.
- **Lightweight predictive preloading**: Additional cache discovery mechanisms (`.well-known/shells.json`, HTTP headers, Speculation Rules) allow the browser to pre-fetch and cache shells at a fraction of the memory and network footprint of full-document prerendering.

## Detailed design discussion & open questions

### Precise syntax and HTML parser processing model

- What is the exact grammar for `<meta name="shell" content="...">` parameters (`name`, `revision`, `pattern`, `upgrade`), and how should relative `pattern` values be resolved against the document's base URL?
- In the HTML parser, how should unclosed elements before `<?shellboundary>` (such as `<html>`, `<body>`, or wrapper containers) interact with the parser state when splicing the post-boundary stream into an already-active document? Restricting post-boundary content to top-level `<template for="...">` patches avoids ambiguous tree-construction states.

### Lifecycle and Navigation API events

- How should upgraded navigations integrate with the [Navigation API](https://html.spec.whatwg.org/multipage/nav-history-apis.html#navigation-api) (`navigate`, `navigatesuccess`, `navigateerror` events, and `NavigationTransition`) and Page Visibility / lifecycle events?
- When a cached shell is painted on a cold start before the network response commits, what is `document.readyState`, and when do `DOMContentLoaded` and `load` fire?

### Back/forward navigation and history state

- How should back/forward navigations (`traverse`) work when moving between entries that were created via shell upgrades?
- Can the browser cache the post-boundary `<template for>` patches per session history entry (or use BFCache snapshots) to restore or merge joint history states seamlessly on back/forward traversal?

### Security and policy contract validation beyond `revision`

- An upgraded navigation keeps the existing `Document` and its security context alive while splicing content from a new network response. Beyond matching the shell `name` and `revision`, what response headers must be compatible for an upgrade to proceed?
- Any change in security-critical headers—such as `Content-Security-Policy` (CSP), `Cross-Origin-Opener-Policy` (COOP), `Cross-Origin-Embedder-Policy` (COEP), `Origin-Agent-Cluster`, or `Permissions-Policy`—should abort the same-document upgrade and fall back to a clean cross-document navigation so that the new document's security policy is strictly enforced from a fresh environment.

### Render-blocking resources and parser-blocking scripts

- How should render-blocking resources (`blocking="render"`) or new stylesheets injected via `<template for="...">` behave during an upgraded navigation? For example, should the browser batch visual updates of a patch until its stylesheets load (or integrate with View Transitions)?
- Should parser-blocking classic `<script>` elements be disallowed or ignored after `<?shellboundary>` (or inside shells) to ensure deterministic speculative parsing and streaming continuation?

### Exit transitions

- While Progressive Shells eliminate the navigation freeze and preserve shell state, they do not by themselves provide general-purpose, uninterruptible exit animations for outgoing content before it is replaced. Coordinating `<template for>` replacements with CSS View Transitions is an area for further exploration.

## Considered alternatives

### Two-phase View Transitions (`deferPageSwap`)

The [Two-Phase View Transition (`deferPageSwap`)](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md) proposal allows the outgoing document to intercept an outgoing cross-document navigation and display an intermediate loading state or animation before the new page swaps in.

**Why not rely on `deferPageSwap` alone?**
- **Responsibility is inverted**: It places the burden of rendering the destination's loading UI on the *old* document, which often does not know enough about the destination route's layout, leading to staleness and duplicated layout logic across pages.
- **Does not help with cold starts or cross-origin navigations**: When navigating from the omnibox, bookmarks, or a cross-origin link, there is no same-origin outgoing document to run a first-phase transition, and browsers cannot defer a cross-origin navigation on behalf of the untrusted initiator for security reasons.
- **Loses DOM state on swap**: When the new document finally commits, a full cross-document swap still occurs, resetting scroll state, focus, and live inputs in the page chrome.

### Full-page Skeletons

Another approach explored in earlier designs ([Skeletons, Preloading, and Transitions](https://docs.google.com/document/d/1D55tdosrOS4qaw3ApRwN6lP-r17TG5GKk1Mfl5xAjo8/edit), [Skeleton Prototype](https://docs.google.com/document/d/1hov28dKBKDKtvC33B6WjZnQSlr1BPMiOkHQzNq14ZrY/edit), [Skeleton Screens Syntax Brainstorming](https://docs.google.com/document/u/0/d/1Ml8B-3eOmx37R9UMy6F5epi1ZgE9fPZ_Jnjdj6UyUDE/edit)) is having the destination route declare a separate "skeleton" document that the browser displays temporarily and then replaces wholesale when the real document arrives.

**Why not a temporary skeleton document?**
- **State is wiped when swapping from the skeleton to the real document**: Any user interaction with the skeleton while the main response is loading—such as scrolling, focusing a control, or typing into a search input—is lost when the real document replaces the skeleton document. Making skeleton inputs inert until the full page loads turns the skeleton into a non-interactive screenshot ("half measure") whose UX quickly feels broken on slower networks.

### DOM Preserve / Merge (`preserve` attribute and `<link rel="shell">`)

Instead of cutting the document stream at a single `<?shellboundary>` processing instruction, we also considered (and may still evaluate as a complementary primitive; see [DOM preservation](./preserve-explainer.md)) allowing the browser to **stream and merge** a new document on top of an existing document (or shell) while preserving marked elements in place:
- Elements can declare a `preserve` attribute (either boolean, or specifying whether attributes and/or children are preserved) alongside a matching `id`.
- When streaming a new document over a shell or previous document, elements with `preserve` and a matching `id` stay in place in the DOM (preserving input values, focus, scroll position, `<iframe>`s, `<video>` playback, and animations) and only have their attributes updated.
- Authors can wrap preserved elements in `<?start>` / `<?end>` markers if they occasionally want to remove or replace them via `<template for="...">`.
- Merging could be performed automatically for `<link rel="shell" href="shell.html">` navigations, or imperatively via `{stream}MergeHTML{Unsafe}` DOM methods.

Example of the `preserve` / `<link rel="shell">` model:

`shell.html`:
```html
<!-- HTTP response header:
     Shell-Match-Pattern: /content/:id?* -->
<head>
  <title>Put title here</title>
</head>
<body>
  <header preserve id="header">
    <nav>...</nav>
    <input type="search">
  </header>
  <main preserve id="main">
    <?start name="main-content">
    Loading...
    <?end>
  </main>
  <?start name="maybe-footer">
  <footer preserve id="footer">
    ...
  </footer>
  <?end>
</body>
```

`content.html`:
```html
<!-- head is replaced -->
<head>
  <link rel="shell" href="shell.html">
  <title>Content</title>
</head>
<body>
  <!-- Shell is repeated; preserved elements only update their attributes -->
  <header preserve id="header">
    <nav>...</nav>
    <input type="search">
  </header>
  <main preserve id="main">
    <?start name="main-content">
    Loading...
    <?end>
  </main>
  <?start name="maybe-footer">
  <footer preserve id="footer">
    ...
  </footer>
  <?end>

  <!-- Removes the sometimes-preserved footer -->
  <template for="maybe-footer"></template>
  <template for="main-content">
    Main content goes here
  </template>
</body>
```

**Why prefer `<?shellboundary>` as the primary model?**
While `preserve` is useful for keeping "islands" (like an embedded video or chat widget) alive inside a patched region, using `<?shellboundary>` for the document shell itself is simpler and more direct: the browser does not have to diff or merge the shell tree at all on navigation—it simply skips everything before `<?shellboundary>` and applies the explicit `<template for>` patches that follow.

## Security and Privacy Considerations

1. **Strict Same-Origin Policy for shells and URL patterns**:
   A shell declared by an origin can only match URL patterns on that **same origin**. Furthermore, in-document `<meta name="shell">` declarations should follow path-scoping rules (similar to Service Worker `scope` or `No-Vary-Search` constraints) unless relaxed by an explicit HTTP response header or `.well-known/shells.json` at the origin root, preventing a user-controlled sub-path from registering a shell for unrelated paths on the same origin.
2. **Cache partitioning**:
   The pattern-to-shell cache must be partitioned by the browser's network/storage key (top-level site / frame origin) just like the HTTP cache, ensuring that cross-site trackers cannot probe whether a user has cached a shell for a given origin.
3. **Request header privacy (`Sec-Active-Shell`)**:
   `Sec-Active-Shell` is a `Sec-`-prefixed forbidden request header sent only to the destination origin for which the shell is active. It reveals only the `name` and `revision` string that the same origin previously served to the client, carrying no more state than a standard HTTP cache validator (`If-None-Match` / `ETag`), and must be cleared whenever the user clears browsing data or cookies/cache for that origin.
4. **Security header consistency on upgraded navigations**:
   When upgrading a cross-document navigation into a same-document update (`upgrade=always`), the browser must verify that security-critical HTTP response headers (`Content-Security-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Permissions-Policy`, etc.) on the incoming response are compatible with the active document's environment. If policies differ, the browser must abort the upgrade and perform a full cross-document navigation.

### [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

1. **What information does this feature expose, and for what purposes?**
   When navigating to a URL matching an active or cached shell on the same origin, the browser sends the `Sec-Active-Shell: name="..."; rev="..."` request header to that origin so the server can optionally omit redundant shell markup before `<?shellboundary>`.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. Only the origin-defined shell `name` and `revision` for the matched route are sent to the same origin.

3. **Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?**
   No.

4. **How do the features in your specification deal with sensitive information?**
   Cached shells must obey standard HTTP caching directives (such as `Cache-Control: no-store` or `private`). A response with `Cache-Control: no-store` must not persist its shell to disk or reuse it across sessions.

5. **Does data exposed by your specification carry related but distinct information that may not be obvious to users?**
   No.

6. **Do the features in your specification introduce state that persists across browsing sessions?**
   Yes, the pattern-to-shell cache can persist across browsing sessions alongside the standard HTTP cache. To prevent supercookie or cross-site tracking vectors, the shell cache must be partitioned by network isolation key, respect `Cache-Control: no-store`, and be cleared whenever the user clears site data or cache. Furthermore, `revision` values should be bounded in length and scoped per URL pattern.

7. **Do the features in your specification expose information about the underlying platform to origins?**
   No.

8. **Does this specification allow an origin to send data to the underlying platform?**
   No.

9. **Do features in this specification enable access to device sensors?**
   No.

10. **Do features in this specification enable new script execution/loading mechanisms?**
    In a cold-start shell continuation or an upgraded navigation, post-`<?shellboundary>` `<template for>` blocks are parsed and applied into the active document. Any scripts inside those patches execute within the document's existing realm and must strictly adhere to the active document's `Content-Security-Policy` (including nonces/hashes). If the incoming response specifies a different CSP, the upgrade is aborted in favor of a full cross-document navigation.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No more than existing Same-Document Navigations (`history.pushState` / Navigation API `intercept()`). In an upgraded navigation, the address bar URL updates to the destination URL only after the destination response headers and `<head>` have been received from that same-origin URL and verified against the shell contract.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    None beyond the origin-provided shell `name` and `revision` echoed in `Sec-Active-Shell` (analogous to `ETag` / `If-None-Match`).

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    Shell caches are partitioned by top-level site. Top-level navigation upgrades apply to top-level traversables navigating within the same origin.

15. **How do the features in this specification work in the context of a browser's Private Browsing or Incognito mode?**
    In Private Browsing / Incognito mode, the shell cache must be isolated in memory to the incognito profile—never reading from the regular profile's shell cache and never writing to disk—and must be destroyed when the incognito session ends.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes, included above in this explainer and to be included in the normative specification.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No. If an incoming response during an upgraded navigation changes security policies (such as CSP, COOP, or COEP), the browser aborts the in-place upgrade and performs a full cross-document navigation.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Documents using shells remain compatible with BFCache on cross-origin or non-upgraded navigations. For same-document upgraded navigations, session history entries are updated in-document; defining how back/forward traversal restores previous `<template for>` state is tracked in [Back/forward navigation and history state](#backforward-navigation-and-history-state).

19. **What happens when a document that uses your feature gets disconnected?**
    If a navigable container is disconnected during an in-flight shell continuation or upgrade, the fetch and stream continuation are aborted.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Mismatched shell contracts, missing `<?shellboundary>` markers, or HTTP error statuses (`4xx`/`5xx`) do not throw uncaught script errors; instead, they gracefully fall back to a standard cross-document MPA navigation.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Whether an attacker with HTML injection on one page could poison the shell cache for other routes on the same origin. This is mitigated by path-scoping `<meta name="shell">` patterns (similar to Service Worker script scope) so a sub-path cannot register a shell for higher-level paths unless authorized by an HTTP response header or `.well-known/shells.json`, and by only caching shells from bytes preceding `<?shellboundary>`.

## Stakeholder Feedback / Opposition

- **Chromium**: Early exploration / design sketch
- **Gecko**: No signals yet
- **WebKit**: No signals yet
- **Web developers / framework authors**: Initial discussions around Declarative Partial Updates and app-shell continuations

## References & acknowledgements

- [Declarative Partial Updates (`WICG/declarative-partial-updates`)](./README.md)
- [Interleaved HTML Streaming / Patching Explainer (`<template for>`, `<?start>`, `<?end>`, `<?marker>`)](./patching-explainer.md)
- [DOM Preservation Explainer (`preserve`)](./preserve-explainer.md)
- [Two-Phase View Transition Explainer (`deferPageSwap`)](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md)
- [URL Pattern Standard](https://urlpattern.spec.whatwg.org/)
- Early design notes:
  - [Progressive Shell & navigation upgrades](https://docs.google.com/document/d/11lGJpl3z5Ow9pHWNhwFfnzYlCNDD8933UL0MunZYdBo/edit?tab=t.0)
  - [Skeletons, Preloading, and Transitions](https://docs.google.com/document/d/1D55tdosrOS4qaw3ApRwN6lP-r17TG5GKk1Mfl5xAjo8/edit?resourcekey=0-qWhua8ULQKe9JVE_gb_mHw&tab=t.0#heading=h.lmrt71rc091)
  - [Skeleton Prototype](https://docs.google.com/document/d/1hov28dKBKDKtvC33B6WjZnQSlr1BPMiOkHQzNq14ZrY/edit?tab=t.0#heading=h.6kknmf22ixwc)
  - [Browser Skeleton Search Use Cases](https://docs.google.com/document/d/1jNDWcAlpWFeFgD2W9qoCACLbctUHyzPZbPaYmkuL2uo/edit?resourcekey=0-W4voziHiRcwXt7sh6bFIhQ&tab=t.0#heading=h.cc82slqzl4q0)
  - [Skeleton Screens Syntax Brainstorming](https://docs.google.com/document/u/0/d/1Ml8B-3eOmx37R9UMy6F5epi1ZgE9fPZ_Jnjdj6UyUDE/edit)
