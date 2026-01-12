// utils/youtube.js
export function extractYouTubeId(raw = "") {
  try {
    const u = new URL(raw);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);

    const v = u.searchParams.get("v");
    if (v) return v;

    const embed = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
    if (embed?.[1]) return embed[1];

    const shorts = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
    if (shorts?.[1]) return shorts[1];

    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    if (/^[a-zA-Z0-9_-]{6,}$/.test(last)) return last;

    return "";
  } catch {
    // allow raw IDs passed directly
    if (/^[a-zA-Z0-9_-]{6,}$/.test(raw.trim())) return raw.trim();
    return "";
  }
}

export function toEmbedUrl(videoId) {
  return `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1`;
}
