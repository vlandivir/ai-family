function absolutePhoto(value, baseUrl) {
  try {
    const source = String(value).replace(/&amp;/gi, "&");
    const url = /^https?:\/\//i.test(source) ? new URL(source) : new URL(source, baseUrl);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function photoUrlsFromCard(card, baseUrl) {
  const values = Array.isArray(card?.photo_urls) ? card.photo_urls : [];
  return [...new Set(values.map(value => absolutePhoto(value, baseUrl)).filter(Boolean))].slice(0, 8);
}

export function extractListingPhotos(html, baseUrl) {
  const urls = [];
  const sourceHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  if (sourceHost === "4zida.rs") {
    for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
      const src = tag[0].match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
      const url = src && absolutePhoto(src, baseUrl);
      if (url && new URL(url).hostname === "resizer2.4zida.rs" && !new URL(url).pathname.startsWith("/unsigned/")) urls.push(url);
      if (urls.length >= 8) break;
    }
  }
  if (!urls.length) {
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (!/\b(?:property|name)\s*=\s*(["'])(?:og:image|twitter:image)\1/i.test(tag[0])) continue;
      const content = tag[0].match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2];
      const url = content && absolutePhoto(content, baseUrl);
      if (url) { urls.push(url); break; }
    }
  }
  return [...new Set(urls)].slice(0, 8);
}
