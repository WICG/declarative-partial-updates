# Declarative partial updates

HTML primitives for updating parts of a document without a full page refresh
See https://github.com/whatwg/html/issues/2142 and https://github.com/whatwg/html/issues/2791 for very long context.


## Status of this document
This is an initial explainer for introducing the problem space and a few proposed solutions.
See this as a starting point for discussion rather than a finished product.

## Overview
### Full page refresh
Since the early days of the web, developers were seeking ways to work around the "document refresh" experience - having to wait when clicking a link until the next page is brought up.
Solutions to this problem have proliferated in the shape of JS-based "Single page applications" (SPAs), and frameworks that make it easier to build such applications.

Some newer web platform features such as prerendering improve this experience, however there are many situations where unloading a document and loading a new one is still inferior to keeping the document alive, including all its chat widgets, 3rd party scripts, and so on.

### Fragments/views
Web apps that require this complexity are usually richer than an HTML document that shows a single piece of content. Modern web apps are often composed of multiple "fragments" of documents, or "views", presented at the same time and layed out in a flexible way.
However, the primitives that the web platform offers for this fragmentation, i.e. iframes, are not flexible in this way. One cannot use a single stylesheet to style multiple iframes, or select all the elements given a CSS selector in multiple documents at the same time,
and the iframe's contents cannot escape its bounds, to name a few constraints.

The web platform community still uses iframes extensively, however not so much for app fragments. Instead, web frameworks are used to manage that complexity.

### Composable, same-document fragments
In modern web frameworks, composable fragments of an application have the following properties:
* It can be updated independently, without a full-page refresh.
* Its content is loaded on demand, based on the document's URL and other state.
* It shows fallback UI for loading or error conditions
* It transitions between states smoothly

### Developer Experience
All of these properties directly affect the quality of the user experience, in terms of performance and smoothness.
To achieve this kind of user experience today, developers have to rely on JavaScript libraries or frameworks that manage in-document “components”, “pages”, “layout”, loading states etc.

## Prior art
### IFrames
IFrames are an existing web-platform mechanism for reusing content. However, IFrames are heavy-handed in terms of UI. They cannot escape their box, they are styled and scripted separately, and their layout is encapsulated from the rest of the page.

### Native mobile
Native apps come with this ability built in, see for example view controllers in iOS, which provides flexible ways to manage interactions between different parts of the app, and Android Fragments. A fragment or a view is a reusable piece of an application, that has its own lifecycle and can be composed with other fragments to produce an app.

### Web Frameworks
Web frameworks, like NextJS, Remix, Nuxt etc, handle this type of problem in nuanced ways, but with a common theme of somehow mapping a URL route to a set of components that get displayed when that route is active, often something like a “page”, and with a more stable “layout” that defines the whole document and leaves spaces for those fragments.

For example, in NextJS:

```jsx
// app/layout.js
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header>My Next.js App (App Router)</header>
        <nav><!-- links to all pages --></nav>
        <main>{children}</main> {/* children represents the current page */}
      </body>
    </html>
  );
}

// app/blog/[slug]/page.js
// This component would be rendered into the {children} slot above.

export default function BlogPostPage({ params }) {
  const { slug } = params; // 'my-first-post' or 'another-article'

  return (
    <div>
      <h3>Blog Post: {slug} (App Router)</h3>
      <p>Content for {slug} goes here.</p>
    </div>
  );
```
In Remix, the concepts have different names but a similar structure:
```jsx
// app/root.jsx
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from '@remix-run/react';

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <header>My Remix App</header>
        <nav>
  </nav>
        <Outlet /> {/* This is where nested routes will render */}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
```

And also in Astro:

```html
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
  </head>
  <body>
    <header>
      <h1>{title}</h1>
    </header>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a href="/blog">Blog</a>
    </nav>
    <main>
      <slot /> <!-- This is where the page content will be injected -->
    </main>
    <footer>
      <p>&copy; 2025 Astro Example</p>
    </footer>
  </body>
</html>
```

### HotWire / TurboLinks

See https://hotwired.dev/.

The HotWire approach has a lot of similarities with this proposal, and is a source of inspiration.
In that approach, the navigation response stays the mostly same, and the client side is responsible for replacing parts of the document, mainly the `<body>` modulo "islands".

