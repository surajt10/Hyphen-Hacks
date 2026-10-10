export async function GET() {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, "");
  return Response.json({ url: base ? `${base}/?listen=1` : null });
}
