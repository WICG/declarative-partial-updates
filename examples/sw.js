self.onfetch = (e) => {
  const url = new URL(e.request.url);
  if (url.searchParams.get("page") && url.pathname === "/content") {
    e.respondWith(new Response("<template for=content><?start name=content>Page " + url.searchParams.get("page") + "</template>"));
  }
};