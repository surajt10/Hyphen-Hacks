const STYLES = new Set(["relative0", "relative0-dark"]);

export async function GET(request: Request) {
  const key = process.env.TOMTOM_API_KEY;
  const q = new URL(request.url).searchParams;
  const [z, x, y] = ["z", "x", "y"].map((k) => Number(q.get(k)));
  const style = STYLES.has(q.get("style") ?? "") ? q.get("style")! : "relative0";
  if (!key || ![z, x, y].every(Number.isInteger) || z < 0 || z > 22) return new Response(null, { status: 204 });
  const r = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png?key=${key}&tileSize=512`, { cache: "no-store" });
  if (!r.ok) return new Response(null, { status: 204 });
  return new Response(await r.arrayBuffer(), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=120" } });
}
