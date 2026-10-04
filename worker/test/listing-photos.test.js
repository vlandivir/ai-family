import assert from "node:assert/strict";
import { test } from "node:test";
import { extractListingPhotos, photoUrlsFromCard } from "../src/listing-photos.js";

test("extracts listing images without site logos or tracking pixels", () => {
  const html = '<img src="https://resizer2.4zida.rs/unsigned/logo.webp"><img src="https://resizer2.4zida.rs/photo-one.webp#3840"><img src="https://resizer2.4zida.rs/photo-two.webp#3840"><img src="https://resizer2.4zida.rs/photo-one.webp#3840">';
  assert.deepEqual(extractListingPhotos(html, "https://www.4zida.rs/prodaja-kuca/example"), [
    "https://resizer2.4zida.rs/photo-one.webp", "https://resizer2.4zida.rs/photo-two.webp",
  ]);
});

test("falls back to Open Graph image and ignores non-HTTPS URLs", () => {
  const html = '<meta content="https://images.example.com/listing.jpg?a=1&amp;b=2" property="og:image">';
  assert.deepEqual(extractListingPhotos(html, "https://example.com/listing"), ["https://images.example.com/listing.jpg?a=1&b=2"]);
  assert.deepEqual(photoUrlsFromCard({ photo_urls: ["http://example.com/unsafe", "https://images.example.com/ok.jpg"] }, "manual"), ["https://images.example.com/ok.jpg"]);
});