The approach here is a bit more generic, where the developer decides which parts get replaced and which stay.

## This Proposal
The goal of this proposal is to see whether the platform can help with this kind of experience, by introducing composable fragments (views, because the word fragment is used elsewhere...) and declarative partial document updates as a platform (HTML) primitive.
It consists of two parts, the first one standing on its own and the second one building on top of it.

### Part 1: Declarative partial document updates
Currently, the DOM tree is updated in the order in which its HTML content is received from the network. This is a good architecture for an article to be read linearly, however many modern web apps are not built in that way.
Often in modern web apps, the layout of the document is present, with parts of it loaded simultaneously or in some asynchronous order, with some loading indicators or a skeleton UI to indicate this progression. 

The proposal here is to extend the `<template>` element with a `for` and `mode` attributes, that would repurpose it for this type of out-of-order update.

```html
<!-- initial response -->
<section id="photo-gallery">
Loading...
</section>

<!-- later during the loading process, e.g. when the gallery content is ready -->
<template for="photo-gallery" mode="replace">
  ... the actual gallery...
</template>
```

#### Details of `<template for=... mode...>`

1. The `for` attribute behaves like `<label for>`, pointing to an ID
1. `mode` can be `replace`, `append` or `prepend`, and be extended in the future to include things like `merge`, `loading` and `error`.
1. In general, the `<template>` itself does not stay in the DOM, kind of like `<template shadowrootmode>`. However the details of this are TBD.
1. When a `<template for>` is discovered, its contents are streamed into its target element.
 
This is, in essence, a proposed solution for https://github.com/whatwg/html/issues/2791. 

### Part 2: Composable app fragments (views)

In addition to being able to declaratively stream content into the document out-of-order, we want to enable a declarative relationship between a fragment of an application and the document's URL.
Straw man proposal is to do this with a new element called `<view>`, with a `match` attribute that accepts a `URLPattern`, and intercepts matching navigations.

```html
<view match="/articles/:article-id" id=main-article>
Loading...
</view>

<!-- the user clicks a link to `/articles/foo123` -->
<!-- navigation is intercepted -->
<!-- new content includes: -->
<template for=main-article mode=replace>
  <article>
    Content of article foo123
  </article>
</template>

<style>
/* The declarative view transition would work for the declarative same-document navigation! */
@view-transition {
  navigation: auto
}
</style>
```

In an app that contains matching views, the developer does not have to worry about specifics of the navigation API, or how content is streamed.
All they have to do is match their views with URL routes, and then stream the appropriate new content wrapped in `<template for=... mode...>` snippets.
#### Details of `<view>`

1. Multiple views can be present at the same time, and updated together using the same response. The response can be *identical* to a full document navigation response, as long as the view content is wrapped in `<template for>`. 
1. A `view` would also have lifecycle events to enable developers to fine-tune its behavior using JS.
1. Declarative view transitions work out of the box.
1. The “view update” request is identical to the navigation request. Content from the fetched document response is streamed, and added to the view in chunks, like normal HTML streaming.
1. While streaming content, the `<view>` would get a pseudo-class (:partial?) activated. This pseudo-class can be used in ordinary document content streaming as well, to avoid the visual effect of streaming.
1. A partial response can include either a full document or just the modified templates, the UA should be able to work with both as valid HTML. 
1. A `<view>` can have `<template status=loading|error>` children and/or matching `<template for= mode=loading|error>` elements, which, if available, get displayed instead of the regular content while new content is loading or if there is an error fetching.
1. When the pattern stops matching, the view receives a `:deactivated` pseudo-class, and there is a UA style of `view:deactivated (content-visibility: hidden; width: 0; height: 0; interactivity: inert)` that can be overridden by the developer. Also, its contents are not DOM selectable, like a `<template>` element.
1. A request for an intercepted partial update contains header information about the views that are about to be updated, and about the fact that it's a partial update.

## Potential future enhancements
1. We can consider also supporting 1st-class HTML includes, e.g. with `<view src="...">`. The initial proposal here for `<template for>` allows for this kind of experience without an additional network request with a special signature, by streaming the content in the same document response.
   However it is not set in stone.
