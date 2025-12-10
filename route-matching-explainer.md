# Declarative Route Matching

[@noamr](https://github.com/noamr) and [@dbaron](https://github.com/dbaron), September 2025 / December 2025

(This document is currently partway through being updated to reflect the current state of the work.)

# Related links

* [current css-navigation-1 specification draft](https://drafts.csswg.org/css-navigation-1/)
* [current specification issues (open and closed)](https://github.com/w3c/csswg-drafts/issues?q=label%3Acss-navigation-1%20is%3Aissue)
* initial syntax discussion for HTML route matching: https://github.com/WICG/declarative-partial-updates/issues/46
* initial discussion for CSS route matching: https://github.com/w3c/csswg-drafts/issues/12594

# Motivation and Use Cases

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

The goal of this feature is to make it easier for authors to declaratively set up styles
for this sort of transition.
This means adding features that:
* match patterns of URLs by exposing [URL Patterns](https://urlpattern.spec.whatwg.org/) in CSS
* apply styles conditionally based on the origin and destination of the current navigation, so that transitions between particular sets of URLs (whether separate documents or separate states/routes within a single page app) can be styled
* style an HTML link based on its target matching both the origin or destination of the current navigation *and* matching a particular URL pattern, which allows matching the correct item within the list in a list-to-details or details-to-list transition.

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
  @route (to: home) {
     a:remote-link + spinner { opacity: 100%; }
  }

  @route (to: about) {
     a:remote-link { color: grey }
  }
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

See https://github.com/w3c/csswg-drafts/issues/12829

When performing a cross-document view-transition, the transition often has to delay until the next document is ready.
By using route-matching, we can render a "preview" of the new state using style only, and transition to that instantly, before continuing to the final content.

```css
@route (to: article) {
   .article-skeleton { display: block }
}

@navigation {
  view-transition: with-preview;
}
```

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

## Style based on current route
In addition to the curation of the navigation itself, it is a common technique in modern web apps to have a "shell" that is common between pages and mostly static, and an "outlet" area for the dynamic content.
However, some parts of the shell often still have some dynamic parts that appear on "some" pages or in some scenarios, or appear different based on the current page.

For example, a chat widget or members area might only appear in certain pages. A "related" `<aside>` element might only appear in article pages.

# The initial proposed solution: HTML route map with CSS reflection
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

## CSS reflection

Naming a set of these rules in HTML already gives us something that CSS can build on:
```css
@route (home) {
  #chat-widget { display: none; } 
}

nav {
  a:remote-link(pending) .spinner {
    animation: spin;
  }
}

/* navigation-based view-transition can work out of the box
   because we can count on the final CSS state */
@view-transition {
  navigation: auto;
}

/* or be route-specific */
@route (to: article) {
  @view-transition {
    navigation: auto;
    types: slide-3d;
  }
}
```

# Potential future enhancements
## Declarative interception & history-handling

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

## Declarative patch-based document updates

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

## Mapping between "Open/closed" UI elements and URLs
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

## Scroll/gesture-based navigation with lazy-loading
Some modern UIs (e.g. Instagram, TikTok) use scroll-snapping or carousels to navigate between app fragments in a way that maps nicely to URL navigation.
For example, a URL retrieved from a QR code should not only scroll to the right app fragment but also render the correct state from the server.

While the web platform allows matching between scrolling and URLs using ID mapping, this is:
- limited to hash-fragments only, while some of these URL changes are better expressed by URLs that are seen by the server (like path changes).
- Uni-directional. The user scrolling to a fragment doesn't automatically change the URL
- Loading content lazily based on element proximity to the viewport is cumbersome, and requires careful use of `IntersectionObserver` or `content-visiblity` (including the `contentvisibilityautostatechange` event).

## Element/route binding

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

## Element-scoped route maps

Allow intercepting navigations and styling current routes in a way that's encapsulated for a certain element.
This can allow using navigation-like features inside a component without necessarily affecting the document's URL/state.

More details on that TBD.

# Summary
- Declarative route matching is about mapping between UI and URL navigation.
- It is done by naming `URLPattern`s as routes, and mapping them to style (and later on to HTML-UI).
- It can be used to offload the pending/optimistic aspect of navigations to the browser, also when using a framework router for the actual content updates.
- It is also designed in a way that can be extended to be as a simple standalone router, when the route changes are limited to UI/style, alongside patching, or by integrating JS-based routing with its new events.

# Alternatives considered

## Just use existing JS
It is possible today to polyfill most of these behaviors with a framework, or with custom states and web components, or by updating HTML attributes to reflect navigation state.
However, incorporating this into the browser can shave off a lot of JS, and even to no JS in some cases, in a place that is generally performance sensitive and very user-visible (an interaction causing a navigation).
In addition, the more this is coupled with navigation experiences, the harder it is to script in a way that's both performant and developer friendly.

Another big issue with using JS is that it requires the caller to properly clean up state. This can be tricky when cross-document navigations are involved, as it's not exactly clear when the state needs to be cleared.
(But it does need to be cleared since the page might be restored from BFCache.)

```js
navigation.addEventListener("navigate", async event => {
  const next_route_name = get_route_from(event.destination);
  document.documentElement.classList.add("show-preview");
  // Not intercepted, so need to clean it up. When? Maybe after
  // pagehide? Will it actually run? Would developers remember to
  // do this?
  await new Promise(resolve => window.addEventListener("pagehide", resolve);
  document.documentElement.classList.remove("show-preview");
});

addEventListener("pagehide", () => {
  // 
});
```


## Contain this in CSS
Since the first use case for routes is driven by CSS, it is tempting to contain everything in CSS, including the URL patterns themselves.
However, this means that:
- all the 3rd party stylesheets that work with routes have access to the raw URL by defining their own URL patterns
- We would need to create an HTML version of this once we connect routes with HTML UI
- CSS "feels" like the wrong place to include a route map (arguably).


## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

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

N/A

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


