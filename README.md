# Declarative partial updates

HTML primitives for updating parts of a document without a full page refresh
Addresses [HTML streaming](https://github.com/whatwg/html/issues/2142), and potentially sets the stage for [client side includes](https://github.com/whatwg/html/issues/2791)

## Status of this document
This is an living explainer. It is continuously updated as we receive more feedback and update the design and the prototypes.

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

## Design principles
Our approach to partial document updates acknowledges the current dominance of full-stack frameworks in this area. The underlying design principles of this proposal are twofold:
1. *Empowering Native UX*: We aim to enable a powerful, declarative user experience for same-document navigations, mirroring the seamless platform integration seen in cross-document navigations. This functionality is intended to be usable directly, independent of larger web frameworks.
2. *Extensibility and Compatibility*: Concurrently, the proposal should be enhanced to include ample flexibility and low-level extensibility points. This would ensure that current framework ecosystems and custom application logic can integrate with and leverage specific aspects of the solution, avoiding the need for a complete architectural overhaul, or choosing this as an all-or-nothing framework/solution of its own.

As we go along with more specific design, we should make sure that we're honest with ourselves for meeting the bar of these design principles.

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
It consists of three parts. The first two stand on their own, and the last one uses the first two:
* Patching (out-of-order streaming)
* Route matching
* Declarative same-document navigations

### Part 1: Patching (out-of-order streaming)

* Stream content directly into an HTML element
* Interleave content for multiple outlets in one HTML stream

See https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md

### Part 2: Route matching

* Declare document or element-scoped "routes", URL Patterns with attached rules
* Enable optimistic/pending UI, route-based styles, and declarative view transitions for same-document navigations
* Bind open/close behavior and scroll-snapping to routes
* Enable simple UI-based navigation interception without event-driven JS
* Together with patching, enable a fully declarative same-document navigation lifecycle

See https://github.com/WICG/declarative-partial-updates/blob/main/route-matching-explainer.md

## Considered Alternatives & Tradeoffs

### HTML "include"

The `<template patchfor>`  proposal puts HTML streaming at the forefront rather than HTML includes, however it allows for HTML includes as well by streaming from an external URL using the `patchsrc` attribute.
This addresses some of the issues found in previous HTML inclusion proposal, as it clarifies the semantics of the included content - it's a streaming "patch" with an inline fallback, and works like other patches with an additional external fetch. 

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

### Lower-level JS API
Another way to go about this is to introduce JS primitives that introduce similar functionality but are less opinionated in terms of being declarative.
At least for out-of-order streaming, this can definitely be a useful primitive alongside the more server-driven HTML primitive.

### Using `multipart/form-data` instead of `<template patchfor>`
Multipart form data (e.g. `Response.formData()` is a battle tested encoding for multiple parts, however it is quite antiquated and rigid (has only two attributes that are specified in the RFC).
The main benefits of multipart is the ability to encode multiple mime types in the same response, however this is not useful when encoding HTML only.
The other benefit of encoding HTML patches in HTML itself is that those patches can be part of a normal response, allowing out of order updates after or in between normal HTML.

