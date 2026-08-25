# Styling based on navigation state

## Authors:

- Noam Rosenthal ([@noamr](https://github.com/noamr))
- David Baron ([@dbaron](https://github.com/dbaron))

## Participate
- **Issue tracker:** [GitHub Issues for css-navigation-1](https://github.com/w3c/csswg-drafts/issues?q=label%3Acss-navigation-1+is%3Aissue)
- **Discussion forum:** [Initial syntax discussion for HTML route matching](https://github.com/WICG/declarative-partial-updates/issues/46) and [CSS route matching discussion](https://github.com/w3c/csswg-drafts/issues/12594)
- **Specification Draft:** [CSS Navigation Level 1](https://drafts.csswg.org/css-navigation-1/)

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
- [Authors:](#authors)
- [Participate](#participate)
- [Table of Contents](#table-of-contents)
- [Introduction](#introduction)
- [Motivation and Use Cases](#motivation-and-use-cases)
  - [Goals](#goals)
  - [Non-Goals](#non-goals)
- [Navigation-aware styling](#navigation-aware-styling)
  - [Framework routers](#framework-routers)
  - [Vanilla](#vanilla)
- [Two-phase preview view transitions](#two-phase-preview-view-transitions)
- [Declarative same-document view transitions](#declarative-same-document-view-transitions)
- [CSS Navigations 1](#css-navigations-1)
  - [URL patterns](#url-patterns)
  - [Locations](#locations)
  - [Active navigation state](#active-navigation-state)
  - [Conditional navigation styling](#conditional-navigation-styling)
  - [URL matching](#url-matching)
  - [Phase matching](#phase-matching)
- [Link matching](#link-matching)
  - [Link matching by location](#link-matching-by-location)
  - [Matching the navigation's source element](#matching-the-navigations-source-element)
- [Potential future enhancements](#potential-future-enhancements)
  - [Future enhancement: Style based on current route](#future-enhancement-style-based-on-current-route)
  - [Future enhancement: HTML route map with CSS reflection](#future-enhancement-html-route-map-with-css-reflection)
  - [Declarative interception & history-handling](#declarative-interception--history-handling)
  - [Declarative patch-based document updates](#declarative-patch-based-document-updates)
  - [Mapping between "Open/closed" UI elements and URLs](#mapping-between-openclosed-ui-elements-and-urls)
  - [Scroll/gesture-based navigation with lazy-loading](#scrollgesture-based-navigation-with-lazy-loading)
  - [Element/route binding](#elementroute-binding)
  - [Element-scoped route maps](#element-scoped-route-maps)
- [Summary](#summary)
- [Alternatives considered](#alternatives-considered)
  - [Just use existing JavaScript](#just-use-existing-javascript)
  - [Define the locations in JS, and conditions in CSS](#define-the-locations-in-js-and-conditions-in-css)
- [Privacy and Security Considerations](#privacy-and-security-considerations)
  - [Summary](#summary)
  - [Detailed Self-Review Questionnaire: Security and Privacy](#detailed-self-review-questionnaire-security-and-privacy)
- [Stakeholder Feedback / Opposition](#stakeholder-feedback--opposition)
- [References & Acknowledgements](#references--acknowledgements)
<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Introduction

Declarative Route Matching introduces CSS extensions that allow styles to adapt dynamically based on the site's navigation state. By exposing URL Patterns in CSS, authors can conditionally apply styles and view transitions based on the origin, destination, phase, and history type (e.g., back/forward) of a navigation, as well as style the specific link that triggered the transition.

Currently, orchestrating page transition styles—especially for complex patterns like list-to-details transitions or pending loading states—requires heavy, error-prone client-side scripting to manage state across pages or same-document updates. Declarative Route Matching moves this style orchestration directly to the browser, simplifying web development, improving performance, and ensuring a robust, native navigation experience.

## Motivation and Use Cases

[CSS View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
provide a way to animate transitions between views in a web site.
The goal of these animations is to help users understand, through visual movement,
the change that happens in a user interface when they take some action.
(In some cases that action changes to a different state of a single page app,
while in other cases that action loads a different page.
View transitions work for both cases.)

Some important use cases for view transitions have proven difficult for authors to do at all
and even more difficult for them to do well
(for example, without getting into incorrect states after back/forward history traversal).
One case that we're focusing on in the design of this feature is the desire to show a transition
between a view that shows a list of items
and another view that shows the details for one of the items in the list
(possibly also retaining the view of the list itself in some form).
We talk about these as a "list to details" transition or "details to list" transition,
and this use case has been discussed for a while
in [w3c/csswg-drafts#8209](https://github.com/w3c/csswg-drafts/issues/8209).

### Goals

- **Declarative Navigation Styling:** Enable authors to style transitions conditionally based on the origin, destination, and history type (e.g., back/forward) of the active navigation.
- **Expose URL Matching in CSS:** Provide a mechanism to match URL patterns directly within stylesheets using URL Patterns.
- **Link-to-Navigation Association:** Allow styling individual HTML link elements depending on whether their target matches the destination or origin of the current navigation (e.g. for list-to-details transitions).
- **Navigation Lifecycle Reflection:** Expose the loading phase/lifecycle (e.g., loading, ready, committed) to CSS to style transition states.

### Non-Goals

- **Replace Client-Side Routers:** This feature does not aim to replace frameworks or client-side libraries that manage DOM structure, data fetching, or component instantiation.
- **Handle Server Fetching Logic:** This feature is focused on styling and transition curation, not on controlling network-level resource retrieval or server-side rendering logic.

## Navigation-aware styling
### Framework routers
While handling route-based style changes in scripting is certainly doable today, the author often has to go out of the way to curate the user experience of the navigation itself.
See unmodified example from [React Router](https://reactrouter.com/start/framework/pending-ui):

```tsx
import { NavLink } from "react-router";

function Navbar() {
  return (
    <nav>
      <NavLink to="/home">
        {({ isPending }) => (
          <span>Home {isPending && <Spinner />}</span>
        )}
      </NavLink>
      <NavLink
        to="/about"
        style={({ isPending }) => ({
          color: isPending ? "gray" : "black",
        })}
      >
        About
      </NavLink>
    </nav>
  );
}
```

- `<NavLink>` (similar to `<Link>`) wraps HTML links to connect them with the framework router, allowing the link itself to reflect state about its navigation.
- In turn, the router matches a URL pattern with a UI component, and also manages the different states of navigation, `isPending` in this case.

What if it could look like this?
```html
<style>
  @location --home { pathname: "/"; base-url: document; }
  @location --about { pathname: "/about"; base-url: document; }
  :active-navigation(to --home) + spinner { opacity: 100%; }
  :active-navigation(to --about) { color: grey }
</style>
<nav>
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

### Vanilla

When no framework is used, this is even more complex, as the author has to manage the "pending" state and route changes themselves with script, e.g.:
```js
navigation.addEventListener("navigate", e => {
  e.intercept({
    async handler() {
      document.body.dataset.state = "pending";
      await load_actual_content();
      document.body.dataset.state = "loaded";
      document.body.dataset.route = route_from(e.destination.url);
   }
  });
});
```

## Two-phase preview view transitions

See [two-phase view transitions explainer](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md#solution-2-declarative-preview-view-transitions--navigation-preview-state)

## Declarative same-document view transitions

In order to integrate either of the above with view-transitions, the author has to either rely on the framework to bake view-transitions into the router, or add even more complexity to the interception.
The client event handling code can grow wild for things that are essentially curation of style.

```js
navigation.addEventListener("navigate", e => {
  e.intercept({
    async handler() {
      // We don't want to wait until the view transition is over to *start* loading the content.
      const actual_content_promise = load_actual_content();

      // This would display a transition until the pending state.
      // More complex curation requires more complex set up here.
      await document.startViewTransition(() => {
        document.body.dataset.state = "pending";
      }).updateCallbackDone;
      await actual_content_promise;
      document.body.dataset.state = "loaded";
      document.body.dataset.route = route_from(e.destination.url);
   }
  });
});
```

## CSS Navigations 1

The scope of `css-navigation-1` is to:
* change style conditionally (importantly including view transition) based on current navigation state
* apply style to links that participate in navigations

### URL patterns

One main issue with URL matching is that URL comparison is notoriously finicky.
For example, a link to the `/about` page might be written as `/about`, `/about/`, or even `/about?utm_source=something`.

This has been addressed by the [URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API), by allowing
a `URLPattern` to act as a "matcher" - a set of rules to extract parameters from a URL or match it against another URL.

The `css-navigation-1` happily adopts the concept of URL patterns.

### Locations

The `css-navigation-1` spec exposes a `@location` rule, which allows naming a URL or url pattern for use by conditional `@navigation` rules or link styling.
```css
@location --home {
  pathname: "/";
  base-url: document;
}
```

A `@location` can be a URL pattern or a URL.

In addition, the `url-pattern(string)` function can be used to define a quick URL pattern without having to name it.

### Active navigation state

Both link matching and conditional navigation styling rely on the concept of "active navigation state".
The active navigation state is defined in terms of the HTML standard, and contains:
* The old & new URLs
* The old & new history index
* type (push, replace, traverse, reload)
* phase (loading, ready, committed)
* The source element (clicked link, form, or submit button)

The CSS exposed definitions all rely on this state and reflect it.

This state is processed differently based on one of the following scenarios:
* For a same-document navigation, it relies on the navigation API and on its definition of whether a navigation is "committed".
* For a cross-document navigation, it starts when the navigation is initiated, and ends in the first frame of the new page.

When same-document navigations occur before the new page is rendered, the cross-document navigation takes precedence,
as the same-document navigation is "non-visual" so cannot be styled.


### Conditional navigation styling

The `@navigation` at rule, as well as its corresponding `if (navigation())` clause, matches the rule with the above active navigation state.


### URL matching

```css
@navigation (from: --home) { ... }
@navigation (to: --about) { ... }
@navigation (between: --home and --about) { ... }
@navigation (at: url("/exact/?a=b")) { ... }
```

The `from`, `to`, `with`, and `at` queries define which URL to match in the active navigation state.
The `from` and `to` URLs are always the old & new ones, while `with` and `at` start as being equivalent to `from` and `to`, and swap when the navigation is committed, either by a same-document navigation API commit, or by the pages swapping in a cross-document navigation.


### Phase matching

```css
@navigation (phase: loading) { ... }
@navigation (phase: ready) { ... }
@navigation (phase: committed) { ... }
```

The `phase` query represents the phase of the active navigation state.
The `ready` phase is a bit special, and is only active in a (same-origin) cross-document navigation when the new document is ready but not swapped yet, e.g. for the purpose of showing a [preview](https://github.com/w3c/csswg-drafts/blob/main/css-view-transitions-2/two-phase-transition-explainer.md#solution-2-declarative-preview-view-transitions--navigation-preview-state) or for capturing the old state of a cross-document view transition.


#### Navigation type matching

```css
@navigation (history: navigate) { ... }
@navigation (history: reload) { ... }
@navigation (history: traverse) { ... }
@navigation (history: back) { ... }
@navigation (history: forward) { ... }
```

The `history` query matches with the active navigation state's navigation type and session history indices.
It can help style different view transitions (or any other navigation-based style) differently based on the type of navigation.
e.g.:

```css
@view-transition {
  navigation: auto;
  types: slide-from-right;
}

@navigation (history: back) {
  @view-transition {
    navigation: auto;
    types: slide-from-left;  
  }
}
```

## Link matching

Apart from conditionally styling based on a navigation, links can be styled if they participate in a navigation.

### Link matching by location

The `:link-to` pseudo-class doesn't take navigation into account, but allows for matching a link URL without resorting to string matching of the `href` attribute:

```css
a:link-to(--home) { ... }
a:link-to(url-pattern("/about")) { ... }
a:link-to(url("/exact?a=1")) { ... }
```

### Matching the navigation's source element

The navigation's [source element](https://html.spec.whatwg.org/multipage/#navigation-source-element) is a link, form, or submit button.

The `:navigation-source` pseudo class allows styling that particular link, for the course of the navigation:

```css
:navigation-source { animation-name: blink; } 
```

## Potential future enhancements

### Future enhancement: Style based on current route
In addition to the curation of the navigation itself, it is a common technique in modern web apps to have a "shell" that is common between pages and mostly static, and an "outlet" area for the dynamic content.
However, some parts of the shell often still have some dynamic parts that appear on "some" pages or in some scenarios, or appear different based on the current page.

For example, a chat widget or members area might only appear in certain pages. A "related" `<aside>` element might only appear in article pages.

### Future enhancement: HTML route map with CSS reflection
- Routes are declared in HTML, to avoid requiring all the stylesheets to know the different route URLs or leak those URLs directly, and also to allow future enhancements that are not necessarily style-based.
- A route at is core is a named `URLPattern`.
- Matching a route can be toggle-like event target, similar to media-query matching. It can help responding to specific route changes without having to intercept *all* navigations.

```html
<head>
  <!-- This routemap applies to the whole document. It doesn't interfere
       with a framework router because it doesn't intercept navigations. -->
  <script type=routemap>
     {"rules": [
        {"name": "home", "pattern": {"pathname": "/" } },
        {"name": "about", "pattern": {"pathname": "/about" } },
        {"name": "article", "pattern": {"pathname": "/article/:article-id" } }
     ]}
  </script>
</head>
<body>
  <section id=dashboard>
    <!-- This routemap applies to the section -->
    <script type=routemap>
     {"rules": [
        {"name": "settings", "pattern": {"pathname": "/dashboard/settings" } }
     ]} 
    </script>
  </section>
</body>
```

### Declarative interception & history-handling

In addition to CSS reflection, some basic navigation interception capabilities can be provided out of the box:
- Intercepting without side effects (navigations that just change style)
- Changing the history mode (e.g. having some routes not add a history entry or not change the URL at all)

This complements the CSS reflection and element binding features, as with those some same-document navigation can have a meaningful UI effect (either style-only or semantic) without necessarily requiring a custom script.

```html
</head>
<body>
  <!-- A scoped router would only intercept navigations that
       originated from within the scope -->
  <section id=dashboard>
    <!-- This can work without a JS router at all!
         Linking to `/dashboard/settings` would replace the URL and
         display the settings without event-driven scripting -->
    <script type=routemap>
     {"rules": [
        {"name": "settings", "pattern": {"pathname": "/dashboard/settings"},
         "mode": "intercept", "history": "replace" }]} 
    </script>
  </section>
</body>
```

### Declarative patch-based document updates

(Future vision of putting it all together)

Together with the [patching](https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md) feature, routes can provide a fully declarative mechanism for updating the document, with the decision of what content goes in each route offloaded to a server or service worker:
```html
<head>
  <script type=routemap>
     {
        "rules": [
        {"pattern": {"pathname": "/*" }, "patchSource": "/content/patch", "mode": "same-document" },
        {"name": "home", "pattern": {"pathname": "/" } },
        {"name": "about", "pattern": {"pathname": "/about" } },
        {"name": "article", "pattern": {"pathname": "/article/:article-id" } }
     ]}
  </script>
</head>
```

By providing a `patchSource` to a rule or set of rules, which is a URL or a `serviceWorker` (exact semantics TBD), updating the document is performed by the browser, without interaction-time javascript.
The stream of interleved patches is fetched from the URL (or from the service worker using the navigation URL), and applied to the document or scope element, while reflecting the intermediate states to CSS and performing view transitions etc.

When combined with scroll-based navigation, the patch stream can be fetched lazily as the bound element approaches the viewport, making lazy loading of scrollable content easier.

### Mapping between "Open/closed" UI elements and URLs
Dialog/popover and other "openable" UI elements are currently openable by a button and something like a command invoker.
However, sometimes an author would want to reflect this UI state in the URL, and have that URL lead to that UI state.

For example, having the URL `/settings` open the settings dialog, and having the settings dialog open shareable as the `/settings` URL.

To do this today, this mapping has to be done using events:
```js
settingsDialog.addEventListener("open", () => navigation.push("/settings");
settingsDialog.addEventListener("close", () => navigation.back());
navigation.addEventListener("navigate", e => {
  if (new URL(e.destination.url).pathname === "/settings") {
    e.intercept({ handler: () => settingsDialog.open() });
  }
});
```

### Scroll/gesture-based navigation with lazy-loading
Some modern UIs (e.g. Instagram, TikTok) use scroll-snapping or carousels to navigate between app fragments in a way that maps nicely to URL navigation.
For example, a URL retrieved from a QR code should not only scroll to the right app fragment but also render the correct state from the server.

While the web platform allows matching between scrolling and URLs using ID mapping, this is:
- limited to hash-fragments only, while some of these URL changes are better expressed by URLs that are seen by the server (like path changes).
- Uni-directional. The user scrolling to a fragment doesn't automatically change the URL
- Loading content lazily based on element proximity to the viewport is cumbersome, and requires careful use of `IntersectionObserver` or `content-visiblity` (including the `contentvisibilityautostatechange` event).

### Element/route binding

While CSS is a great fit for some use cases, including ones that display and hide visual elements based on route, this doesn't work well
with UI elements that are more than visual, like dialogs and popovers, or elements that can be scrolled to.

To achieve the uses cases for dialog or scroll-based navigation in a way that works well with URL navigation, proposing to allow "binding" an element to a route and route params, in a similar way to command invokers (though bidirectional).
When an element is bound to a route+param, it is:
- opened/scrolled to when navigating to that route+param
- Changes the URL based on the route rules when opened by the user
- Emits events that help lazily load the content for the route if the scrolling element is close to the viewport

```html
<script type=routemap>
{"rules": [
  {"name": "feed", "pattern": {"pathname": "/feed/:feedid"} },
  {"name": "settings", "pattern": {"search": "?settings=show"} }
]}
</script>
<main class="app-carousel">
  <...>
  <section route=feed data-feedid="feed12"></section>
  <...>
</main>
<dialog route=settings>Settings</dialog>
<!-- This would open the settings dialog -->
<a href="?settings=show">Settings</a>
<!-- This would scroll the app carousel to feed 12 -->
<a href="/feed/feed12">Feed 12</a>

<script>
// Lazily load route content
document.routeMap.get("feed").addEventListener("prepare", e =>
    fetch(`/feed-content?id=${e.value}`));
</script>
```

### Element-scoped route maps

Allow intercepting navigations and styling current routes in a way that's encapsulated for a certain element.
This can allow using navigation-like features inside a component without necessarily affecting the document's URL/state.

More details on that TBD.

## Summary
- Declarative route matching is about mapping between UI and URL navigation.
- It is done by naming `URLPattern`s as routes, and mapping them to style (and later on to HTML-UI).
- It can be used to offload the pending/optimistic aspect of navigations to the browser, also when using a framework router for the actual content updates.
- It is also designed in a way that can be extended to be as a simple standalone router, when the route changes are limited to UI/style, alongside patching, or by integrating JS-based routing with its new events.

## Alternatives considered

### Just use existing JavaScript

One option is to require authors to polyfill or manually implement all route matching and style changes in scripting using frameworks, web components, or global `navigate` event listeners.

#### Pros
* **No browser changes required:** Works on the platform today.
* **Ultimate flexibility:** Authors can write custom, arbitrary JS logic for any complex routing edge case.

#### Cons
* **Heavy script overhead:** Adds extra JS execution and payload to performance-sensitive navigation paths.
* **Complex state lifecycle:** Requires developers to manually coordinate active, pending, and transition styles, which is error-prone.
* **BFCache issues:** Developers must remember to properly clear styles when pages are restored from BFCache, which is a common source of bugs.

#### Reason for rejection
Bringing route matching natively to the browser reduces developer boilerplate, avoids common BFCache memory/cleanup bugs, and moves style-based curation out of JS entirely.

---

### Define the locations in JS, and conditions in CSS

Another alternative is to restrict route/location definitions exclusively to JS or HTML (e.g., using a markup-based route map), and only expose media-query-like matching rules in CSS.

#### Pros
* **Encapsulation:** Restricts third-party stylesheets from learning URL layouts by guessing URL patterns directly in CSS.
* **Separation of Concerns:** Keeps route URLs in markup/script while CSS only references abstract route names.

#### Cons
* **Friction and duplication:** Authors must write and synchronize definitions across HTML, JS, and CSS just to style a transition.
* **Limited styling flexibility:** Restricts CSS-only libraries or widgets from self-declaring transitions without coordinating with the page's host code.

#### Reason for rejection
While HTML/JS route definition is a natural future enhancement (which we plan to integrate), requiring it as a prerequisite adds unnecessary friction. Exposing declarative locations in CSS is highly developer-friendly and handles styling use cases directly.


## Accessibility considerations

### Skipping ARIA opportunities
As with other features where JS is skipped in favor of a direct CSS representation of DOM state, this might encourage developers to avoid updating accessibility-related states like [`aria-busy`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy).
This is a conceptual trade-off, but in practice styling buttons or selecting view-transition names based on inbound/outbound location is not directly related to getting ARIA right for navigation.

### Communicating the current link
The spec allows styling the current link during a navigation, which is somewhat adjacent to [`aria-current`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current).
However, that concept is not exactly the same, as indicating the "current" link in ARIA is something that works also outside the lifecycle of the navigation.

If more accessibility considerations come up as we go along, we will update this explainer.

## Privacy and Security Considerations

### Summary
Exposing URL Patterns directly in CSS raises concerns about exposing the document URL to 3rd party CSS. To mitigate this, only origin-clean stylesheets can match relative URL patterns. Additionally, matching logic evaluates during the active navigation lifecycle, and is constrained to URL patterns that the author defines, limiting arbitrary sniffing of historic states.

See https://github.com/w3c/csswg-drafts/issues/14266 for dicussion about this.

### Detailed Self-Review Questionnaire: Security and Privacy

1.  What information does this feature expose,
     and for what purposes?

It does not expose new information.

2.  Do features in your specification expose the minimum amount of information
     necessary to implement the intended functionality?

N/A

03.  Do the features in your specification expose personal information,
     personally-identifiable information (PII), or information derived from
     either?

No

3.  How do the features in your specification deal with sensitive information?

N/A

4.  Does data exposed by your specification carry related but distinct
     information that may not be obvious to users?

No

7.  Do the features in your specification introduce state
     that persists across browsing sessions?

No

9.  Do the features in your specification expose information about the
     underlying platform to origins?

No

11.  Does this specification allow an origin to send data to the underlying
     platform?

No

13.  Do features in this specification enable access to device sensors?

No

14.  Do features in this specification enable new script execution/loading
     mechanisms?

No. They do expose new declarative ways to expose things that were so far only possible to do with JS,
however they are still exposed as "script".

16.  Do features in this specification allow an origin to access other devices?

No.

17.  Do features in this specification allow an origin some measure of control over
     a user agent's native UI?

No.

19.  What temporary identifiers do the features in this specification create or
     expose to the web?

N/A

20.  How does this specification distinguish between behavior in first-party and
     third-party contexts?

Yes, see https://github.com/w3c/csswg-drafts/issues/14266

We currently propose to use the referrer of the stylesheet as the base URL, protected by the referrer policy.

Note that even with that, there is new information available to the stylesheet, as the document's URL while navigating is not necessarily the referrer.
Howevere, the URL is not easy to decipher from the stylesheet, as the stylesheet would have to guess all the possible locations, put them into URL patterns,
and hope that the user navigates to them, in order to trigger something that exfiltrates it like a `background-image` URL.

This is likely more cumbersome than exfiltrating that kind of information based on the DOM itself, e.g. using attribute selectors.

21.  How do the features in this specification work in the context of a browser’s
     Private Browsing or Incognito mode?

N/A

22.  Does this specification have both "Security Considerations" and "Privacy
     Considerations" sections?

It is intended to be part of the HTML standard, so yes.

23.  Do features in your specification enable origins to downgrade default
     security protections?

No

24.  What happens when a document that uses your feature is kept alive in BFCache
     (instead of getting destroyed) after navigation, and potentially gets reused
     on future navigations back to the document?

Nothing

25.  What happens when a document that uses your feature gets disconnected?

Nothing

26.  Does your spec define when and how new kinds of errors should be raised?

It will.

28.  Does your feature allow sites to learn about the user's use of assistive technology?

No

29.  What should this questionnaire have asked?

Nothing

## Stakeholder Feedback / Opposition

- **Chromium / Google:** Positive (proposal authors include Chromium contributors, and prototyping is underway).
- **Gecko / Mozilla:** No official signals yet.
- **WebKit / Apple:** No official signals yet.
- **Web Developers:** Positive interest, specifically around styling complex View Transitions (see discussion in [w3c/csswg-drafts#8209](https://github.com/w3c/csswg-drafts/issues/8209)).

## References & Acknowledgements

We would like to acknowledge the contributions of:
- The designers and maintainers of the [URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API).
- The contributors to the [CSS View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) specification.
- Everyone who participated in discussions in [WICG/declarative-partial-updates#46](https://github.com/WICG/declarative-partial-updates/issues/46) and [w3c/csswg-drafts#12594](https://github.com/w3c/csswg-drafts/issues/12594).