1. Allowing the developer to fine-tune the relationship between routes, e.g. allow some route transition to replace the current history entry rather than push a new one.
1. A reverse relationship: a `<view>` activates a URL when it becomes visible (e.g. scrolled to). This can allow creating gesture-based user interfaces without manually managing them via JS.
1. Using CSP to allow/disallow declarative navigation interception
1. Improve loading of updates via speculation rules / prefetching, and extending this further by publishing a “site map” or some such that specifies relationship between routes.

## Open issues
1. Perhaps it could be confusing that an element performs navigation interception? Does this need an opt-in in the `<head>`?
1. This architecture might lead to sending different responses for the same URL based on headers, e.g. a partial document response. This doesn’t work well cross-browser and cross-CDN. Perhaps the partial responses need a separate URL, with the `src` attribute, and the intercepted navigation responses should be expected to be full?
1. How does this interact with declarative shadow DOM? Can parts of a declarative shadow DOM be streamed in this way?
1. Interaction with templating proposals such as DOM Parts
1. Should `<view>` be a regular element in the DOM? Does that prevent it from being part of SVG/MathML/tables etc? Perhaps it should be a set of attributes/processing instruction?
1. ID refs are notoriously footgunny and it's easy to get them wrong. However, they are the current referencing enabler of the web platform. Perhaps there is some way to go about refs that improves things for other features as well?


## Considered Alternatives & Tradeoffs

### HTML "include"

The `<template for>` / `<view>` proposal puts HTML streaming at the forefront rather than HTML includes.
This choice might seem surprising, and is open for debate, and has a few trade offs.
In general, however, those approaches do not conflict and either can be added as an enhancement.

The main theme of `<template for>` is that it is not opinionated about which parts of the DOM can be dynamically updated.
Anything in the DOM with an ID (or with any other form of reference like CSS selectors if we choose to go down that route) can be streamed into with a `<template for>` snippet.
It can be a `<view>` but it can also be appending into a `<ul>`. To achieve this with HTML includes we'd need to do something like add processing instructions with a URL in multiple parts of the DOM, or somehow treat the include element in a special way.

In addition, HTML includes require that each place in the DOM that can be dynamically updated in this way needs to have a URL and an endpoint that knows how to serve it individually.
Instead, in the streaming approach, the process of *navigating* is where this decision is made and all the fresh content is generated.
The navigation response can update one, multiple or no parts of the DOM, as long as they're referrable, and there is no need to keep multiple individual `<view>` requests in sync.
In fact, streaming itself is optional. The important bit is that a navigation response carries all of the updated state in a somewhat "atomic" manner.
 
An HTML include by itself, without the view-style navigation, would require some added semantics (probably script?) as to when it is re-fetched from its URL.
And if we do connect it with view-style navigation, it becomes a "simplified" combination of `<view>` and `<template for>`, where we know in advance that this navigation is going to update this view, and reach for a particular URL to grab this information.



### IFrames
Too many gotchas and constraints, in term of layout/UI and ergonomics of crossing documents. This approach tries to work with how modern web development apps work, where the fragments are part of the same document.

### Element-to-element
The HTMX approach, where a form or link can target an element for its output, is a really nice concept.
In some ways, it overlaps with other concepts being developed in the web platform, such as invokers.
In any case, the HTMX approach feels more like a development-time concept that the web platform does not need to be opinionated about.
By allowing partial updates together with a link between the document's URL (which is a UX concept, as that URL can be shared, QRed, linked etc) and the composable fragment.

### Enhancing `<slot>`
This is possible, and has similarities with declarative shadow DOM, in terms of out-of-order content. It might be more complex/confusing than its worth as a `<view>`, as in the right context a `<slot>` and a `<view>` behave massively differently.

### Enhancing MPA architecture capabilities
This architecture primarily focuses on extending the ergonomics and capabilities of same-page applications. It is possible to explore other avenues that work in a more MPA/cross-document manner.
However, it is unclear what that’s going to look like, and would potentially lead to an IFrame-based architecture.

## Lastly, is the web platform competing with frameworks?
The direction of this proposal is to tackle the specific aspects of out-of-order streaming and composable fragments, which are issues that frameworks tackle as well.
However, this proposal is agnostic to a lot of DX-time aspects of frameworks, and in particular templating or how a JS or JSON-based model is compiled to HTML.
Frameworks can provide a lot of value in terms of opinionated development time ideas, which can be incorporated with stronger browser foundations around seamless navigation and content streaming.
