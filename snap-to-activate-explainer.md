
We'd like to make it easier and more reliable for developers to build user experiences
where navigation can be done by moving parts of the UI
in a way that can correspond to scrolling and then scroll snapping.
This navigation should, in some cases, be able to change the URL,
so that the resulting state can be linked to and shared.

## Use cases

Let's start by examining some use cases that this feature should address,
and thus make it simpler for developers to address these use cases well and declaratively.

### Panels or carousel within a single page app

One use case is a set of panels or a carousel within a single page app,
where swiping left or right moves to the adjacent panel
(and typically each panel fills the entire width of the UI).
It should be possible for navigating between panels to declaratively
change the document URL (without a new document load, like `pushState`)
to reflect the currently selected panel.
In many cases there are also either buttons/tabs at the top or bottom,
or arrows at the sides,
to move between these panels.

(This use case can also integrate with patching
and thus with lazy loading of the resources
needed for each panel.
This integration can work particularly well
because a browser can start preloading content
at the beginning of a gesture
if that gesture might lead to a snap that activates and loads content.)

This use case is somewhat simpler since the activation here
is intended to be nondestructive.
(It does potentially cause resource loading,
but that's normal for exploring additional pieces of an app's UI.)

Here are two examples taken from native Android apps:

> [!NOTE]
> (INCLUDE VIDEO HERE from https://photos.app.goo.gl/9YonAy8GKg7vyQ1P6)
>
> In this case, the Android Photos app allows swiping from side to side
> to navigate between photos.
> If this were on the Web,
> it would be expected for the URL to change
> when the UI moves to a different photo.
> This allows the URL of a single photo to be shared.

> [!NOTE]
> (INCLUDE VIDEO HERE from https://photos.app.goo.gl/1ABe699gY39oiZmH9)
>
> In this case, the maps app allows similar swiping from side-to-side
> to navigate between successive trains departing from a single subway station
> in the same direction.
> The trains can also be selected by tapping on the train departure time
> at the top of the UI.
> In this particular case URLs are probably less critical
> since the information in this particular UI is extremely transient,
> but in general this sort of UI may want to have shareable URLs to represent each item.

</div>

### Pull to refresh

A slightly more advanced use case is pull-to-refresh.
This is a common UI pattern where scrolling a scrollable area
(often but not always a list)
to the top
and then continuing to scroll a little bit past the top
(where the scrolling goes slower than the user's finger
to provide the feeling of resistance or pulling)
causes the content to reload or to add new conent.
This requires having UI in the overscroll area (the area past the end)
of a scrollable container.
When activated, the UI in the overscroll area can trigger the refresh.

(This depends on a separate plan for rendering content in the overscroll area.)

In this use case,
snapping to and thus activating
an element that is in the overscroll area
would trigger the refresh.

This use case requires more care because the operation is destructive.
This means that this use case requires more careful consideration
of the implications for accessibility issues,
such as how it works with keyboard navigation,
how it integrates with assistive technology,
etc.

> [!NOTE]
> (INCLUDE VIDEO HERE from https://photos.app.goo.gl/JFuVWaXqnroUjeMH7)
>
> In this case, the Web interface of X (formerly Twitter) uses pull-to-refresh
> to load new content if any is available
> (which in this case it is not).

### Swipe actions (like swipe to dismiss/delete)

Another use case that is similar in many ways to pull-to-refresh
is swipe-to-dismiss or swipe-to-delete.
Many user interfaces with dialogs or notifications
allow dismissing that dialog or notification
by swiping it to the side.
Many user interfaces with lists of items that the user can delete
(for example, lists of messages)
allow swiping an individual item to the side to either delete an item
or remove it from the particular list that it is in (for example, to archive it).

This has many of the same concerns as pull-to-refresh:
it depends on interaction with the overscroll area,
and it is a destructive (perhaps more destructive than pull-to-refresh)
action that requires the same level care regarding accessibility issues.
(Many of the issues appear to be the same,
although some aspects may also be different.)

> [!NOTE]
> (INCLUDE VIDEO HERE from https://photos.app.goo.gl/N7D5k5WaDDCeoDQ27)
>
> In this case, the Android Gmail app uses a swipe gesture to
> remove a message from the list of messages being shown.

## Additional constraints

Some things worth thinking about when designing a solution for this are:

* An element, particularly one within a single-page app,
  may be activated in this way more than once in the lifetime of the page.
  (This implies that while integration
  with [declarative patching](patching-explainer.md) is useful,
  the integration shouldn't be so tight that a second activation is
  difficult or has poor developer ergonomics.)

* While in many cases the snapping involved will be
  `scroll-snap-type: mandatory`,
  the design should probably consider `scroll-snap-type: proximity` as well.

## Possible directions

When considering possible technical solutions to these problems,
we have to consider what goes on the HTML side and what goes on the CSS side.
Keeping appropriate parts of the solution in HTML is likely necessary
(although not sufficient) for ensuring good accessibility of the result.

### Element ID activation

One simple possibility that would address only a subset of the use cases
is adding a mechanism so that snapping to an element
navigates so that the URL's fragment is the element's ID.
This could be a very simple solution to a subset of the use cases.
It seems like it might be problematic
because there is no other way to perform the navigation,
and thus the ability to navigate to that URL
(and thus be able to share the URL, etc.)
might not be discoverable or accessible to
users using assistive technologies or alternative input methods.
It's also not clear how this could eventually be tied into
[routemaps](route-matching-explainer.md),
[declarative patching](patching-explainer.md),
or more advanced features.

### Snapping to an element that is activated

Another possibility is that the element being snapped to is an element that
can be activated, such as a link or a button.
Activating this element could then lead to
[declarative patching](patching-explainer.md) that replaces the element
(or its contents) with the expected content.

This approach seems problematic for three reasons.
First, users who need to use methods other than swiping
(for example, keyboard or assistive technology)
might be unable to discover or activate the element.
Second, it might be problematic (in a carousel type situation)
for activations other than the first,
since the declarative patching has already happened and the button or link
might now be gone.
Third, the developer ergonomics are rather weird
and probably too tied to declarative patching.

### Connecting to button or link

Another possibility that seems like it might
address a larger portion of the use cases (perhaps all, or perhaps not)
is a mechanism that indicates that snapping to an element *S*
activates a different (link or button) element *A*.
This mechanism could be a new HTML attribute
(that goes on the element *S*)
referencing the ID of another element (the element *A*).
The HTML attribute could have an IDL reflection that returns an element
(like the existing IDL attributes
`ariaActiveDescendantElement` and `popoverTargetElement`).

We've talked to developers who have taken this sort of approach
in their own site-specific code,
so it seems likely to be viable for at least some uses.

This approach may be problematic in cases where it doesn't make sense
to link to a separate element that can be activated.
However, this might be a good thing,
since that seems like a sign of a design that is likely to be inaccessible.
Further investigation is needed to determine whether
there are significant use cases
where this design wouldn't work
and where the fact that it doesn't work
isn't a sign of a significant accessibility issue.

That the element being activated would be a link or button
(which would effectively go through its normal activation process)
seems likely to mean that this approach would integrate well with
other ongoing work like
[routemaps](route-matching-explainer.md) and
[declarative patching](patching-explainer.md).

There are still some interesting accessibility questions with this approach.
In particular, given an approach where there's always an alternative way to do the same activation,
it's not clear how desirable it is to expose the snap-to-activate concepts to assistive technology.
Further, if we do want to expose them to assistive technology,
we need to figure out an appropriate way to do that
(that makes the right tradeoffs between producing good experiences
for users of assistive technology
in cases where developers do think about assistive technology users
and test with assistive technology,
and producing at least minimally acceptible experiences
in the cases where developers don't do those things
but do follow general best practices in their code).
