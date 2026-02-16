# Interleaved HTML streaming (patching)

## Motivation

Streaming of HTML existed from the early days of the web, serving an important purpose for perceived performance when loading long articles etc.
However, it always had the following major constraints:
1. HTML content is streamed in DOM order.
2. After the initial parsing of the document, streaming is no longer enabled.

Use cases like updating an article without refreshing the page, or for streaming the contents of a scrollable container after it is loaded,
are accomplished today by custom JS that uses the DOM APIs, or by JS frameworks that abstract these away.

For example, React streams content out of order by injecting inline `<script>` tags that modify the already parsed DOM.

This proposal introduces partial out-of-order HTML streaming as part of the web platform.

## Declarative patching

Patches are delivered using a `<template>` element with the `for` attribute and target an existing elements in the DOM. These patches require no scripts to apply (are declarative) and can appear in the main response HTML to support out-of-order streaming.

Patches can be be applied later in the page lifecycle using JavaScript, see [script-initiated patching](#script-initiated-patching).

### Proposed markup

Proposing to introduce processing instructions into HTML.
Those are already supported in XML and in the DOM spec, and are currently parsed as bogus comments.

All processing instructions (apart from block-listed ones like `<?xml` and `<?xml-stylesheet` would be parsed as such.
and a few special "targets" would be used towards marking: `start`, `end`, and `marker`, the latter being a "void".

Example where a placeholder is replaced with actual content:

```html
<section marker="gallery">
  <?start name="gallery">Loading...<?end name="gallery">
</section>

<template for="gallery">
  Actual gallery content
</template>
```

The marker nodes and everything between them is replaced, so the resulting DOM is:

```html
<section marker="gallery">
  Actual gallery content
</section>
```

To insert at a single point, a single `<?marker>` is used:

```html
<ul marker="list">
  <li>first item</li>
  <?marker name=list>
  <li>last item</li>
</ul>

<template for="list">
  <li>middle item</li>
</template>
```

To support multiple ranges, marker nodes can be named. The names must match one of the tokens in the `marker` attribute, and any number of ranges can be exposed:

```html
<div marker="part-one part-two">
 <?start name="part-one">
 Placeholder content
 <?end name="part-one">
 <hr>
 <?start name="part-two">
 Placeholder content
 <?end name="part-two">
</div>

<template for="part-one">
  <p>Actual 1st part of the content</p>
</template>

<template for="part-two">
  <p>Actual 2nd part of the content</p>
</template>
```

A few details about patching:

- Templates with a valid `for` attribute are not attached to the DOM, while templates that don't apply are attached to signal an error.
- If the patching element is not a direct child of `<body>`, the target element has to have a common ancestor with the patching element's parent.
- The patch template has to be in the same tree (shadow) scope as the target element.
- When the template's target is discovered, the content between the markers is removed, but the markers are left in the tree until the template is closed.
- New content is always inserted into the element with the corresponding marker attribute. If the original `<?end>` or `<?marker>` PI is still there, it is inserted before that node. Otherwise, it is appended.

### Interleaved patching

An element can be patched multiple times and patches for different elements can be interleaved. This allows for updates to different parts of the document to be interleaved. For example:

```html
<div range="product-carousel"><?start name="product-carousel">Loading...</div>
<div range="search-results"><?start name="search-results">Loading...</div>
```

In this example, the search results populate in three steps while the product carousel populates in one step in between:

```html
<template for="search-results">
  <p>first result</p>
  <!-- a new marker is added at the end for the following patch -->
  <?marker name="search-results">
</template>

<template for="product-carousel">
  Actual carousel content
</template>

<template for="search-results">
  <p>second result</p>
  <!-- a new marker is added at the end for the following patch -->
  <?marker name="search-results">
</template>

<template for="search-results">
  <p>third result</p>
  <!-- no new marker needed in the last patch (but would be harmless) -->
</template>
```

## Marker APIs

The new `<?marker>`, `<?start>`, and `<?end>` nodes would be represented with the `ProcessingInstruction` interface. That interface would receive `getAttribute`, `setAttribute` methods etc. (details TBD).

To allow scripts to use markers in the same way a declarative patching would, an `element.markerRange("list")` method is introduced, returning a `Range` object spanning the same nodes that would be replaced.

## Interaction with script-initiated patching

Streaming into an element using script is being pursued [separately](https://github.com/WICG/declarative-partial-updates/blob/main/dynamic-markup-revamped-explainer.md), but will also work with patching.
When `<template for>` appears in the streamed HTML, those patches can apply to descendants of element on which `streamAppendHTMLUnsafe()` was called.

For example:

```html
<!-- load the document shell -->
<div id=container>
  <div marker="results more">
    <?start name=results>
    Loading...
  </div>
</div>
<!-- later, as a response to navigation or a click or anything... -->
<script>
  async function update_results() {
  const writer = container.streamAppendHTMLUnsafe().getWriter();
   await writer.write(`
      <template for=result>
        <?start name=results>
        Result 1
        <?marker name=more>
      </template>
    `);
   await writer.write(`
      <template for=more>
        Result 2
        <?marker name=more>
      </template>
    `);
  }
</script>
```


## Potential enhancement

### Custom highlights integration

Named ranges created by marker nodes are similar to the named highlights created by the [custom highlights API](https://drafts.csswg.org/css-highlight-api-1/). For declarative highlights, a possible direction is named `<!start>` and `<!end>` nodes together with a CSS rule to specify the highlight priority and type.

See https://github.com/w3c/csswg-drafts/issues/13381 for discussion.

## DOM Parts integration

[DOM Parts](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/DOM-Parts.md) could make use of marker nodes to annotate ranges created by the "{{}}" syntax, so that the ranges are represented in the DOM and not just in the `<template>` and JS APIs.

### Implicit markers

To simplify the common case of replacing all children of an element without requiring a `<!start>` node, the `marker` attribute could have a microsyntax to target ranges. Example:

```html
<section range="gallery:all">
  Loading...
</section>

<template for="gallery">
  Actual gallery content
</template>
```

Appending could also be supported with another keyword:

```html
<ul range="gallery:last">
  <li>first item</li>
</ul>

<template for="gallery">
  <li>second item</li>
</template>
```

### Avoiding overwriting with identical content

Some content might need to remain unchanged in certain conditions. For example, displaying a chat widget in all pages but the home, but not reloading it between pages.
For this, both the patch and the target element can have a `contentrevision` attribute. If those match, the content is not applied.

### Patch contents from URL

In addition to patching from a stream or interleaved in HTML, there are use-cases for patching by fetching a URL.
This can be done with a `patchsrc` attribute.

Enabling remote fetching of patch content would act as a script in terms of CSP, with a CORS-only request, and would be sanitized with the same HTML/trusted-types restrictions as patching using script.

## Alternatives considered

### Marker pointers on `Element`

The main proposal treats `<!start>` and `<!end>` as two nodes, which can appear in any number and order. Error handling is done when trying to apply a `<template>` patch.

An alternative is that the parser doesn't create `Marker` nodes, but instead sets pointers `element.beforeFirstMarker` and `element.afterLastMarker`. Serializing would insert `<!start>` and `<!end>` at the appropriate places.

The chief downside of this approach is that it requires bookkeeping similar to live `Range` objects.

### `contentmethod` attribute

An earlier proposal that did not have marker nodes used a `contentmethod` attribute to control which nodes are removed and where new nodes are inserted. The `contentname` attribute was used on both `<template>` and the target element to link them.

Example:

```html
<section contentname=gallery>Loading...</section>

<template contentmethod="replace-children">
  <section contentname=gallery>Actual gallery content<section>
</template>
```

These `contentmethod` values could be supported:

- `append` inserts nodes at the end of the element, similar to `element.append(nodes)`.
- `prepend` inserts nodes at the end of the element, similar to `element.prepend(nodes)`.
- `replace-children` replaces any existing child nodes, similar to `element.replaceChildren(nodes)`.
- `replace` replaces the element itself, similar to `element.replaceWith(nodes)`.

Weaknesses of this design are:

- Doesn't support replacing arbitrary ranges of nodes, only an element or all of its children.
- In order to support patching `<title>`, which uses the [RCDATA tokenizer state](https://html.spec.whatwg.org/multipage/parsing.html#rcdata-state), the tag name of the target element must be repeated. This is because switching to the RCDATA (or RAWTEXT) state in a `<template>` element would change how the content is parsed in supporting and non-supporting parsers, which could be a security concern.
- `prepend` can fail if the original first child of the element is removed, meaning that a patch can fail mid-stream, requiring some error handling/reporting.

### Using a new node type

Instead of using processing instructions, one of the alternatives was treating it as a node type, and perhaps allowing something like `<!marker>`.
However, creating a new type can be incompatible with tools and extensions that rely on XML and HTML being roughly compatible in terms of DOM,
and this doesn't add a lot of value on top of the existing concept of `ProcessingInstruction`.

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
