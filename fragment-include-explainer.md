# Fragment include

## Overview
The introduction of [patching](https://github.com/WICG/declarative-partial-updates/blob/main/patching-explainer.md) allows HTML to stream out of order declaratively.
While this opens up a lot of new options, this has a few limitations that were said to be addressed as future enhancements:

1. A patch *always* streams, and there is no declarative way to make it apply in one batch when desired.
2. A patch is interleaved within the original response, requiring the server to multiplex content from different sources.
3. A patch cannot be independently sanitized. It inherits the safety features of its embedder.

A few relevant missing features in `<template for>` are:
1. Client-side sanitization is only possible when inserting markup using script. HTML is unsafe by default, unless it is JS-inserted.
2. There is no standard way to observe latency and errors when streaming different parts of HTML

## Proposed solution

See also https://github.com/WICG/webcomponents/issues/645 and https://github.com/whatwg/html/issues/2791

Proposing that `<template for>` solves the problem of *where to put the markup*, and that the problem of *where does the markup come from* and how it is applied is somewhat separate.
Taking from the [HTML modules](https://github.com/WICG/webcomponents/issues/645) and [client side includes](https://github.com/whatwg/html/issues/2791) proposal, suggesting to do something like this:

- `<fragment src="fragment.html">` includes a fragment of HTML in place (streamed).
- `<fragment><!-- any HTML --></fragment>` can work with inline HTML as well. (this is why it's not a `<script>` element)
- A fragment is sanitized (safe mode) by default.
- A fragment can have an `unsafe` attribute. The `unsafe` attribute can be empty or have a `run-script` value that would make the patch run scripts.
- In the future when we support sanitizer presets, a `sanitizer` attribute can point to an HTML sanitization preset name.
- A fragment can have a boolean `buffered` attribute. If it is set, the fragment only applies when the parser sees its end tag, as in, it is not streamed. 
- A fragment with `type="module"` (or a boolean `module` attribute?) has module semantics, in terms of idempotency. The fragment is a `DocumentFragment` in the module tree, and can be mutated, but is cloned and appended when imported so mutations don't affect past imports.
- The above means that you can also `import fragment from "something.html" { type: "fragment" }` and it would clone a sanitized `DocumentFragment` to your JS.
- The script attributes `async` and `defer`, `nonce`, `blocking`, `crossorigin` and `referrerpolicy` work similar to the script element.
- Loading or applying a fragment creates its own performance entry, allowing observability of latency as well as errors.
- Potentially, this allows a CSP directive to allow fetching sanitized HTML fragments withour resorting to `script-src`.

## Performance

The main issue with this approach is that overuse of client-side includes can be a performance anti-pattern vs. multiplexing in the server.
However, this performance drawback is very context dependent.
In some cases, adding markup asynchronously rather than having to multiplex it in the server or passing it through JS setters can be a performance win.
Like with JS modules, bundlers are very mature and authors can make the decision of whether to bundle the markup or fetch it client-side based on their specific context, and we should look at adding this to the toolbox as an expansion of the options rather than as a footgun.

## Relative paths in fragment

This proposal deliberately *does not* deal with resolving relative paths in the fragment, which is an issue discussed extensively in https://github.com/WICG/webcomponents/issues/645.
For keeping this solution focused on the problem space of updating the DOM declaratively, the current semantics of inserting fragments to the document are maintained.
This leaves it up to the author to make sure relative paths in a fragment are modified to match the document, if desired.

A future opt-in enhancement of this can try to tackle re-basing URLs but it's a big undertaking.

## Relationship with [HTML modules](https://github.com/WICG/webcomponents/issues/645)

In some sense, this is more of a [client side include](https://github.com/whatwg/html/issues/2791) than an HTML module, because of the important fact the imported fragment is cloned and applied in place.
The "module-ness" of this is similar to text or JSON modules, where the content is in the module tree and fetched like a module, but is not mutable in a way that affects all of its importers.

## Security

As mentioned before, this proposal makes use of the sanitizer by default, and unsafe inclusion of HTML should be opted in with an "unsafe" attribute.
It is built with security thinking from the start, lending itself to declarative inclusion of sanitized HTML as easy as including images.

There are, of course, a lot of details to tackle to make this secure in practice.

