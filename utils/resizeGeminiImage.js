// Normalise an image to Gemini's cheapest tile bucket before it goes on
// the wire. Gemini charges 258 tokens per 768-px tile; anything with both
// sides ≤ 384 px is a single tile (258 tokens). Handwriting photos from
// student phones are typically ~1500 px, which costs 4 tiles (~1 032
// tokens) per image — the resize cuts that to 258.
//
// Kept as a fail-open helper: if sharp can't decode the input (corrupt
// bytes, unusual format), we return the original inlineData rather than
// dropping the image — a slightly-more-expensive Gemini call beats no
// image at all.
import sharp from "sharp";

// Match Gemini's single-tile threshold. Values below 384 don't save any
// more tokens (still 1 tile) and just cost handwriting legibility.
const MAX_DIMENSION = 384;

export async function resizeGeminiInlineData(inline) {
  if (!inline || typeof inline.base64 !== "string" || !inline.base64) {
    return inline;
  }
  try {
    const buf = Buffer.from(inline.base64, "base64");
    const out = await sharp(buf)
      .rotate() // honour EXIF orientation before we throw away metadata
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return {
      base64: out.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (err) {
    console.warn(
      "resizeGeminiInlineData: sharp failed, sending original bytes:",
      err?.message || err
    );
    return inline;
  }
}
