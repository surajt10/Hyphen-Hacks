// The public link phones use to join the sensor grid. PUBLIC_URL is the HTTPS tunnel address
// (set when the server starts); without it, the page's own address is used.
export async function GET() {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, "");
  return Response.json({ url: base ? `${base}/?listen=1` : null });
}
