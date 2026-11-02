# Styling based on navigation state

## Authors

- Noam Rosenthal ([@noamr](https://github.com/noamr))
- David Baron ([@dbaron](https://github.com/dbaron))

## Participate
- **Issue tracker:** [GitHub Issues for css-navigation-1](https://github.com/w3c/csswg-drafts/issues?q=label%3Acss-navigation-1+is%3Aissue)
- **Discussion forum:** [Initial syntax discussion for HTML route matching](https://github.com/WICG/declarative-partial-updates/issues/46), [CSS route matching discussion](https://github.com/w3c/csswg-drafts/issues/12594), and [URL-matching security model](https://github.com/w3c/csswg-drafts/issues/14266)
- **Specification Draft:** [CSS Navigation Level 1](https://drafts.csswg.org/css-navigation-1/)

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
- [Authors](#authors)
- [Participate](#participate)
- [User-Facing Problem](#user-facing-problem)
- [Proposed Solution at a Glance](#proposed-solution-at-a-glance)
  - [Goals & Non-Goals](#goals--non-goals)
- [Detailed Design](#detailed-design)
  - [Declaring locations (`<script type="locationmap">`)](#declaring-locations-script-typelocationmap)
  - [Built-in location keywords (`same-origin`, `same-pathname`, `same-url`)](#built-in-location-keywords-same-origin-same-pathname-same-url)
  - [Active navigation state](#active-navigation-state)
  - [Conditional navigation styling (`@navigation`)](#conditional-navigation-styling-navigation)
  - [Link & trigger pseudo-classes (`:link-to()` and `:nav-source`)](#link--trigger-pseudo-classes-link-to-and-nav-source)
- [Potential Future Enhancements](#potential-future-enhancements)
- [Alternatives Considered](#alternatives-considered)
- [Accessibility Considerations](#accessibility-considerations)
- [Privacy and Security Considerations](#privacy-and-security-considerations)
- [Stakeholder Feedback / Opposition](#stakeholder-feedback--opposition)
- [References & Acknowledgements](#references--acknowledgements)
<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## User-Facing Problem

Users expect immediate, spatially coherent visual feedback when navigating a site or app:
- **Pending feedback:** Highlighting or showing a spinner on the clicked link while the destination loads.
- **Directional continuity:** Sliding forward on normal navigation and reversing direction on Back traversal.
- **List-to-details morphing ([w3c/csswg-drafts#8209](https://github.com/w3c/csswg-drafts/issues/8209)):** Expanding the specific card or thumbnail a user clicked into the detail view—and collapsing back into that exact list item when returning—across both multi-page (MPA) and same-document (SPA) navigations.

Today, CSS has no visibility into active navigations or route structure. Delivering these experiences requires either wrapping every link in a JavaScript router component (e.g., `<NavLink>` `isPending` callbacks) or writing fragile `navigate` event interceptors that manually toggle DOM attributes (`data-state="pending"`, dynamic `view-transition-name`s). That imperative plumbing adds script overhead to the critical navigation path, does not work declaratively for cross-document navigations, and frequently leaves stale UI behind after Back/Forward traversal or BFCache restores.

<details>
<summary>Examples of today's framework and vanilla JS workarounds</summary>

In a client-side framework such as [React Router](https://reactrouter.com/start/framework/pending-ui), links must be wrapped in JS components just to style pending navigation states:

```tsx
import { NavLink } from "react-router";

function Navbar() {
  return (
    <nav>
      <NavLink to="/home">
        {({ isPending }) => <span>Home {isPending && <Spinner />}</span>}
      </NavLink>
      <NavLink
        to="/about"
        style={({ isPending }) => ({ color: isPending ? "gray" : "black" })}
      >
        About
      </NavLink>
    </nav>
  );
}
```

Without a framework, coordinating pending UI, route matching, and [View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) requires non-trivial event interception just to curate style:

```js
navigation.addEventListener("navigate", e => {
  e.intercept({
    async handler() {
      const contentPromise = loadActualContent();
      await document.startViewTransition(() => {
        document.body.dataset.state = "pending";
      }).updateCallbackDone;
      await contentPromise;
      document.body.dataset.state = "loaded";
      document.body.dataset.route = routeFrom(e.destination.url);
    }
  });
});
```

</details>

## Proposed Solution at a Glance

Declarative Route Matching separates **location declaration** (in HTML) from **navigation-state styling** (in CSS):

1. **`<script type="locationmap">` in HTML:** Maps plain identifier names (such as `home`, `list`, `item`) to [URL Patterns](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) via an external JSON file or inline JSON block.
2. **`@navigation`, `:link-to()`, and `:nav-source` in CSS:** Apply styles and View Transitions conditionally based on the active navigation's origin/destination locations, loading phase, history direction, and participating links.

**Pending link UI without JavaScript:**

```html
<script type="locationmap">
  {
    "home": "/",
    "about": "/about"
  }
</script>
<style>
  @navigation (to: home) and (phase: loading) {
    a:link-to(home) + .spinner { opacity: 1; }
  }
  @navigation (to: about) and (phase: loading) {
    a:link-to(about) { color: gray; }
  }
</style>
<nav>
  <a href="/">Home</a><span class="spinner"></span>
  <a href="/about">About</a>
</nav>
```

**List-to-details & directional View Transitions:**

```html
<script type="locationmap" src="/locations.json"></script>
<!-- locations.json: { "list": "/movies", "detail": "/movies/:id" } -->

<style>
  @view-transition {
    navigation: auto;
    types: slide-forward;
  }

  @navigation (history: back) {
    @view-transition {
      navigation: auto;
      types: slide-back;
    }
  }

  /* Pair the clicked/matching movie card thumbnail with the detail hero image */
  @navigation (between: list and detail) {
    .movie-card:has(a:nav-source, a:link-to(detail)) img,
    .movie-hero img {
      view-transition-name: active-poster;
    }
  }
</style>
```

### Goals & Non-Goals

- **Goals:**
  - Style transitions and UI conditionally based on navigation origin, destination, phase (`loading`, `ready`, `committed`), and history type (`back`, `forward`, `traverse`, `reload`).
  - Declare named `URLPattern` locations declaratively and securely in HTML (`<script type="locationmap">`) and reference them in CSS.
  - Style links that match a named location (`:link-to()`) or triggered the active navigation (`:nav-source`).
- **Non-Goals:**
  - Replacing client-side routers for data fetching, component instantiation, or DOM updates (though this pairs naturally with framework routers and future declarative patching).
  - Exposing raw URL strings or arbitrary regex/wildcard URL probing inside untrusted stylesheets.

---

## Detailed Design

### Declaring locations (`<script type="locationmap">`)

URL comparison is notoriously finicky (`/about` vs. `/about/` vs. `/about?utm_source=x`). [URL Pattern](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API) solves URL matching, while [w3c/csswg-drafts#14266](https://github.com/w3c/csswg-drafts/issues/14266) established that raw `URLPattern` wildcards and regular expressions should not be defined inside CSS (where cross-origin CDN or injected stylesheets could probe sensitive path/query tokens via conditional resource loads).

Instead, documents declare named locations in HTML using `<script type="locationmap">`, either shared across pages via an external file:

```html
<script type="locationmap" src="/locations.json"></script>
```

`locations.json`:
```json
{
  "home": "/",
  "about": "/about",
  "item": { "pathname": "/item/:id" }
}
```

Or inline:

```html
<script type="locationmap">
{
  "home": "/",
  "about": "/about",
  "item": { "pathname": "/item/:id" }
}
</script>
```

- **Location names & values:** Each key is an ident-like string (`home`, `about`, `item`—plain `<custom-ident>` names, not `--` dashed idents; CSS-wide keywords and the `same-*` prefix are reserved for built-in location keywords below) referenced in CSS. Each value is any valid `URLPattern` constructor input: either a pattern string (resolved relative to the document base URL) or a `URLPatternInit` dictionary (e.g., `{ "pathname": "/item/:id" }`).
- **Why `<script>` rather than `<link>`:** Supports both external `src` files (avoiding copy-pasting across MPA pages) and inline declarations, governed by HTML's CSP `script-src` policy just like `<script type="importmap">` and `<script type="speculationrules">`.
- **Why JSON rather than a CSS or custom dialect:** Familiar, supported by existing tooling, maps 1:1 to `URLPatternInit` without duplicating `URLPattern` grammar in CSS, and can be reused by non-style HTML routing features.
- **Mutation timing:** Adding or removing `<script type="locationmap">` elements only affects subsequent navigations—the active location map is snapshotted (copied) when a navigation starts.

### Built-in location keywords (`same-origin`, `same-pathname`, `same-url`)

Common generic styling cases should not require adding a `<script type="locationmap">` to every page. Alongside author-defined `locationmap` names, CSS provides a small set of built-in **relational** location keywords evaluated relative to the document's current URL:

- **`same-origin`** *(same origin as the document; any `pathname`, `search`, or `hash`)* — e.g., show app-shell pending UI only for internal navigations (`@navigation (to: same-origin) and (phase: loading)`), or style external links (`a:not(:link-to(same-origin))`).
- **`same-pathname`** *(same origin and `pathname`; any `search` or `hash`)* — e.g., distinguish in-page query/filter updates (`/items?sort=price`) from full route changes, or highlight "current page" links (`a:link-to(same-pathname)`) even when `?utm_source=...` or `#section` is present.
- **`same-url`** *(same origin, `pathname`, and `search`, ignoring `hash`)* — e.g., exclude `#fragment`-only anchor jumps from pending spinners or full-page view transitions (`@navigation (to: same-origin) and (not (to: same-url))`).

To keep author-defined `<custom-ident>` names forward-compatible with future built-in keywords without requiring `--` dashed idents, CSS-wide keywords and the `same-*` prefix are reserved and invalid as `<script type="locationmap">` keys (alternatively, if CSSWG prefers stricter grammar separation, custom names or keywords could be disambiguated via functional notation).

### Active navigation state

Both `@navigation` and `:nav-source` reflect the document's **active navigation state**, defined in terms of HTML and the Navigation API:
- **Old & new URLs** and **session history indices**
- **Navigation type:** `navigate` (push/replace), `traverse` (`back` / `forward`), `reload`
- **Phase:** `loading`, `ready`, `committed`
- **Source element:** the clicked link (`<a>`, `<area>`), submitted `<form>`, or submit `<button>` / `<input>`

For **same-document navigations**, this state tracks the Navigation API's ongoing transition and commit lifecycle. For **cross-document navigations**, it begins when navigation is initiated and ends after the first rendered frame of the new document (taking precedence over non-visual same-document navigations before first render).

### Conditional navigation styling (`@navigation`)

The `@navigation` conditional group rule (and corresponding `if(navigation(...))` inline condition) supports boolean combinations (`and`, `or`, `not`) of location, phase, and history tests:

- **Location matching (`from`, `to`, `between`, `at`):**
  ```css
  @navigation (from: home) { ... }
  @navigation (to: about) { ... }
  @navigation (between: home and about) { ... }
  @navigation (at: item) { ... }
  ```
  `from` and `to` always test the navigation's old and new URLs respectively (`between: A and B` matches either direction). `at` tests the old URL before commit and swaps to the new URL once committed.

- **Phase matching (`phase`):**
  ```css
  @navigation (phase: loading) { ... }
  @navigation (phase: ready) { ... }
  @navigation (phase: committed) { ... }
  ```
  `ready` applies during same-origin cross-document navigations when the incoming document is ready prior to swap—for example, to coordinate [two-phase preview view transitions](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md#solution-2-declarative-preview-view-transitions--navigation-preview-state) or capture outgoing view-transition snapshots.

- **History type matching (`history`):**
  ```css
  @navigation (history: navigate) { ... }
  @navigation (history: reload) { ... }
  @navigation (history: traverse) { ... }
  @navigation (history: back) { ... }
  @navigation (history: forward) { ... }
  ```

### Link & trigger pseudo-classes (`:link-to()` and `:nav-source`)

- **`:link-to(<location>)`:** Matches links whose resolved `href` matches a named location from `<script type="locationmap">` or a built-in `same-*` keyword, independent of whether a navigation is currently active (and without brittle `[href=...]` string matching):
  ```css
  a:link-to(home) { ... }
  a:link-to(same-pathname) { ... }
  a:not(:link-to(same-origin))::after { content: " ↗"; }
  ```
  *(Note: when combined with `@navigation (between: list and detail)`, parameter matching between the active navigation URL and `:link-to(detail)` can pair the specific item link matching `:id`; see [w3c/csswg-drafts#13163](https://github.com/w3c/csswg-drafts/issues/13163).)*

- **`:nav-source`:** Matches the [source element](https://html.spec.whatwg.org/multipage/#navigation-source-element) (link, form, or submit button) that initiated the active navigation, reflecting `NavigateEvent.sourceElement`:
  ```css
  a:nav-source .thumb { view-transition-name: active-image; }
  ```

---

## Potential Future Enhancements

Because `<script type="locationmap">` establishes declarative named `URLPattern`s in HTML JSON, it provides a foundation for broader declarative routing capabilities beyond active-navigation styling:
- **Current-route styling outside navigations:** Styling persistent shell elements (e.g., showing an `<aside>` only on `article` pages) when idle as well as during transitions.
- **Richer `routemap` & JS events:** Exposing `MediaQueryList`-style match change events on named routes, declarative same-document interception/history modes, and integration with [declarative patching](patching-explainer.md) (`patchSource`).
- **Bidirectional UI/route binding & scoped maps:** Binding `<dialog>`/popover open state or scroll-snap carousel items to named routes and parameters, and scoping route maps to component subtrees.

<details>
<summary>Detailed sketches of future enhancements</summary>

### Extending `locationmap` into a fuller `routemap` and declarative interception

```html
<section id="dashboard">
  <!-- Future concept: scoped route rules with declarative interception -->
  <script type="routemap">
    {
      "rules": [
        {
          "name": "settings",
          "pattern": { "pathname": "/dashboard/settings" },
          "mode": "intercept",
          "history": "replace"
        }
      ]
    }
  </script>
</section>
```

### Declarative patch-based document updates

Combined with [declarative patching](patching-explainer.md), a route rule could specify a `patchSource` URL or Service Worker so the browser fetches and streams DOM patches automatically while reflecting intermediate states to `@navigation` and View Transitions:

```html
<script type="routemap">
  {
    "rules": [
      { "pattern": { "pathname": "/*" }, "patchSource": "/content/patch", "mode": "same-document" },
      { "name": "home", "pattern": { "pathname": "/" } },
      { "name": "article", "pattern": { "pathname": "/article/:id" } }
    ]
  }
</script>
```

### Bidirectional element/route binding (dialogs & scroll-snap carousels)

Binding openable elements (`<dialog>`, popovers) or scroll-snap sections to named routes could synchronize UI state and URLs without manual `open`/`close`/`navigate`/`IntersectionObserver` glue:

```html
<script type="routemap">
  {
    "rules": [
      { "name": "feed", "pattern": { "pathname": "/feed/:feedid" } },
      { "name": "settings", "pattern": { "search": "?settings=show" } }
    ]
  }
</script>
<main class="app-carousel">
  <section route="feed" data-feedid="feed12"></section>
</main>
<dialog route="settings">Settings</dialog>
```

</details>

---

## Alternatives Considered

- **Do everything in JavaScript:** Works today, but adds script payload/execution to navigation critical paths, cannot declaratively style cross-document lifecycle phases, and frequently introduces stale-state bugs across BFCache restores and history traversal.
- **Define URL patterns directly in CSS (`@location` / `url-pattern()`):** Rejected due to security risks ([w3c/csswg-drafts#14266](https://github.com/w3c/csswg-drafts/issues/14266): cross-origin CDN or injected CSS using `URLPattern` wildcards/regexes to exfiltrate URL tokens via `background-image`), base-URL mismatches (`stylesheet` vs. `document`), and duplicating `URLPattern` syntax in CSS.
- **Imperative JS registration only (`CSS.locations`):** Useful as a complementary programmatic API, but requiring JS execution to register static route maps undermines zero-JS view transitions.
- **`<link rel="locationmap">` or a bespoke CSS/custom syntax:** `<link>` cannot be inlined when desired, and inventing a custom syntax for `URLPatternInit` adds parser/tooling cost with weak benefit over standard JSON (`importmap` / `speculationrules` precedent).

<details>
<summary>Detailed evaluation of alternatives</summary>

### Just use existing JavaScript
- **Pros:** No browser changes required; arbitrary imperative logic.
- **Cons:** Heavy script overhead on navigation paths; manual coordination of pending/ready/committed states and View Transitions; error-prone cleanup on BFCache restoration.

### Define URL patterns directly in CSS (`@location` / `url-pattern()`)
- **Pros:** Single-file authoring inside `.css` files.
- **Cons:** `URLPattern` supports wildcards, prefixes, suffixes, and regexes; allowing stylesheets (including CDN or injected CSS) to match arbitrary patterns against the document URL enables probing sensitive capability URLs or query tokens via conditional resource fetches ([w3c/csswg-drafts#14266](https://github.com/w3c/csswg-drafts/issues/14266)). Relative URLs in CSS also resolve against the stylesheet URL rather than the document base URL, and CSS would need to duplicate `URLPatternInit` descriptors.

### Define locations only in imperative JS (`CSS.locations`)
- **Pros:** Reuses `new URLPattern()` directly with no new HTML `<script type>` value.
- **Cons:** Forces authors to write blocking or early-executing JS boilerplate just to name static site routes for CSS View Transitions. (A JS API can still complement `<script type="locationmap">` for dynamic routes.)

### `<link rel="locationmap">` or a CSS/custom syntax
- **Pros:** CSS-like aesthetics.
- **Cons:** `<link>` offers no inline equivalent to `<script type="locationmap">{ ... }</script>`, and custom syntaxes lose out-of-the-box JSON editor/build-tool support and 1:1 `URLPatternInit` compatibility.

</details>

---

## Accessibility Considerations

- **Loading state semantics (`aria-busy`):** Styling pending links in CSS does not replace assistive loading announcements where appropriate, though visual button/thumbnail transition curation is largely orthogonal to region-level `aria-busy` management.
- **Current link indication (`aria-current`):** `:nav-source` and `@navigation` style links *during* an active navigation, which is distinct from persistent [`aria-current="page"`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current) semantics on the resting document.

## Privacy and Security Considerations

Exposing arbitrary `URLPattern` wildcards or regular expressions directly in CSS would allow untrusted, cross-origin (e.g., CDN), or injected stylesheets to probe sensitive tokens in the document's URL via conditional CSS fetches (see [w3c/csswg-drafts#14266](https://github.com/w3c/csswg-drafts/issues/14266)).

To prevent this, CSS cannot define `URLPattern`s or match raw URLs directly. Allowed custom locations are explicitly declared by the host document in HTML via `<script type="locationmap">` (governed by CSP `script-src` and CORS for external `src` fetches, matching `<script type="importmap">` and `<script type="speculationrules">`), while built-in CSS keywords (`same-origin`, `same-pathname`, `same-url`) are strictly relational comparisons against the document's own URL and cannot probe specific path or query values. Stylesheets—whether first-party or third-party—can only query boolean matches against those pre-declared location names and coarse relational keywords.

<details>
<summary>Detailed Self-Review Questionnaire: Security and Privacy</summary>

1. **What information does this feature expose, and for what purposes?**
   Stylesheets can match `@navigation` rules and `:link-to()` selectors against named locations explicitly declared by the host document's `<script type="locationmap">`, along with active navigation phase and history type. Arbitrary URL-pattern probing from CSS is not possible.

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes. CSS only observes boolean matches against named locations opted into by the document's `locationmap`, rather than raw URLs or arbitrary wildcard/regex queries.

3. **Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?**
   No.

4. **How do the features in your specification deal with sensitive information?**
   Sensitive URL path segments or query tokens (capability URLs, session/reset tokens, OAuth parameters) cannot be sniffed by third-party or injected CSS because `URLPattern` definitions live exclusively in `<script type="locationmap">` under the document's CSP `script-src` policy.

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
    `<script type="locationmap">` (inline or via CORS-fetched `src`) loads declarative JSON location definitions rather than executable code, governed by CSP `script-src` (matching `<script type="importmap">` and `<script type="speculationrules">`).

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    See [w3c/csswg-drafts#14266](https://github.com/w3c/csswg-drafts/issues/14266). Because URL patterns are declared in the document's `<script type="locationmap">` rather than in CSS, first-party and third-party (e.g., CDN) stylesheets behave identically when referencing named locations (`@navigation (to: home)`), without exposing arbitrary parts of the document URL to third-party or injected CSS. External `<script type="locationmap" src="...">` fetches use CORS.

15. **How do the features in this specification work in the context of a browser's Private Browsing or Incognito mode?**
    No difference from normal mode; no cross-session state is stored.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    Yes—covered across HTML and [CSS Navigation Level 1](https://drafts.csswg.org/css-navigation-1/).

17. **Do features in your specification enable origins to downgrade default security protections?**
    No.

18. **What happens when a document that uses your feature is kept alive in BFCache after navigation, and potentially gets reused on future navigations back to the document?**
    Active navigation state clears automatically once navigation completes, avoiding the stale pending/transition styles common in JS workarounds when restoring from BFCache.

19. **What happens when a document that uses your feature gets disconnected?**
    Nothing special; active navigation state no longer applies.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Invalid JSON or invalid `URLPattern` entries in `<script type="locationmap">` will follow standard console/error reporting conventions (aligned with `importmap` / `speculationrules`).

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing additional.

</details>

## Stakeholder Feedback / Opposition

- **Chromium / Google:** Positive (proposal authors include Chromium contributors, and prototyping is underway).
- **Gecko / Mozilla:** No official signals yet.
- **WebKit / Apple:** No official signals yet.
- **Web Developers:** Positive interest, specifically around styling complex View Transitions (see [w3c/csswg-drafts#8209](https://github.com/w3c/csswg-drafts/issues/8209)).

## References & Acknowledgements

We would like to acknowledge the contributions of:
- The designers and maintainers of the [URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API).
- The contributors to the [CSS View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) specification.
- Everyone who participated in discussions in [WICG/declarative-partial-updates#46](https://github.com/WICG/declarative-partial-updates/issues/46), [w3c/csswg-drafts#12594](https://github.com/w3c/csswg-drafts/issues/12594), and [w3c/csswg-drafts#14266](https://github.com/w3c/csswg-drafts/issues/14266).
