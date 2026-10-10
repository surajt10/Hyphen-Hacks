import { Accessibility, Bike, Car, Footprints, Motorbike, Scooter, type LucideIcon } from "lucide-react";
import type { Mode } from "@/lib/scoring";

export const MODE_ICON: Record<Mode, LucideIcon> = {
  walk: Footprints,
  wheelchair: Accessibility,
  bike: Bike,
  scooter: Scooter,
  moped: Motorbike,
  car: Car,
};
