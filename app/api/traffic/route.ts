// Live traffic incidents (accidents, closures, roadworks, queues) for the map and the
// command center. TomTom data, fetched and cached server-side.
import { trafficIncidents } from "@/lib/traffic";

export async function GET() {
  return Response.json(await trafficIncidents());
}
