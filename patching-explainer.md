# Patching (Partial, interleaved HTML streaming)

## Motivation
Streaming of HTML existed from the early days of the web, serving an important purpose for perceieved performance when loading long articles etc.
However, it always had the following major constraints:
1. HTML content is streamed in DOM order.
2. After the initial parsing of the document, streaming is no longer enabled.

Use cases like updating an article without refreshing the page, or for streaming the contents of a scrollable container after it is loaded,
are accomplished today by custom JS that uses the DOM APIs, or by JS frameworks that abstract these away.

For example, React streams content out of order by injecting inline `<script>` tags that modify the already parsed DOM.

This proposal introduces partial out-of-order HTML streaming as part of the web platform.

## Patching
A "patch" is a stream of HTML content, that can be injected into an existing position in the DOM.
A patch can be streamed directly into that position using JavaScript, and multiple patches can be interleaved in an HTML document, allowing for out-of-order content as part of an ordinary HTML response.

## Anatomy of a patch

A patch is a [stream](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API) that targets a [parent node](https://developer.mozilla.org/en-US/docs/Web/API/Node) (usually an element, but potentially a shadow root).
It can handle strings, bytes, or `TrustedHTMLString`. When it receives bytes, it decodes them using UTF8.
Anything other than strings or bytes is stringified.

When a patch is active, it is essentially a [WritableStream](https://developer.mozilla.org/en-US/docs/Web/API/WritableStream) that feeds a [fragment-mode parser](https://html.spec.whatwg.org/multipage/parsing.html#html-fragment-parsing-algorithm) with strings from that stream.
Unlike the usual fragment parser, nodes are inserted directly into the target and not buffered into the fragment first. The fragment parser is only used to set up the parser context.
It is similar to calling `document.write()`, scoped to an node.

## One-off patching

The most atomic form of patching is opening a container node for writing, creating a `WritableStream` for it.
This can be done with an API as such:
```js
const writable = elementOrShadowRoot.streamHTML();
byteOrTextStream.pipeTo(writable);
```

A few details about one-off patching:
- Trying to patch an element that is currently being patched would abort the original stream.
- Replacing the contents of an existing script would only execute the script if the original contents were empty (equivalent to `innerHTML` behavior).

To account for HTML sanitation, this API would have an "Unsafe" version and would accept a sanitizer in its option, like [`setHTML`](https://developer.mozilla.org/en-US/docs/Web/API/Element/setHTML):
```js
byteOrTextStream.pipeTo(elementOrShadowRoot.streamHTML({santizer}));
byteOrTextStream.pipeTo(elementOrShadowRoot.streamHTMLUnsafe({santizer}));
```

Also see detailed discussion at https://github.com/whatwg/html/issues/11669, will amend this explainer once that's settled.

## Interleaved patching

In addition to invoking streaming using script, this proposal includes patching interleaved inside HTML content. A `<template>` would have a special attribute that
parses its content as raw text, finds the target element using attributes, and reroutes the raw text content to the target element:

```html
<section outlet=gallery>Loading...</section>

<!-- later -->
<template patchforr=gallery>Actual gallery content</template>
```

A few details about interleaved patching:
- If an outlet is not found, the patching element remains in the DOM.
- The first patch for a target in the document stream replaces its content, and the next ones append. This allows interleaved streaming into the same target.
- If the patching element is not a direct child of `<body>`, the outlet has to have a common ancestor with the patching element's parent.
- The patching element has to be in the same tree scope as the outlet.

## Reflection

Besides applying a patch, there should be a few ways to reflect about the current status of patching and receive events/callbacks when a patch is underway.

### CSS reflection
See https://github.com/w3c/csswg-drafts/issues/12579 and https://github.com/w3c/csswg-drafts/issues/12578.

Suggesting to add a couple of pseudo-classes: `:patching` and `:patch-pending`, that reflect the patching status of an element, in addition to a pseudo-class that reflects that an element's parser state is open (regardless of patching).

### JS status

Suggesting to give nodes a nullable `currentPatch` attribute that reflects the current status of a patch and allows aborting it.
In addition, suggesting to fire a `patch` event on an element when a patch on it is invoked, allowing the listener to abort the patch or inject a `TransformStream` to it.

## Sanitation & Content Security

Since patching is a new API for setting HTML, it should be designed carefully in terms of XSS and the existing mitigations.
As far as the HTML sanitizer go, it should be made sure that the different new APIs support passing a sanitizer, and that the sanitizer implementation works correctly when the parser content is streamed rather than set directly. See https://github.com/WICG/sanitizer-api/issues/190.
Note that the HTML sanitizer works closely with the HTML parser, so it shouldn't need additional buffering/streaming support as part of the API.

In addition, [Trusted types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API) would need streaming support in its policy, potentially by injecting a `TransformStream` into the patch. See https://github.com/w3c/trusted-types/issues/594.

## Enhancement - replace range instead of whole contents
Some use cases for out of order streaming require replacing parts of the element's children but not other parts, e.g. adding `<meta>` tags to the `<head>` or replacing only some `<option>`s in a `<select>`.
To achive that, the script and HTML APIs would receive an optional children range to replace, e.g. by having `patchstartafter` and `patchendbefore` attributes, and also allow similar options in the various JS APIs.

## Enhancement - JS API for interleaved patching
In addition to invoking interleaved patching as part of the main response, allow parsing an HTML stream and extracting patches from it into an existing element:
```js
const writable = documentOrElementOrShadowTree.patchInterleaved()
const writable = documentOrElementOrShadowTree.patchInterleavedUnsafe()
```

When calling `patchInterleaved`, discovered patches are applied to the target container node, and the rest of the HTML is discarded.

## Potential enhancement - patch contents from URL

In addition to patching from a stream or interleaved in HTML, there are use-cases for patching by fetching a URL.
This can be done with a `patchsrc` attribute.

Enabling remote fetching of patch content would act as a script in terms of CSP, with a CORS-only request, and would be sanitized with the same HTML/trusted-types restrictions as patching using script.

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

Yes to some extent.
Because this is a new API surface for importing HTML, this imported HTML can have
various ways to execute scripts. This is mitigated by making sure that the new API is implemented in a way that supports the sanitizer, and a new trusted-types enabler will be added for custom sanitation.
In addition, the rules of parsing this HTML are similar to the existing `setHTML` and `setHTMLUnsafe` methods, which already includes various ways of protecting against script execution, e.g. not executing a
script element that was already executed. Some of these details are discussed in https://github.com/WICG/declarative-partial-updates/issues/40.

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

This would be relevant for `patchsrc`, but is out of scope for the current questionnaire.

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

Nothing in particular.

25.  What happens when a document that uses your feature gets disconnected?

Being connected/disconnected doesn't affect this feature atm.

26.  Does your spec define when and how new kinds of errors should be raised?

It will.

28.  Does your feature allow sites to learn about the user's use of assistive technology?

No

29.  What should this questionnaire have asked?

Does this feature allow new ways of changing the DOM/injecting HTML.
