import { trafficIncidents } from "@/lib/traffic";

export async function GET() {
  return Response.json(await trafficIncidents());
}
